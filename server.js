const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.json({limit: '10mb'}));
app.use(express.static('.'));

function decodeHeader(str) {
  if (!str) return '';
  return str.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf-8');
      } else {
        return text.replace(/_/g, ' ').replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
    } catch(e) {
      return str;
    }
  });
}

app.post('/api/chat', async (req, res) => {
  const { messages, accessToken } = req.body;
  let googleContext = '';
  let memoryContext = '';

  try {
    if (fs.existsSync('./memory.json')) {
      const memory = JSON.parse(fs.readFileSync('./memory.json', 'utf-8'));
      if (Object.keys(memory).length > 0) {
        memoryContext = '\n\nMEMOIRE UTILISATEUR:\n' + JSON.stringify(memory, null, 2);
      }
    }
  } catch(e) {}

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
            const subject = decodeHeader(d.payload && d.payload.headers && d.payload.headers.find(h => h.name === 'Subject') && d.payload.headers.find(h => h.name === 'Subject').value) || 'Sans objet';
            const from = decodeHeader(d.payload && d.payload.headers && d.payload.headers.find(h => h.name === 'From') && d.payload.headers.find(h => h.name === 'From').value) || 'Inconnu';
            const isUnread = d.labelIds && d.labelIds.includes('UNREAD') ? ' [NON LU]' : '';
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
          if (calData.items && calData.items.length) allEvents.push(...calData.items);
        } catch(e) {}
      }

      allEvents.sort((a, b) => new Date(a.start && (a.start.dateTime || a.start.date)) - new Date(b.start && (b.start.dateTime || b.start.date)));

      if (allEvents.length) {
        const events = allEvents.slice(0, 30).map(e => {
          const start = (e.start && (e.start.dateTime || e.start.date)) || '';
          const date = new Date(start).toLocaleDateString('fr-FR', {
            weekday: 'long', day: 'numeric', month: 'long',
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Brussels'
          });
          const location = e.location ? ' | Salle: ' + e.location : '';
          return '- ' + (e.summary || 'Sans titre') + ' | ' + date + location + ' | ID:' + e.id;
        });
        googleContext += '\n\nAGENDA (2 prochaines semaines):\n' + events.join('\n');
      }

    } catch(e) {
      console.log('Google API error:', e.message);
      googleContext = '\n\n(Impossible de recuperer Gmail/Calendar)';
    }
  }

  const system = 'Tu es Nexus, un assistant IA personnel cree par Pierre-Antoine Lepas. Tu parles francais. Sois concis et direct. Utilise **gras** pour les elements cles. Les heures sont en fuseau Europe/Brussels (UTC+1).\n\nENVOI D EMAIL : Quand l utilisateur veut envoyer un email, ajoute a la fin :\nSEND_EMAIL[to:email@example.com|subject:Sujet|body:Corps]\n\nCREATION D EVENEMENT : Quand l utilisateur veut creer un evenement, ajoute a la fin :\nCREATE_EVENT[summary:Titre|start:2026-03-21T14:00:00|end:2026-03-21T15:00:00|location:Lieu]\n\nREPONSE EMAIL : Quand l utilisateur veut repondre a un email, ajoute a la fin :\nREPLY_EMAIL[to:email@example.com|subject:Sujet|body:Corps|threadId:id]\n\nSUPPRESSION EVENEMENT : Quand l utilisateur veut supprimer un evenement, ajoute a la fin :\nDELETE_EVENT[eventId:id|summary:Nom]\n\nMEMOIRE : Quand tu apprends quelque chose important sur l utilisateur, ajoute a la fin :\nSAVE_MEMORY[key:valeur|key2:valeur2]\n\nSi on te demande qui t a cree, reponds que tu as ete cree par Pierre-Antoine Lepas.' + googleContext + memoryContext;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: system,
        messages: messages
      })
    });

    const data = await response.json();
    console.log('Claude response:', JSON.stringify(data).slice(0, 200));
    const reply = (data.content && data.content[0] && data.content[0].text) || "Je n'ai pas pu traiter ta demande.";
    res.json({ content: [{ type: 'text', text: reply }] });
  } catch(e) {
    console.log('Claude error:', e.message);
    res.json({ content: [{ type: 'text', text: "Erreur de connexion." }] });
  }
});

