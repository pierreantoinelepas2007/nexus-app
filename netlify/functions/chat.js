exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { messages, accessToken } = JSON.parse(event.body);

  let googleContext = '';

  if (accessToken) {
    try {
      // Récupérer les emails récents
      const gmailRes = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const gmailData = await gmailRes.json();
console.log('Gmail response:', JSON.stringify(gmailData).slice(0, 200));
      if (gmailData.messages?.length) {
        const emailDetails = await Promise.all(
          gmailData.messages.slice(0, 3).map(async (msg) => {
            const detail = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const d = await detail.json();
            const subject = d.payload?.headers?.find(h => h.name === 'Subject')?.value || 'Sans objet';
            const from = d.payload?.headers?.find(h => h.name === 'From')?.value || 'Inconnu';
            return `- De: ${from} | Objet: ${subject}`;
          })
        );
        googleContext += `\n\nEMAILS NON LUS RÉCENTS:\n${emailDetails.join('\n')}`;
      } else {
        googleContext += '\n\nEMAILS: Aucun email non lu.';
      }

      // Récupérer les événements du calendrier
      const now = new Date().toISOString();
      const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&timeMax=${weekLater}&maxResults=5&singleEvents=true&orderBy=startTime`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const calData = await calRes.json();
console.log('Calendar response:', JSON.stringify(calData).slice(0, 300));
      if (calData.items?.length) {
        const events = calData.items.map(e => {
          const start = e.start?.dateTime || e.start?.date || '';
          const date = new Date(start).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
          return `- ${e.summary || 'Sans titre'} | ${date}`;
        });
        googleContext += `\n\nAGENDA (7 prochains jours):\n${events.join('\n')}`;
      } else {
        googleContext += '\n\nAGENDA: Aucun événement cette semaine.';
      }

    } catch(e) {
      googleContext = '\n\n(Impossible de récupérer Gmail/Calendar)';
    }
  }

  const system = `Tu es Nexus, un assistant IA personnel sobre et efficace. Tu parles français. Sois concis et direct. Utilise **gras** pour les éléments clés.${googleContext}`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: system },
        ...messages
      ]
    })
  });

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content || "Je n'ai pas pu traiter ta demande.";

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: [{ type: 'text', text: reply }] })
  };
};
