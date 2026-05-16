exports.handler = async (event) => {
  const certNumber = event.queryStringParameters?.cert;
  if (!certNumber) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing cert number' })
    };
  }

  const token = process.env.PSA_API_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'PSA API token not configured' })
    };
  }

  try {
    const resp = await fetch(
      `https://api.psacard.com/publicapi/cert/GetByCertNumber/${certNumber}`,
      {
        headers: {
          'Authorization': `bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const data = await resp.json();
    return {
      statusCode: resp.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
