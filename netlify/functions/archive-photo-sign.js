// Photo access for the private 'archive' Storage bucket.
//
// GET  /api/archive-photo-sign?path=items/<id>/front.jpg
//        -> { url } short-lived signed download URL. Allowed when the caller
//           is a member (any access_level) OR the photo belongs to a public item.
//
// POST /api/archive-photo-sign   (admin only)
//        body { path, contentType? } -> { url, token, path } signed UPLOAD URL,
//        so large image bytes go browser -> Storage directly (never through the
//        function). Follow with archive-admin photo.add to register the row.

const {
  SUPABASE_URL, json, preflight, requireAdmin, sbHeaders,
} = require('./_lib/auth');
const ANON_KEY = process.env.ARCHIVE_ANON_KEY;

const BUCKET = 'archive';
const DOWNLOAD_TTL = 60 * 10; // 10 minutes

async function callerIsMember(event) {
  const authz = event.headers.authorization || event.headers.Authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!token) return false;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  return r.ok;
}

async function pathBelongsToPublicItem(path) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/archive_photos?storage_path=eq.${encodeURIComponent(path)}` +
    `&select=item_id,archive_items!inner(is_public,status)`,
    { headers: sbHeaders() }
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return rows.some((x) => x.archive_items?.is_public && x.archive_items?.status === 'active');
}

exports.handler = async (event) => {
  const methods = 'GET, POST, OPTIONS';
  if (event.httpMethod === 'OPTIONS') return preflight(event, methods);

  try {
    if (event.httpMethod === 'GET') {
      const path = (event.queryStringParameters || {}).path;
      if (!path) return json(400, { error: 'path required' }, event, methods);

      const allowed = (await callerIsMember(event)) || (await pathBelongsToPublicItem(path));
      if (!allowed) return json(403, { error: 'Not permitted' }, event, methods);

      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
        method: 'POST', headers: sbHeaders(),
        body: JSON.stringify({ expiresIn: DOWNLOAD_TTL }),
      });
      if (!r.ok) throw new Error(`sign ${r.status}: ${await r.text()}`);
      const { signedURL } = await r.json();
      return json(200, { url: `${SUPABASE_URL}/storage/v1${signedURL}` }, event, methods);
    }

    if (event.httpMethod === 'POST') {
      const auth = await requireAdmin(event);
      if (!auth.ok) return auth.response;

      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return json(400, { error: 'Invalid JSON' }, event, methods); }
      if (!body.path) return json(400, { error: 'path required' }, event, methods);

      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${body.path}`, {
        method: 'POST', headers: sbHeaders(),
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`upload-sign ${r.status}: ${await r.text()}`);
      const out = await r.json();
      return json(200, { url: `${SUPABASE_URL}/storage/v1${out.url}`, token: out.token, path: body.path }, event, methods);
    }

    return json(405, { error: 'Method not allowed' }, event, methods);
  } catch (err) {
    console.error('archive-photo-sign error:', err);
    return json(500, { error: err.message }, event, methods);
  }
};
