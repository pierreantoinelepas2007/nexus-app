module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { messages } = req.body;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: "Tu es Nexus, un assistant IA personnel sobre et efficace. Tu parles français. Tu as accès au Gmail et Google Calendar de l'utilisateur. Sois concis et direct. Utilise **gras** pour les éléments clés.",
        messages,
        mcp_servers: [
          { type: 'url', url: 'https://gmail.mcp.claude.com/mcp', name: 'gmail' },
          { type: 'url', url: 'https://gcal.mcp.claude.com/mcp', name: 'gcal' }
        ]
      })
    });

    const data = await response.json();
    res.status(200).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
