const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CORS = {
  'Access-Control-Allow-Origin': 'https://clanpreston.org',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/registry_applications?select=id,first_name,last_name,email,country,connection,lineage_notes,registry_decisions!inner(status,registry_number,notes)&registry_decisions.status=eq.approved&order=submitted_at.asc`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Accept: 'application/json',
        },
      }
    );

    if (!resp.ok) {
      throw new Error(`Supabase error ${resp.status}: ${await resp.text()}`);
    }

    const members = await resp.json();

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ members }),
    };
  } catch (err) {
    console.error('registry-members error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
