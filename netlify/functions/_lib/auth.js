// Shared auth + CORS helpers for Preston Collection API functions.
//
// Two protection models are supported:
//   1. requireAdmin(event)  — verifies a Supabase Auth JWT (the token the
//      member app already issues) AND that the user's profile.access_level
//      is 'admin'. Use for archive write endpoints. No shared secrets in the
//      browser; identity is proven by the session token.
//   2. requireSecret(event) — checks the x-portal-secret header against
//      PORTAL_SECRET. Use only for server-to-server / trusted callers.
//
// Both return { ok:true, ... } or { ok:false, response } where `response` is a
// ready-to-return Netlify handler result.

// The archive lives on the MEMBER-APP Supabase project (auth + storage there),
// which is a DIFFERENT project from the clanpreston.org registry. Use dedicated
// ARCHIVE_* env vars so the registry functions' SUPABASE_* env is never touched
// and the two backends can never collide.
const SUPABASE_URL = process.env.ARCHIVE_SUPABASE_URL;
const SERVICE_KEY = process.env.ARCHIVE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.ARCHIVE_ANON_KEY;
const PORTAL_SECRET = process.env.PORTAL_SECRET;

// Comma-separated allowlist, e.g.
// "https://clanpreston.org,https://prestoncollection.net,https://vermillion-bonbon-d04317.netlify.app"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://clanpreston.org,https://prestoncollection.net')
  .split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(event, methods = 'GET, POST, OPTIONS') {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-portal-secret',
    'Vary': 'Origin',
  };
}

function json(statusCode, data, event, methods) {
  return {
    statusCode,
    headers: { ...corsHeaders(event, methods), 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

function preflight(event, methods) {
  return { statusCode: 204, headers: corsHeaders(event, methods), body: '' };
}

// Verify the bearer token with Supabase Auth, then look up access_level.
async function requireAdmin(event) {
  const authz = event.headers.authorization || event.headers.Authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  if (!token) {
    return { ok: false, response: json(401, { error: 'Missing bearer token' }, event) };
  }

  // 1. Validate the token → user id
  const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!uResp.ok) {
    return { ok: false, response: json(401, { error: 'Invalid session' }, event) };
  }
  const user = await uResp.json();

  // 2. Check access_level via service role (bypasses RLS for the lookup)
  const pResp = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=id,access_level`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  const [profile] = (await pResp.json()) || [];
  if (!profile || profile.access_level !== 'admin') {
    return { ok: false, response: json(403, { error: 'Admin access required' }, event) };
  }

  return { ok: true, user, profile };
}

function requireSecret(event) {
  const provided = event.headers['x-portal-secret'] || event.headers['X-Portal-Secret'];
  if (!PORTAL_SECRET || provided !== PORTAL_SECRET) {
    return { ok: false, response: json(401, { error: 'Unauthorized' }, event) };
  }
  return { ok: true };
}

// Thin Supabase REST helper using the service-role key.
function sbHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

module.exports = {
  SUPABASE_URL,
  corsHeaders,
  json,
  preflight,
  requireAdmin,
  requireSecret,
  sbHeaders,
};
