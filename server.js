const express = require('express');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');
const app = express();

app.use(express.json({limit: '10mb'}));
app.use(express.static('.'));

// MongoDB connection
let db;
async function connectDB() {
  try {
    console.log('MongoDB URI:', process.env.MONGODB_URI ? 'définie' : 'MANQUANTE');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db('nexus');
    console.log('MongoDB connected');
  } catch(e) {
    console.log('MongoDB error:', e.message);
  }
}

function decodeHeader(str) {
  if (!str) return '';
  return str.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf-8');
      return text.replace(/_/g, ' ').replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    } catch(e) { return str; }
  });
}

async function getUserMemory(userId) {
  if (!db) return {};
  try {
    const user = await db.collection('users').findOne({ userId });
    return (user && user.memory) || {};
  } catch(e) { return {}; }
}

async function saveUserMemory(userId, data) {
  if (!db) return;
  try {
    await db.collection('users').updateOne(
      { userId },
      { $set: { memory: data, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch(e) { console.log('Memory save error:', e.message); }
}

// ─── OLLAMA API CALL ───────────────────────────────────────────────────────────
async function callAI(system, messages) {
  // Ollama local (si OLLAMA_URL défini ou en local)
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'llama3.2:1b';

  try {
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          ...messages.map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: Array.isArray(m.content)
              ? m.content.find(c => c.type === 'text')?.text || ''
              : m.content
          }))
        ]
      }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await response.json();
    return data.message?.content || "Je n'ai pas pu traiter ta demande.";
  } catch(e) {
    console.log('Ollama error:', e.message);
    // Fallback Groq si Ollama pas dispo
    if (process.env.GROQ_API_KEY) {
      console.log('Fallback to Groq...');
      return await callGroq(system, messages);
    }
    throw e;
  }
}

