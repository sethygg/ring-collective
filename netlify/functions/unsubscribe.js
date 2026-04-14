// netlify/functions/unsubscribe.js
//
// Public endpoint — no auth. Invoked by clicking the "Unsubscribe" link in a
// Maya follow-up email. Marks the lead as unsubscribed so the sequence stops.
//
// URL shape: /.netlify/functions/unsubscribe?id=<uuid>

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Server misconfigured: ${name} missing.`);
  return v;
}

async function sbPatch(id, patch) {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const resp = await fetch(
    `${url}/rest/v1/quote_requests?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    }
  );
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const page = (title, message) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#22252b;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border:1px solid #E9E4DA;border-radius:14px;padding:44px 40px;max-width:460px;text-align:center;box-shadow:0 6px 30px rgba(0,0,0,.04)}
  .brand{font-family:Georgia,serif;font-size:18px;letter-spacing:2px;color:#1F2A44;margin-bottom:28px}
  h1{font-family:Georgia,serif;font-size:24px;color:#1F2A44;font-weight:500;margin:0 0 14px}
  p{font-size:15px;line-height:1.65;color:#505664;margin:0 0 10px}
  a{color:#2E5C4A}
</style></head>
<body><div class="card">
  <div class="brand">The Ring Collective</div>
  <h1>${title}</h1>
  <p>${message}</p>
</div></body></html>`;

exports.handler = async (event) => {
  const id = (event.queryStringParameters || {}).id;
  if (!id) {
    return { statusCode: 400, headers: { 'content-type': 'text/html' },
      body: page('Missing ID', 'This unsubscribe link is incomplete.') };
  }

  try {
    await sbPatch(id, {
      unsubscribed_at: new Date().toISOString(),
      auto_sequence_enabled: false,
    });
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      body: page(
        "You're unsubscribed.",
        "You won't receive any more follow-up emails from us. If this was a mistake, just reply to any past email from us and we'll sort it out. Wishing you the best."
      ),
    };
  } catch (err) {
    console.error('unsubscribe error:', err);
    return {
      statusCode: 500,
      headers: { 'content-type': 'text/html' },
      body: page('Something went wrong', "We couldn't process that. Please email sales@theringcollective.net and we'll take you off the list manually."),
    };
  }
};
