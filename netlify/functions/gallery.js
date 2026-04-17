// netlify/functions/gallery.js
//
// Public read-only endpoint for the gallery.  No auth needed — the
// gallery_pieces table has an RLS policy that allows SELECT on active rows.
//
// GET  /.netlify/functions/gallery              → all active pieces (ordered)
// GET  /.netlify/functions/gallery?limit=8      → most recent N pieces
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (we use service_role to bypass RLS for
//                                ordering flexibility; only returns active rows)

const ALLOWED_ORIGINS = [
  /^https?:\/\/theringcollective\.netlify\.app$/i,
  /^https?:\/\/theringcollective\.co$/i,
  /^https?:\/\/www\.theringcollective\.co$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(re => re.test(origin || ''));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing Supabase env vars');

    // Parse optional limit from query string.
    const params = event.queryStringParameters || {};
    const limit = parseInt(params.limit, 10);
    const limitClause = Number.isFinite(limit) && limit > 0 ? `&limit=${limit}` : '';

    const resp = await fetch(
      `${url}/rest/v1/gallery_pieces?select=id,image_path,title,description,price_cents,stone_carat,stone_type,metal_type,display_order,created_at&is_active=eq.true&order=display_order.asc,created_at.desc${limitClause}`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
      }
    );

    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`Supabase ${resp.status}: ${t}`);
    }

    const rows = await resp.json();

    // Public URLs — the gallery bucket has a storage policy allowing
    // anonymous reads, so no signing needed.
    const pieces = rows.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      price_cents: r.price_cents,
      stone_carat: r.stone_carat,
      stone_type: r.stone_type,
      metal_type: r.metal_type,
      image_url: `${url}/storage/v1/object/public/gallery/${r.image_path}`,
      created_at: r.created_at,
    }));

    return {
      statusCode: 200,
      headers: { ...cors, 'content-type': 'application/json', 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify(pieces),
    };
  } catch (err) {
    console.error('gallery error:', err);
    return {
      statusCode: 500,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to load gallery' }),
    };
  }
};
