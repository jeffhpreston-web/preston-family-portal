const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORTAL_SECRET = process.env.PORTAL_SECRET;

const CORS = {
  'Access-Control-Allow-Origin': 'https://clanpreston.org',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-portal-secret',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  if (event.headers['x-portal-secret'] !== PORTAL_SECRET) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { application_id, status, notes, registry_number } = body;
  if (!application_id) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'application_id is required' }),
    };
  }

  const VALID_STATUSES = ['new', 'review', 'approved', 'denied'];
  if (status && !VALID_STATUSES.includes(status)) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }),
    };
  }

  try {
    const decisionRow = {
      application_id,
      ...(status !== undefined && { status }),
      ...(notes !== undefined && { notes }),
      ...(registry_number !== undefined && { registry_number }),
      updated_at: new Date().toISOString(),
    };

    const upsertResp = await fetch(
      `${SUPABASE_URL}/rest/v1/registry_decisions?on_conflict=application_id`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(decisionRow),
      }
    );

    if (!upsertResp.ok) {
      throw new Error(`Supabase error ${upsertResp.status}: ${await upsertResp.text()}`);
    }

    const [updated] = await upsertResp.json();
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: updated }),
    };
  } catch (err) {
    console.error('registry-update error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
