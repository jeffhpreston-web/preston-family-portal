// GET /api/archive-items
//   Public read of the curated archive. Returns only published items
//   (archive_public_items view — no financials). Supports filtering:
//     ?category=coins   ?tag=bradman   ?featured=1   ?id=<uuid>
//     ?limit=50&offset=0
//
// This endpoint is intentionally unauthenticated and read-only. Anything
// non-public is served by the authenticated member app via RLS, not here.

const { SUPABASE_URL, json, preflight, sbHeaders } = require('./_lib/auth');

exports.handler = async (event) => {
  const methods = 'GET, OPTIONS';
  if (event.httpMethod === 'OPTIONS') return preflight(event, methods);
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' }, event, methods);

  const q = event.queryStringParameters || {};
  const params = new URLSearchParams();
  params.set('select', '*');

  if (q.id) params.set('id', `eq.${q.id}`);
  if (q.category) params.set('category_slug', `eq.${q.category}`);
  if (q.featured === '1' || q.featured === 'true') params.set('is_featured', 'is.true');
  if (q.tag) params.set('tags', `cs.{${q.tag}}`);

  params.set('order', 'display_order.asc,title.asc');
  const limit = Math.min(parseInt(q.limit || '60', 10) || 60, 200);
  const offset = parseInt(q.offset || '0', 10) || 0;
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/archive_public_items?${params.toString()}`,
      { headers: sbHeaders({ Prefer: 'count=exact' }) }
    );
    if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${await resp.text()}`);
    const items = await resp.json();
    const total = (resp.headers.get('content-range') || '').split('/')[1] || null;
    return json(200, { items, total: total ? Number(total) : items.length }, event, methods);
  } catch (err) {
    console.error('archive-items error:', err);
    return json(500, { error: err.message }, event, methods);
  }
};
