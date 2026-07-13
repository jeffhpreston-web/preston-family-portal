// Verify a grading certification against the grader's API.
//   GET/POST  ?provider=PSA&cert=12345678
//   -> { ok, provider, cert_number, grade, subject, verified_at, raw }  (ok:false + error otherwise)
//
// PSA works today (uses PSA_API_TOKEN, same token as psa-lookup.js).
// PCGS activates when PCGS_API_KEY is set. Other graders (NGC, SGC, BGS, CGC…)
// have no open API — they return a clear "enter manually" message.
//
// This is a read-only proxy to public grading data (same exposure as the
// existing psa-lookup function). The portal writes the result back to
// archive_certifications itself, using the admin's Supabase session — so this
// function needs no database credentials.

const ALLOWED = [
  'https://jeffhpreston-web.github.io',
  'https://vermillion-bonbon-d04317.netlify.app',
  'https://clanpreston.org',
  'https://prestoncollection.net',
];

function cors(event) {
  const o = event.headers.origin || event.headers.Origin || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(o) ? o : ALLOWED[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}
const json = (s, d, event) => ({ statusCode: s, headers: { ...cors(event), 'Content-Type': 'application/json' }, body: JSON.stringify(d) });

function fmtWait(sec) {
  if (!sec || sec <= 0) return 'shortly';
  if (sec < 60) return `in ${sec}s`;
  if (sec < 3600) return `in about ${Math.round(sec / 60)} min`;
  return `in about ${Math.round(sec / 3600)} hour(s)`;
}

// Read an integration token: prefer the admin-managed value in the
// integration_settings table (service-role read), fall back to the env var.
async function getSecret(key, envName) {
  const url = process.env.ARCHIVE_SUPABASE_URL, srv = process.env.ARCHIVE_SERVICE_ROLE_KEY;
  if (url && srv) {
    try {
      const r = await fetch(`${url}/rest/v1/integration_settings?key=eq.${encodeURIComponent(key)}&select=value`,
        { headers: { apikey: srv, Authorization: `Bearer ${srv}` } });
      if (r.ok) { const rows = await r.json(); const v = rows && rows[0] && rows[0].value; if (v) return v; }
    } catch { /* fall through to env */ }
  }
  return process.env[envName];
}

async function verifyPSA(cert) {
  const token = await getSecret('psa_api_token', 'PSA_API_TOKEN');
  if (!token) return { error: 'PSA API token not configured. Add it in the portal Settings page (or set PSA_API_TOKEN).' };
  const r = await fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(cert)}`,
    { headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' } });
  if (r.status === 429) {
    const ra = r.headers.get('retry-after'); const sec = ra ? parseInt(ra, 10) : null;
    return { error: `PSA rate limit reached — the daily lookup quota is likely exhausted. Try again ${fmtWait(sec)}.`, status: 429, retryAfter: sec };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { error: (data && data.message) || `PSA API error ${r.status}`, status: r.status };
  const c = (data && data.PSACert) || data || {};
  const grade = c.CardGrade || c.GradeDescription || c.Grade || null;
  if (!grade && !c.CertNumber) return { error: 'No PSA record found for that cert number.' };
  return { grade, subject: c.Subject || c.Description || null, raw: data };
}

async function verifyPCGS(cert) {
  const key = await getSecret('pcgs_api_key', 'PCGS_API_KEY');
  if (!key) return { error: 'PCGS verification not configured. Add a PCGS API key in the portal Settings page.' };
  const r = await fetch(`https://api.pcgs.com/publicapi/coindetail/GetCoinFactsByCertNo/${encodeURIComponent(cert)}`,
    { headers: { Authorization: `Bearer ${key}` } });
  if (r.status === 429) {
    const ra = r.headers.get('retry-after'); const sec = ra ? parseInt(ra, 10) : null;
    return { error: `PCGS rate limit reached. Try again ${fmtWait(sec)}.`, status: 429, retryAfter: sec };
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { error: `PCGS API error ${r.status}`, status: r.status };
  return { grade: data.Grade || data.grade || null, subject: data.Name || data.PCGSNo || null, raw: data };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(event), body: '' };

  const q = event.queryStringParameters || {};
  let body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch { /* ignore */ } }
  const provider = String(q.provider || body.provider || '').toUpperCase();
  const cert = String(q.cert || body.cert || body.cert_number || '').trim();
  if (!provider || !cert) return json(400, { error: 'provider and cert are required' }, event);

  let res;
  try {
    if (provider === 'PSA') res = await verifyPSA(cert);
    else if (provider === 'PCGS') res = await verifyPCGS(cert);
    else return json(200, { ok: false, provider, cert_number: cert,
      error: `Automated verification isn't available for ${provider}. Enter the grade manually.` }, event);
  } catch (e) {
    return json(500, { error: e.message }, event);
  }

  if (res.error) return json(200, { ok: false, provider, cert_number: cert, error: res.error, status: res.status || null, retryAfter: res.retryAfter || null }, event);
  return json(200, {
    ok: true, provider, cert_number: cert,
    grade: res.grade, subject: res.subject || null,
    verified_at: new Date().toISOString(), raw: res.raw,
  }, event);
};