async function callGroq(system, messages) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: system },
        ...messages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: Array.isArray(m.content)
            ? m.content.find(c => c.type === 'text')?.text || ''
            : m.content
        }))
      ]
    })
  });
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "Je n'ai pas pu traiter ta demande.";
}
// ──────────────────────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { messages, accessToken, userId } = req.body;
  let googleContext = '';
  let memoryContext = '';

  // Memory
  if (userId && db) {
    const memory = await getUserMemory(userId);
    if (Object.keys(memory).length > 0)
      memoryContext = '\n\nMEMOIRE UTILISATEUR:\n' + JSON.stringify(memory, null, 2);
  } else {
    try {
      if (fs.existsSync('./memory.json')) {
        const memory = JSON.parse(fs.readFileSync('./memory.json', 'utf-8'));
        if (Object.keys(memory).length > 0)
          memoryContext = '\n\nMEMOIRE UTILISATEUR:\n' + JSON.stringify(memory, null, 2);
      }
    } catch(e) {}
  }

  // Google context
  if (accessToken) {
    try {
      const gmailRes = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5',
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );
      const gmailData = await gmailRes.json();
      if (gmailData.messages && gmailData.messages.length) {
        const emailDetails = await Promise.all(
          gmailData.messages.slice(0, 5).map(async (msg) => {
            const detail = await fetch(
              'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + msg.id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From',
              { headers: { Authorization: 'Bearer ' + accessToken } }
            );
            const d = await detail.json();
            const subject = decodeHeader(d.payload?.headers?.find(h => h.name === 'Subject')?.value || '') || 'Sans objet';
            const from = decodeHeader(d.payload?.headers?.find(h => h.name === 'From')?.value || '') || 'Inconnu';
            const isUnread = d.labelIds?.includes('UNREAD') ? ' [NON LU]' : '';
            return '- De: ' + from + ' | Objet: ' + subject + isUnread;
          })
        );
        googleContext += '\n\nEMAILS RECENTS:\n' + emailDetails.join('\n');
      }

      const now = new Date().toISOString();
      const twoWeeksLater = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const calListRes = await fetch(
        'https://www.googleapis.com/calendar/v3/users/me/calendarList',
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );
      const calList = await calListRes.json();
      const calIds = (calList.items && calList.items.map(c => c.id)) || ['primary'];
      const allEvents = [];
      for (const calId of calIds.slice(0, 6)) {
        try {
          const calRes = await fetch(
            'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calId) + '/events?timeMin=' + now + '&timeMax=' + twoWeeksLater + '&maxResults=20&singleEvents=true&orderBy=startTime',
            { headers: { Authorization: 'Bearer ' + accessToken } }
          );
          const calData = await calRes.json();
          if (calData.items) allEvents.push(...calData.items);
        } catch(e) {}
      }
      allEvents.sort((a, b) => new Date((a.start?.dateTime || a.start?.date) || 0) - new Date((b.start?.dateTime || b.start?.date) || 0));
      if (allEvents.length) {
        const events = allEvents.slice(0, 20).map(e => {
          const start = e.start?.dateTime || e.start?.date || '';
          const date = new Date(start).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Brussels' });
          return '- ' + (e.summary || 'Sans titre') + ' | ' + date + (e.location ? ' | ' + e.location : '') + ' | ID:' + e.id;
        });
        googleContext += '\n\nAGENDA (2 prochaines semaines):\n' + events.join('\n');
      }
    } catch(e) {
      console.log('Google API error:', e.message);
    }
  }

  const system = `Tu es Nexus, un assistant IA personnel cree par Pierre-Antoine Lepas. Tu parles francais. Sois concis et direct. Utilise **gras** pour les elements cles. Les heures sont en fuseau Europe/Brussels (UTC+1).

ENVOI D EMAIL : Quand l utilisateur veut envoyer un email, ajoute a la fin :
SEND_EMAIL[to:email@example.com|subject:Sujet|body:Corps]

CREATION D EVENEMENT : Quand l utilisateur veut creer un evenement, ajoute a la fin :
CREATE_EVENT[summary:Titre|start:2026-03-21T14:00:00|end:2026-03-21T15:00:00|location:Lieu]

REPONSE EMAIL : Quand l utilisateur veut repondre a un email, ajoute a la fin :
REPLY_EMAIL[to:email@example.com|subject:Sujet|body:Corps|threadId:id]

SUPPRESSION EVENEMENT : Quand l utilisateur veut supprimer un evenement, ajoute a la fin :
DELETE_EVENT[eventId:id|summary:Nom]

MEMOIRE : Quand tu apprends quelque chose important sur l utilisateur, ajoute a la fin :
SAVE_MEMORY[key:valeur|key2:valeur2]

Si on te demande qui t a cree, reponds que tu as ete cree par Pierre-Antoine Lepas.${googleContext}${memoryContext}`;

  // Limite l'historique aux 10 derniers messages
  const recentMessages = messages.slice(-10);

  try {
    const reply = await callAI(system, recentMessages);
    console.log('AI reply:', reply.slice(0, 100));

    // Save memory
    const memoryMatch = reply.match(/SAVE_MEMORY\[(.*?)\]/s);
    if (memoryMatch && userId) {
      const pairs = memoryMatch[1].split('|');
      const newMemory = {};
      pairs.forEach(p => { const idx = p.indexOf(':'); if (idx > -1) newMemory[p.slice(0,idx).trim()] = p.slice(idx+1).trim(); });
      const existing = await getUserMemory(userId);
      await saveUserMemory(userId, Object.assign({}, existing, newMemory));
    }

    res.json({ content: [{ type: 'text', text: reply }] });
  } catch(e) {
    console.log('AI error:', e.message);
    res.json({ content: [{ type: 'text', text: "Erreur de connexion a l'IA. Verifie qu'Ollama tourne sur ton PC." }] });
  }
});

