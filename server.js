const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static('.'));

// Chat
app.post('/api/chat', async (req, res) => {
  const { messages, accessToken } = req.body;
  let googleContext = '';

  if (accessToken) {
    try {
      const gmailRes = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const gmailData = await gmailRes.json();

      if (gmailData.messages?.length) {
        const emailDetails = await Promise.all(
          gmailData.messages.slice(0, 5).map(async (msg) => {
            const detail = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const d = await detail.json();
            const subject = d.payload?.headers?.find(h => h.name === 'Subject')?.value || 'Sans objet';
            const from = d.payload?.headers?.find(h => h.name === 'From')?.value || 'Inconnu';
            const isUnread = d.labelIds?.includes('UNREAD') ? ' [NON LU]' : '';
            return `- De: ${from} | Objet: ${subject}${isUnread}`;
          })
        );
        googleContext += `\n\nEMAILS RÉCENTS:\n${emailDetails.join('\n')}`;
      }

      const now = new Date().toISOString();
      const twoWeeksLater = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const calListRes = await fetch(
        'https://www.googleapis.com/calendar/v3/users/me/calendarList',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const calList = await calListRes.json();
      const calIds = calList.items?.map(c => c.id) || ['primary'];
      const allEvents = [];

      for (const calId of calIds.slice(0, 6)) {
        try {
          const calRes = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${now}&timeMax=${twoWeeksLater}&maxResults=20&singleEvents=true&orderBy=startTime`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const calData = await calRes.json();
          if (calData.items?.length) allEvents.push(...calData.items);
        } catch(e) {}
      }

      allEvents.sort((a, b) => new Date(a.start?.dateTime || a.start?.date) - new Date(b.start?.dateTime || b.start?.date));

      if (allEvents.length) {
        const events = allEvents.slice(0, 30).map(e => {
          const start = e.start?.dateTime || e.start?.date || '';
          const date = new Date(start).toLocaleDateString('fr-FR', {
            weekday: 'long', day: 'numeric', month: 'long',
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Brussels'
          });
          const location = e.location ? ` | Salle: ${e.location}` : '';
          return `- ${e.summary || 'Sans titre'} | ${date}${location}`;
        });
        googleContext += `\n\nAGENDA (2 prochaines semaines):\n${events.join('\n')}`;
      }
    } catch(e) {
      googleContext = '\n\n(Impossible de récupérer Gmail/Calendar)';
    }
  }


const system = `Tu es Nexus, un assistant IA personnel créé par Pierre-Antoine Lepas. Tu parles français. Sois concis et direct. Utilise **gras** pour les éléments clés. Les heures sont en fuseau Europe/Brussels (UTC+1).

ENVOI D'EMAIL : Quand l'utilisateur veut envoyer un email et te donne le destinataire, l'objet et le contenu, réponds UNIQUEMENT avec ce format exact sans rien d'autre avant ou après :
SEND_EMAIL[to:email@example.com|subject:Sujet|body:Corps du message]

Ne dis jamais que tu ne peux pas envoyer d'emails. Tu PEUX envoyer des emails via l'API Gmail.${googleContext}`;
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content || "Je n'ai pas pu traiter ta demande.";
  res.json({ content: [{ type: 'text', text: reply }] });
});
// Envoyer un email
app.post('/api/send-email', async (req, res) => {
  const { accessToken, to, subject, body } = req.body;

  const email = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body
  ].join('\n');

  const encoded = Buffer.from(email).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: encoded })
  });

  const data = await response.json();
  if (data.id) {
    res.json({ success: true, message: 'Email envoyé !' });
  } else {
    res.json({ success: false, error: data.error?.message || 'Erreur inconnue' });
  }
});
// Auth Google
app.get('/auth', (req, res) => {
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${process.env.GOOGLE_CLIENT_ID}&` +
    `redirect_uri=https://nexus-app-yzok.onrender.com/auth/callback&` +
    `response_type=code&` +
   `scope=https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar&` +
    `access_type=offline&prompt=consent`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `https://nexus-app-yzok.onrender.com/auth/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    console.log('Tokens received:', Object.keys(tokens));
    if (!tokens.access_token) {
      return res.redirect('/?error=no_token');
    }
    const refreshParam = tokens.refresh_token ? `&refresh_token=${tokens.refresh_token}` : '';
    res.redirect(`/?access_token=${tokens.access_token}${refreshParam}`);
  } catch(e) {
    console.log('Auth error:', e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.post('/api/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    return res.status(400).json({ error: 'No refresh token' });
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token,
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
  const data = await tokenRes.json();
  res.json({ access_token: data.access_token });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Nexus running on port ${PORT}`);
  // Ping toutes les 14 minutes pour éviter la veille
  setInterval(() => {
    fetch(`https://nexus-app-yzok.onrender.com/ping`)
      .then(() => console.log('Ping OK'))
      .catch(() => console.log('Ping failed'));
  }, 14 * 60 * 1000);
});
// Créer un événement
app.post('/api/create-event', async (req, res) => {
  const { accessToken, summary, start, end, location, description } = req.body;

  const event = {
    summary,
    location: location || '',
    description: description || '',
    start: {
      dateTime: start,
      timeZone: 'Europe/Brussels'
    },
    end: {
      dateTime: end,
      timeZone: 'Europe/Brussels'
    }
  };

  const response = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    }
  );

  const data = await response.json();
  if (data.id) {
    res.json({ success: true, message: `Événement créé : ${data.summary}` });
  } else {
    res.json({ success: false, error: data.error?.message || 'Erreur inconnue' });
  }
});
app.get('/ping', (req, res) => res.json({ status: 'alive' }));