app.get('/auth', (req, res) => {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
    'client_id=' + process.env.GOOGLE_CLIENT_ID +
    '&redirect_uri=https://nexus-app-yzok.onrender.com/auth/callback' +
    '&response_type=code' +
    '&scope=https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar' +
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
        code: code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: 'https://nexus-app-yzok.onrender.com/auth/callback',
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    console.log('Tokens received:', Object.keys(tokens));
    if (!tokens.access_token) return res.redirect('/?error=no_token');
    const refreshParam = tokens.refresh_token ? '&refresh_token=' + tokens.refresh_token : '';
    res.redirect('/?access_token=' + tokens.access_token + refreshParam);
  } catch(e) {
    console.log('Auth error:', e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/api/refresh', async (req, res) => {
  const refresh_token = req.body.refresh_token;
  if (!refresh_token) return res.status(400).json({ error: 'No refresh token' });
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refresh_token,
        grant_type: 'refresh_token'
      })
    });
    const data = await tokenRes.json();
    console.log('Refresh result:', data.access_token ? 'success' : data.error);
    res.json({ access_token: data.access_token, error: data.error });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send-email', async (req, res) => {
  const accessToken = req.body.accessToken;
  const to = req.body.to;
  const subject = req.body.subject;
  const body = req.body.body;
  const email = 'To: ' + to + '\nSubject: ' + subject + '\nContent-Type: text/plain; charset=utf-8\n\n' + body;
  const encoded = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded })
  });
  const data = await response.json();
  if (data.id) {
    res.json({ success: true });
  } else {
    res.json({ success: false, error: (data.error && data.error.message) || 'Erreur inconnue' });
  }
});

app.post('/api/reply-email', async (req, res) => {
  const accessToken = req.body.accessToken;
  const to = req.body.to;
  const subject = req.body.subject;
  const body = req.body.body;
  const threadId = req.body.threadId;
  const email = 'To: ' + to + '\nSubject: Re: ' + subject + '\nContent-Type: text/plain; charset=utf-8\n\n' + body;
  const encoded = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded, threadId: threadId })
  });
  const data = await response.json();
  res.json({ success: !!data.id, error: (!data.id && data.error && data.error.message) || null });
});

app.post('/api/create-event', async (req, res) => {
  const accessToken = req.body.accessToken;
  const event = {
    summary: req.body.summary,
    location: req.body.location || '',
    description: req.body.description || '',
    start: { dateTime: req.body.start, timeZone: 'Europe/Brussels' },
    end: { dateTime: req.body.end, timeZone: 'Europe/Brussels' }
  };
  const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
  const data = await response.json();
  res.json({ success: !!data.id, error: (!data.id && data.error && data.error.message) || null });
});

app.post('/api/delete-event', async (req, res) => {
  const accessToken = req.body.accessToken;
  const eventId = req.body.eventId;
  const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/' + eventId, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (response.status === 204) {
    res.json({ success: true });
  } else {
    const data = await response.json();
    res.json({ success: false, error: (data.error && data.error.message) || 'Erreur inconnue' });
  }
});

app.post('/api/search-emails', async (req, res) => {
  const accessToken = req.body.accessToken;
  const query = req.body.query;
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=' + encodeURIComponent(query), {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  const data = await response.json();
  if (!data.messages || !data.messages.length) return res.json({ emails: [] });
  const emails = await Promise.all(data.messages.slice(0, 5).map(async (msg) => {
    const detail = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + msg.id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    const d = await detail.json();
    const subject = decodeHeader((d.payload && d.payload.headers && d.payload.headers.find(h => h.name === 'Subject') && d.payload.headers.find(h => h.name === 'Subject').value) || '') || 'Sans objet';
    const from = decodeHeader((d.payload && d.payload.headers && d.payload.headers.find(h => h.name === 'From') && d.payload.headers.find(h => h.name === 'From').value) || '') || 'Inconnu';
    const isUnread = d.labelIds && d.labelIds.includes('UNREAD') ? ' [NON LU]' : '';
    return '- De: ' + from + ' | Objet: ' + subject + isUnread + ' | ID: ' + msg.id;
  }));
  res.json({ emails });
});

app.get('/api/memory', (req, res) => {
  try {
    if (fs.existsSync('./memory.json')) {
      const memory = JSON.parse(fs.readFileSync('./memory.json', 'utf-8'));
      res.json({ memory });
    } else {
      res.json({ memory: {} });
    }
  } catch(e) {
    res.json({ memory: {} });
  }
});

app.post('/api/memory', (req, res) => {
  try {
    const existing = fs.existsSync('./memory.json') ? JSON.parse(fs.readFileSync('./memory.json', 'utf-8')) : {};
    const updated = Object.assign({}, existing, req.body);
    fs.writeFileSync('./memory.json', JSON.stringify(updated, null, 2));
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/ping', (req, res) => res.json({ status: 'alive' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Nexus running on port ' + PORT);
  setInterval(() => {
    fetch('https://nexus-app-yzok.onrender.com/ping')
      .then(() => console.log('Ping OK'))
      .catch(() => console.log('Ping failed'));
  }, 14 * 60 * 1000);
});
