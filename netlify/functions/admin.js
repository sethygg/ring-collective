// netlify/functions/admin.js
//
// Single admin endpoint for the Ring Collective back office.
// The browser posts { action, password, ...args } — we verify the password
// server-side, then hit Supabase with the service_role key to bypass RLS.
// The service_role key never leaves this function.
//
// Required env vars (set these in Netlify → Site settings → Environment variables):
//   ADMIN_PASSWORD                — shared password for admin.html
//   SUPABASE_URL                  — e.g. https://jcsyucadvweiskxfwedq.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY     — the `sb_secret_...` key (NEVER expose to browser)
//   GOLDAPI_KEY                   — from goldapi.io (free tier)

const TROY_OZ_G = 31.1034768;
const METALS_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours
let metalsCache = null;

const ALLOWED_ORIGINS = [
  /^https?:\/\/theringcollective\.netlify\.app$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(re => re.test(origin || ''));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(statusCode, headers, body) {
  return {
    statusCode,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Server misconfigured: ${name} missing.`);
  return v;
}

// --- Supabase helpers ---------------------------------------------------

async function sbFetch(path, opts = {}) {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const resp = await fetch(`${url}${path}`, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase ${resp.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function listLeads({ status }) {
  let q = `/rest/v1/quote_requests?select=*&order=created_at.desc&limit=200`;
  if (status && status !== 'all') {
    q += `&status=eq.${encodeURIComponent(status)}`;
  }
  return sbFetch(q);
}

async function getLead(id) {
  const rows = await sbFetch(
    `/rest/v1/quote_requests?select=*&id=eq.${encodeURIComponent(id)}&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function updateLead(id, patch) {
  return sbFetch(
    `/rest/v1/quote_requests?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    }
  );
}

async function signedPhotoUrl(path, expiresIn = 3600) {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const resp = await fetch(
    `${url}/storage/v1/object/sign/ring-photos/${encodeURI(path)}`,
    {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expiresIn }),
    }
  );
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`signed URL failed ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  return `${url}/storage/v1${data.signedURL || data.signedUrl}`;
}

// --- Metals price (goldapi.io) ------------------------------------------

async function fetchMetalPricePerG(symbol) {
  const key = requireEnv('GOLDAPI_KEY');
  const resp = await fetch(`https://www.goldapi.io/api/${symbol}/USD`, {
    headers: { 'x-access-token': key },
  });
  if (!resp.ok) {
    throw new Error(`goldapi ${symbol} ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  // goldapi returns price per troy ounce in USD as `price`
  const perOz = data.price;
  if (typeof perOz !== 'number') throw new Error(`goldapi: no price for ${symbol}`);
  return { perOz, perG: perOz / TROY_OZ_G };
}

async function getMetalsPrices(force = false) {
  if (!force && metalsCache && Date.now() - metalsCache.fetchedAt < METALS_CACHE_MS) {
    return { ...metalsCache.data, cached: true };
  }
  const [gold, platinum] = await Promise.all([
    fetchMetalPricePerG('XAU'),
    fetchMetalPricePerG('XPT'),
  ]);
  const data = {
    gold: { perOzUSD: gold.perOz, perGUSD: gold.perG },
    platinum: { perOzUSD: platinum.perOz, perGUSD: platinum.perG },
    fetchedAt: new Date().toISOString(),
  };
  metalsCache = { data, fetchedAt: Date.now() };
  return data;
}

// --- Handler ------------------------------------------------------------

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, headers, { error: 'Invalid JSON' }); }

  const { action, password } = body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return json(500, headers, { error: 'ADMIN_PASSWORD not set on server' });
  if (password !== adminPassword) return json(401, headers, { error: 'Invalid password' });

  try {
    switch (action) {
      case 'login':
        return json(200, headers, { ok: true });

      case 'list': {
        const rows = await listLeads({ status: body.status });
        return json(200, headers, { leads: rows });
      }

      case 'get': {
        if (!body.id) return json(400, headers, { error: 'id required' });
        const lead = await getLead(body.id);
        if (!lead) return json(404, headers, { error: 'not found' });
        // Sign each photo URL so the admin page can show them.
        const photos = [];
        for (const path of (lead.photo_paths || [])) {
          try {
            const url = await signedPhotoUrl(path);
            photos.push({ path, url });
          } catch (e) {
            photos.push({ path, url: null, error: String(e.message || e) });
          }
        }
        return json(200, headers, { lead, photos });
      }

      case 'update_status': {
        if (!body.id || !body.status) return json(400, headers, { error: 'id + status required' });
        const out = await updateLead(body.id, { status: body.status });
        return json(200, headers, { lead: Array.isArray(out) ? out[0] : out });
      }

      case 'update_quote': {
        if (!body.id) return json(400, headers, { error: 'id required' });
        const patch = {};
        if (typeof body.quote_total === 'number') patch.quote_total = Math.round(body.quote_total);
        if (typeof body.quote_notes === 'string') patch.quote_notes = body.quote_notes;
        if (Object.keys(patch).length === 0) return json(400, headers, { error: 'nothing to update' });
        const out = await updateLead(body.id, patch);
        return json(200, headers, { lead: Array.isArray(out) ? out[0] : out });
      }

      case 'update_sequence': {
        if (!body.id) return json(400, headers, { error: 'id required' });
        const patch = {};
        if (typeof body.auto_sequence_enabled === 'boolean') {
          patch.auto_sequence_enabled = body.auto_sequence_enabled;
          // Resuming from paused → schedule next touch for 24h out if none set
          if (body.auto_sequence_enabled === true) {
            patch.next_touch_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            patch.unsubscribed_at = null;
          }
        }
        if (Object.keys(patch).length === 0) return json(400, headers, { error: 'nothing to update' });
        const out = await updateLead(body.id, patch);
        return json(200, headers, { lead: Array.isArray(out) ? out[0] : out });
      }

      case 'metals_prices': {
        const data = await getMetalsPrices(body.force === true);
        return json(200, headers, data);
      }

      default:
        return json(400, headers, { error: `unknown action: ${action}` });
    }
  } catch (err) {
    console.error('admin error:', err);
    return json(500, headers, { error: String(err.message || err) });
  }
};
