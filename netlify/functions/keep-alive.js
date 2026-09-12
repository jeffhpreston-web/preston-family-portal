// Scheduled keep-alive ping so the free-tier Supabase projects never hit the
// ~7-day inactivity auto-pause (which took the portal down on 2026-07-11 and
// again before 2026-09-11, losing the send-email edge function the second time).
//
// Runs Mondays and Thursdays (see [functions."keep-alive"] in netlify.toml).
// Each ping executes a real REST query so the database itself sees activity,
// not just the API gateway. Not routable via URL — schedule-triggered only.
//
//   * Member app (witvlkcjvzxxajdwzdep): anon-key query on profiles (RLS
//     returns an empty set, which is fine — the query still runs).
//   * Registry (jkmqyncnkyglymvspnmk): uses the same SUPABASE_URL /
//     SUPABASE_SERVICE_ROLE_KEY env vars the registry functions already use.

const MEMBER_URL = 'https://witvlkcjvzxxajdwzdep.supabase.co';
const MEMBER_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpdHZsa2Nqdnp4eGFqZHd6ZGVwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NTk0MDIsImV4cCI6MjA4OTAzNTQwMn0.miKL5P-oTz4r1eTE4mCVdr9nbPv43aAzQQ2fREG1PVc';

async function ping(name, url, key) {
  try {
    const r = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    return `${name}: HTTP ${r.status}`;
  } catch (e) {
    return `${name}: FAILED (${e.message})`;
  }
}

exports.handler = async () => {
  const results = [
    await ping('member-app', `${MEMBER_URL}/rest/v1/profiles?select=id&limit=1`, MEMBER_ANON),
  ];

  const regUrl = process.env.SUPABASE_URL;
  const regKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (regUrl && regKey) {
    results.push(await ping('registry', `${regUrl}/rest/v1/site_settings?select=key&limit=1`, regKey));
  } else {
    results.push('registry: SKIPPED (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)');
  }

  // Shows up in the Netlify function logs for each scheduled run.
  console.log('[keep-alive]', new Date().toISOString(), '-', results.join(' | '));
  return { statusCode: 200, body: JSON.stringify({ ok: true, results }) };
};
