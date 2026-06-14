const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORTAL_SECRET = process.env.PORTAL_SECRET;

const CORS = {
  'Access-Control-Allow-Origin': 'https://clanpreston.org',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-portal-secret',
};

const hdrs = (extra = {}) => ({ ...CORS, 'Content-Type': 'application/json', ...extra });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: hdrs(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (event.headers['x-portal-secret'] !== PORTAL_SECRET) {
    return { statusCode: 401, headers: hdrs(), body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: hdrs(), body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { action } = body;

  try {
    // ── save: insert (no id) or update (id present) ──────────────────────────
    if (action === 'save') {
      const { id, name, description, lat, lng, category, display_order, active } = body;
      if (!name) {
        return { statusCode: 400, headers: hdrs(), body: JSON.stringify({ error: 'name is required' }) };
      }

      const row = {
        name,
        description: description || null,
        lat:           (lat !== undefined && lat !== null && lat !== '') ? parseFloat(lat) : null,
        lng:           (lng !== undefined && lng !== null && lng !== '') ? parseFloat(lng) : null,
        category:      category || null,
        display_order: display_order !== undefined ? parseInt(display_order, 10) : 0,
        active:        active !== undefined ? Boolean(active) : true,
      };

      let resp;
      if (id) {
        resp = await fetch(
          `${SUPABASE_URL}/rest/v1/clan_map_locations?id=eq.${encodeURIComponent(id)}`,
          {
            method: 'PATCH',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=representation',
            },
            body: JSON.stringify(row),
          }
        );
      } else {
        resp = await fetch(
          `${SUPABASE_URL}/rest/v1/clan_map_locations`,
          {
            method: 'POST',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=representation',
            },
            body: JSON.stringify(row),
          }
        );
      }

      if (!resp.ok) throw new Error(`Supabase error ${resp.status}: ${await resp.text()}`);
      const [location] = await resp.json();
      return { statusCode: 200, headers: hdrs(), body: JSON.stringify({ location }) };
    }

    // ── delete ────────────────────────────────────────────────────────────────
    if (action === 'delete') {
      const { id } = body;
      if (!id) return { statusCode: 400, headers: hdrs(), body: JSON.stringify({ error: 'id is required' }) };

      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/clan_map_locations?id=eq.${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Prefer: 'return=minimal',
          },
        }
      );
      if (!resp.ok) throw new Error(`Supabase error ${resp.status}: ${await resp.text()}`);
      return { statusCode: 200, headers: hdrs(), body: JSON.stringify({ deleted: id }) };
    }

    // ── reorder: batch PATCH display_order for two swapped rows ──────────────
    if (action === 'reorder') {
      const { items } = body; // [{ id, display_order }, ...]
      if (!Array.isArray(items) || items.length === 0) {
        return { statusCode: 400, headers: hdrs(), body: JSON.stringify({ error: 'items array required' }) };
      }

      await Promise.all(
        items.map(({ id, display_order }) =>
          fetch(
            `${SUPABASE_URL}/rest/v1/clan_map_locations?id=eq.${encodeURIComponent(id)}`,
            {
              method: 'PATCH',
              headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
              },
              body: JSON.stringify({ display_order }),
            }
          )
        )
      );
      return { statusCode: 200, headers: hdrs(), body: JSON.stringify({ reordered: items.length }) };
    }

    return { statusCode: 400, headers: hdrs(), body: JSON.stringify({ error: `Unknown action: ${action}` }) };
  } catch (err) {
    console.error('map-locations-update error:', err);
    return { statusCode: 500, headers: hdrs(), body: JSON.stringify({ error: err.message }) };
  }
};
