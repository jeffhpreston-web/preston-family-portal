const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CORS = {
  'Access-Control-Allow-Origin': 'https://clanpreston.org',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SB = (extra = {}) => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
  ...extra,
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: '' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, id } = body;
  if (!id) return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'id required' }) };

  const json = (status, data) => ({ statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  try {
    if (action === 'update') {
      // Patch application fields
      const appFields = {};
      for (const f of ['first_name', 'last_name', 'email', 'country', 'connection', 'lineage_notes']) {
        if (body[f] !== undefined) appFields[f] = body[f] || null;
      }
      if (Object.keys(appFields).length) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/registry_applications?id=eq.${id}`, {
          method: 'PATCH', headers: SB(), body: JSON.stringify(appFields),
        });
        if (!r.ok) throw new Error(`App patch failed: ${await r.text()}`);
      }

      // Upsert decision fields (registry_number, notes)
      const decFields = { application_id: id, status: 'approved', updated_at: new Date().toISOString() };
      if (body.registry_number !== undefined) decFields.registry_number = body.registry_number || null;
      if (body.notes !== undefined) decFields.notes = body.notes || null;

      const r2 = await fetch(`${SUPABASE_URL}/rest/v1/registry_decisions?on_conflict=application_id`, {
        method: 'POST',
        headers: SB({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(decFields),
      });
      if (!r2.ok) throw new Error(`Decision upsert failed: ${await r2.text()}`);

      return json(200, { ok: true });
    }

    if (action === 'remove') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/registry_decisions?application_id=eq.${id}`, {
        method: 'PATCH', headers: SB(), body: JSON.stringify({ status: 'removed', updated_at: new Date().toISOString() }),
      });
      if (!r.ok) throw new Error(`Remove failed: ${await r.text()}`);
      return json(200, { ok: true });
    }

    if (action === 'auto_number') {
      // Find highest existing CPR-### to assign next
      const r = await fetch(`${SUPABASE_URL}/rest/v1/registry_decisions?select=registry_number&registry_number=like.CPR-*`, {
        headers: SB(),
      });
      const rows = await r.json();
      let maxNum = 0;
      for (const row of rows) {
        if (row.registry_number) {
          const n = parseInt(row.registry_number.replace(/^CPR-/, ''), 10);
          if (!isNaN(n) && n > maxNum) maxNum = n;
        }
      }
      const registry_number = `CPR-${String(maxNum + 1).padStart(3, '0')}`;

      const r2 = await fetch(`${SUPABASE_URL}/rest/v1/registry_decisions?on_conflict=application_id`, {
        method: 'POST',
        headers: SB({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ application_id: id, registry_number, status: 'approved', updated_at: new Date().toISOString() }),
      });
      if (!r2.ok) throw new Error(`Auto-number failed: ${await r2.text()}`);
      return json(200, { ok: true, registry_number });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('registry-member-update error:', err);
    return json(500, { error: err.message });
  }
};
