exports.handler = async function(event) {
  const { code } = event.queryStringParameters || {};
  
  if (!code) {
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${process.env.GOOGLE_CLIENT_ID}&` +
      `redirect_uri=${process.env.SITE_URL}/auth/callback&` +
      `response_type=code&` +
      `scope=https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly&` +
      `access_type=offline`;
    
    return {
      statusCode: 302,
      headers: { Location: authUrl }
    };
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${process.env.SITE_URL}/auth/callback`,
      grant_type: 'authorization_code'
    })
  });

  const tokens = await tokenRes.json();
  
  return {
    statusCode: 302,
    headers: {
      Location: `/?access_token=${tokens.access_token}&refresh_token=${tokens.refresh_token}`
    }
  };
};
