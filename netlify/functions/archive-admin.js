// POST /api/archive-admin  — admin-only write API for the archive.
//   Auth: Supabase Auth JWT of an 'admin' profile (Authorization: Bearer ...).
//   Body: { action, ...payload }
//
// Actions:
//   item.upsert   { item: {...} }            -> insert/update an archive_item
//   item.delete   { id }
//   photo.add     { item_id, storage_path, caption?, is_primary?, ... }
//   photo.remove  { id }
//   photo.primary { id }                     -> mark one photo primary
//   provenance.add| valuation.add | cert.add | extref.upsert  { item_id, ... }
//
// All writes go through the service-role key AFTER admin identity is verified,
// so they operate above RLS but only for a proven archivist.

const { SUPABASE_URL, json, preflight, requireAdmin, sbHeaders } = require('./_lib/auth');

const REST = (path, opts) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);

async function upsert(table, row, onConflict) {
  const q = onConflict ? `${table}?on_conflict=${onConflict}` : table;
  const r = await REST(q, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`${table} upsert ${r.status}: ${await r.text()}`);
  const [out] = await r.json();
  return out;
}

async function patch(table, id, row) {
  const r = await REST(`${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`${table} patch ${r.status}: ${await r.text()}`);
  const [out] = await r.json();
  return out;
}

async function del(table, id) {
  const r = await REST(`${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
  });
  if (!r.ok) throw new Error(`${table} delete ${r.status}: ${await r.text()}`);
}

const ITEM_FIELDS = [
  'accession_no', 'title', 'category_id', 'subcategory', 'short_desc', 'description',
  'maker', 'origin_country', 'date_text', 'year_from', 'year_to', 'medium', 'dimensions',
  'weight', 'condition', 'edition_info', 'held_by', 'generation', 'current_location', 'tags', 'is_public',
  'is_featured', 'status', 'display_order', 'acquisition_price', 'acquisition_date',
  'acquisition_source', 'estimated_value', 'currency',
];

function pick(src, fields) {
  const out = {};
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

exports.handler = async (event) => {
  const methods = 'POST, OPTIONS';
  if (event.httpMethod === 'OPTIONS') return preflight(event, methods);
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, event, methods);

  const auth = await requireAdmin(event);
  if (!auth.ok) return auth.response;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }, event, methods); }

  const { action } = body;

  try {
    switch (action) {
      case 'item.upsert': {
        const row = pick(body.item || {}, ITEM_FIELDS);
        if (!row.title) return json(400, { error: 'title required' }, event, methods);
        let out;
        if (body.item?.id) out = await patch('archive_items', body.item.id, row);
        else {
          row.created_by = auth.user.id;
          out = await upsert('archive_items', row);
        }
        return json(200, { item: out }, event, methods);
      }

      case 'item.delete':
        if (!body.id) return json(400, { error: 'id required' }, event, methods);
        await del('archive_items', body.id);
        return json(200, { ok: true }, event, methods);

      case 'photo.add': {
        const { item_id, storage_path } = body;
        if (!item_id || !storage_path) return json(400, { error: 'item_id and storage_path required' }, event, methods);
        const out = await upsert('archive_photos', pick(body,
          ['item_id', 'storage_path', 'caption', 'is_primary', 'width', 'height', 'bytes', 'content_type', 'display_order']));
        return json(200, { photo: out }, event, methods);
      }

      case 'photo.remove':
        if (!body.id) return json(400, { error: 'id required' }, event, methods);
        await del('archive_photos', body.id);
        return json(200, { ok: true }, event, methods);

      case 'photo.primary': {
        if (!body.id) return json(400, { error: 'id required' }, event, methods);
        // Clear siblings then set this one (partial unique index enforces one primary)
        const row = await patch('archive_photos', body.id, { is_primary: false });
        await REST(`archive_photos?item_id=eq.${row.item_id}`, {
          method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }),
          body: JSON.stringify({ is_primary: false }),
        });
        const out = await patch('archive_photos', body.id, { is_primary: true });
        return json(200, { photo: out }, event, methods);
      }

      case 'provenance.add':
        return json(200, { row: await upsert('archive_provenance', pick(body,
          ['item_id', 'event_type', 'event_date', 'actor', 'location', 'detail', 'sort_key'])) }, event, methods);

      case 'valuation.add':
        return json(200, { row: await upsert('archive_valuations', pick(body,
          ['item_id', 'valued_on', 'amount', 'currency', 'basis', 'source', 'note'])) }, event, methods);

      case 'cert.add':
        return json(200, { row: await upsert('archive_certifications', pick(body,
          ['item_id', 'provider', 'cert_number', 'grade', 'verified_at', 'raw']),
          'provider,cert_number') }, event, methods);

      case 'extref.upsert':
        return json(200, { row: await upsert('archive_external_refs', pick(body,
          ['item_id', 'system', 'ref_type', 'ref_id', 'url', 'data', 'synced_at']),
          'system,ref_type,ref_id') }, event, methods);

      default:
        return json(400, { error: `Unknown action: ${action}` }, event, methods);
    }
  } catch (err) {
    console.error('archive-admin error:', err);
    return json(500, { error: err.message }, event, methods);
  }
};
