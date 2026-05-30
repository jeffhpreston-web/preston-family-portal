const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORTAL_SECRET = process.env.PORTAL_SECRET;
const FORMSPREE_KEY = process.env.FORMSPREE_MASTER_KEY;

const CORS = {
  'Access-Control-Allow-Origin': 'https://clanpreston.org',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-portal-secret',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.headers['x-portal-secret'] !== PORTAL_SECRET) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  try {
    // Fetch submissions from Formspree
    const fsResp = await fetch(
      'https://formspree.io/api/0/forms/mdajkzkk/submissions?page_size=100',
      { headers: { Authorization: `Bearer ${FORMSPREE_KEY}`, Accept: 'application/json' } }
    );
    if (!fsResp.ok) {
      throw new Error(`Formspree error ${fsResp.status}: ${await fsResp.text()}`);
    }
    const fsData = await fsResp.json();
    const submissions = fsData.submissions || [];

    // Map Formspree fields → registry_applications columns
    const rows = submissions.map((s) => {
      // Derive a stable unique ID — try native fields first, then hash email+date
      const nativeId = s.id || s._id || s.uid || s.submission_id;
      const fallbackId = nativeId || Buffer.from(
        (s.email || s.Email || '') + '|' + (s._date || s.date || s.Date || '')
      ).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 40);
      return {
      formspree_id: fallbackId,
      first_name: s.first_name || s['First Name'] || null,
      last_name: s.last_name || s['Last Name'] || null,
      email: s.email || s.Email || null,
      country: s.country || s.Country || null,
      connection: s.connection || s.Connection || null,
      lineage_notes: s.lineage_notes || s['Lineage Notes'] || null,
      newsletter:
        s.newsletter === true ||
        s.newsletter === 'true' ||
        s.newsletter === 'yes' ||
        s.Newsletter === 'true' ||
        false,
      submitted_at: s._date || s.date || s.Date || null,
      };
    });

    if (rows.length > 0) {
      // Upsert applications
      const upsertResp = await fetch(
        `${SUPABASE_URL}/rest/v1/registry_applications`,
        {
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(rows),
        }
      );
      if (!upsertResp.ok) {
        throw new Error(`Supabase upsert error ${upsertResp.status}: ${await upsertResp.text()}`);
      }
    }

    // Return all applications joined with decisions
    const selectResp = await fetch(
      `${SUPABASE_URL}/rest/v1/registry_applications?select=*,registry_decisions(*)&order=submitted_at.desc.nullslast`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Accept: 'application/json',
        },
      }
    );
    if (!selectResp.ok) {
      throw new Error(`Supabase select error ${selectResp.status}: ${await selectResp.text()}`);
    }
    const applications = await selectResp.json();

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ applications, synced: rows.length }),
    };
  } catch (err) {
    console.error('registry-sync error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
