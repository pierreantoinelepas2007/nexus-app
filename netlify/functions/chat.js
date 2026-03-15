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

    // Récupérer tous les agendas
      const now = new Date().toISOString();
      const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const calListRes = await fetch(
        'https://www.googleapis.com/calendar/v3/users/me/calendarList',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const calList = await calListRes.json();
      const calIds = calList.items?.map(c => c.id) || ['primary'];

      const allEvents = [];
      for (const calId of calIds.slice(0, 5)) {
        const calRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${now}&timeMax=${weekLater}&maxResults=5&singleEvents=true&orderBy=startTime`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const calData = await calRes.json();
        if (calData.items?.length) allEvents.push(...calData.items);
      }

      if (allEvents.length) {
        const events = allEvents.map(e => {
          const start = e.start?.dateTime || e.start?.date || '';
          const date = new Date(start).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
          const location = e.location || '';
const desc = e.description ? e.description.slice(0, 100) : '';
return `- ${e.summary || 'Sans titre'} | ${date}${location ? ' | Salle: ' + location : ''}${desc ? ' | ' + desc : ''}`;
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
