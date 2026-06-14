const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SB = (extra = {}) => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
  ...extra,
});

const STAT_KEYS = ['registry_member_count', 'registry_countries_count'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const json = (status, data) => ({ statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  try {
    if (event.httpMethod === 'GET') {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/site_settings?key=in.(${STAT_KEYS.join(',')})&select=key,value`,
        { headers: SB() }
      );
      if (!r.ok) throw new Error(`Supabase error ${r.status}: ${await r.text()}`);
      const rows = await r.json();
      const stats = {};
      for (const row of rows) stats[row.key] = row.value;
      return json(200, stats);
    }

    if (event.httpMethod === 'POST') {
      const { member_count, countries_count } = JSON.parse(event.body || '{}');
      const rows = [];
      if (member_count !== undefined) rows.push({ key: 'registry_member_count', value: String(member_count) });
      if (countries_count !== undefined) rows.push({ key: 'registry_countries_count', value: String(countries_count) });
      if (!rows.length) return json(400, { error: 'No fields provided' });

      const r = await fetch(`${SUPABASE_URL}/rest/v1/site_settings?on_conflict=key`, {
        method: 'POST',
        headers: SB({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows),
      });
      if (!r.ok) throw new Error(`Supabase error ${r.status}: ${await r.text()}`);
      return json(200, { ok: true });
    }

    return { statusCode: 405, headers: CORS, body: '' };
  } catch (err) {
    console.error('registry-stats error:', err);
    return json(500, { error: err.message });
  }
};