app.get('/auth', (req, res) => {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
    'client_id=' + process.env.GOOGLE_CLIENT_ID +
    '&redirect_uri=https://nexus-app-yzok.onrender.com/auth/callback' +
    '&response_type=code' +
    '&scope=https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email' +
    '&access_type=offline&prompt=consent';
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code, client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: 'https://nexus-app-yzok.onrender.com/auth/callback',
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.redirect('/?error=no_token');
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    const userInfo = await userRes.json();
    const userId = userInfo.email || 'anonymous';
    if (db) {
      await db.collection('users').updateOne(
        { userId },
        { $set: { userId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, updatedAt: new Date() } },
        { upsert: true }
      );
    }
    const refreshParam = tokens.refresh_token ? '&refresh_token=' + tokens.refresh_token : '';
    res.redirect('/?access_token=' + tokens.access_token + refreshParam + '&user_id=' + encodeURIComponent(userId));
  } catch(e) {
    console.log('Auth error:', e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/api/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'No refresh token' });
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token, grant_type: 'refresh_token' })
    });
    const data = await tokenRes.json();
    res.json({ access_token: data.access_token, error: data.error });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send-email', async (req, res) => {
  const { accessToken, to, subject, body } = req.body;
  const email = 'To: ' + to + '\nSubject: ' + subject + '\nContent-Type: text/plain; charset=utf-8\n\n' + body;
  const encoded = Buffer.from(email).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded })
  });
  const data = await response.json();
  res.json({ success: !!data.id, error: (!data.id && data.error?.message) || null });
});

app.post('/api/reply-email', async (req, res) => {
  const { accessToken, to, subject, body, threadId } = req.body;
  const email = 'To: ' + to + '\nSubject: Re: ' + subject + '\nContent-Type: text/plain; charset=utf-8\n\n' + body;
  const encoded = Buffer.from(email).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded, threadId })
  });
  const data = await response.json();
  res.json({ success: !!data.id, error: (!data.id && data.error?.message) || null });
});

app.post('/api/create-event', async (req, res) => {
  const { accessToken, summary, location, description, start, end } = req.body;
  const event = { summary, location: location || '', description: description || '', start: { dateTime: start, timeZone: 'Europe/Brussels' }, end: { dateTime: end, timeZone: 'Europe/Brussels' } };
  const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
  const data = await response.json();
  res.json({ success: !!data.id, error: (!data.id && data.error?.message) || null });
});

app.post('/api/delete-event', async (req, res) => {
  const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/' + req.body.eventId, {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + req.body.accessToken }
  });
  if (response.status === 204) { res.json({ success: true }); }
  else { const data = await response.json(); res.json({ success: false, error: data.error?.message || 'Erreur inconnue' }); }
});

app.get('/api/memory', async (req, res) => {
  const { userId } = req.query;
  if (userId && db) { res.json({ memory: await getUserMemory(userId) }); }
  else {
    try { res.json({ memory: fs.existsSync('./memory.json') ? JSON.parse(fs.readFileSync('./memory.json', 'utf-8')) : {} }); }
    catch(e) { res.json({ memory: {} }); }
  }
});

app.post('/api/memory', async (req, res) => {
  const { userId, ...data } = req.body;
  if (userId && db) {
    const existing = await getUserMemory(userId);
    await saveUserMemory(userId, Object.assign({}, existing, data));
    res.json({ success: true });
  } else {
    try {
      const existing = fs.existsSync('./memory.json') ? JSON.parse(fs.readFileSync('./memory.json', 'utf-8')) : {};
      fs.writeFileSync('./memory.json', JSON.stringify(Object.assign({}, existing, data), null, 2));
      res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
  }
});

app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/nexus_icon.png', (req, res) => res.sendFile(path.join(__dirname, 'nexus_icon.png')));
app.get('/ping', (req, res) => res.json({ status: 'alive' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log('Nexus running on port ' + PORT);
    console.log('AI mode:', process.env.OLLAMA_URL ? 'Ollama @ ' + process.env.OLLAMA_URL : process.env.GROQ_API_KEY ? 'Groq' : 'Ollama local');
    setInterval(() => {
      fetch('https://nexus-app-yzok.onrender.com/ping').then(() => console.log('Ping OK')).catch(() => {});
    }, 14 * 60 * 1000);
  });
});
