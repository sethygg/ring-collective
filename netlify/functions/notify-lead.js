// netlify/functions/notify-lead.js
//
// Called by the quote builder right after a new row is inserted.
// Fetches the full lead from Supabase (service_role) and emails a
// notification to the team via Resend.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   NOTIFY_TO           — recipient, e.g. sales@theringcollective.net
//   NOTIFY_FROM         — sender, e.g. "Ring Collective Leads <leads@theringcollective.net>"
//                          If your domain isn't verified in Resend yet, use
//                          "Ring Collective <onboarding@resend.dev>" (sandbox).
//   ADMIN_URL           — optional, default https://theringcollective.netlify.app/admin.html

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

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Server misconfigured: ${name} missing.`);
  return v;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

async function fetchLead(id) {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const resp = await fetch(
    `${url}/rest/v1/quote_requests?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${await resp.text()}`);
  const rows = await resp.json();
  return rows && rows[0];
}

function buildEmail(lead) {
  const adminUrl = process.env.ADMIN_URL || 'https://theringcollective.netlify.app/admin.html';
  const name  = lead.name || 'Unknown';
  const stoneSummary = [
    lead.stone_type || lead.stone_category,
    lead.diamond_carat ? `${lead.diamond_carat} ct` : null,
    lead.shape,
    lead.metal ? `${lead.karat || ''} ${lead.metal}`.trim() : null,
  ].filter(Boolean).join(' · ');

  const rows = [
    ['Name',         name],
    ['Email',        lead.email],
    ['Phone',        lead.phone || '—'],
    ['Stone',        stoneSummary || '—'],
    ['Setting (AI)', [lead.setting_style, lead.weight_class].filter(Boolean).join(' / ') || '—'],
    ['Ring size',    lead.ring_size || '—'],
    ['Budget',       lead.budget || '—'],
    ['Timeline',     lead.timeline || lead.custom_date || '—'],
    ['Photos',       String((lead.photo_paths || []).length)],
    ['Submitted',    new Date(lead.created_at).toLocaleString()],
  ];

  const text = [
    `New quote request — ${name}`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `View in admin: ${adminUrl}`,
  ].join('\n');

  const rowsHtml = rows.map(([k, v]) => `
    <tr>
      <td style="padding:6px 14px 6px 0;color:#707683;font-size:13px;vertical-align:top">${esc(k)}</td>
      <td style="padding:6px 0;color:#22252b;font-size:14px">${esc(v)}</td>
    </tr>
  `).join('');

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',Arial,sans-serif;background:#FAF7F2;padding:32px 20px">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E9E4DA;border-radius:8px;overflow:hidden">
      <div style="padding:22px 28px;border-bottom:1px solid #E9E4DA">
        <div style="font-family:'Playfair Display',Georgia,serif;font-size:20px;color:#1F2A44">The Ring Collective</div>
        <div style="color:#D9B48C;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:2px">New Lead</div>
      </div>
      <div style="padding:24px 28px">
        <h2 style="font-family:'Playfair Display',Georgia,serif;font-size:22px;color:#1F2A44;margin:0 0 4px">${esc(name)}</h2>
        <p style="color:#707683;font-size:13px;margin:0 0 18px">${esc(lead.email || '')}${lead.phone ? ' · ' + esc(lead.phone) : ''}</p>
        <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">${rowsHtml}</table>
        <div style="margin-top:24px">
          <a href="${esc(adminUrl)}" style="display:inline-block;background:#2E5C4A;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:13px;letter-spacing:1px;text-transform:uppercase">Open admin dashboard</a>
        </div>
      </div>
    </div>
  </div>`;

  return { text, html };
}

async function sendEmail({ to, from, subject, text, html }) {
  const key = requireEnv('RESEND_API_KEY');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text, html }),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };
  if (!ALLOWED_ORIGINS.some(re => re.test(origin))) {
    return { statusCode: 403, headers, body: 'Origin not allowed' };
  }

  let id;
  try { ({ id } = JSON.parse(event.body || '{}')); }
  catch (_) { return { statusCode: 400, headers, body: 'Invalid JSON' }; }
  if (!id) return { statusCode: 400, headers, body: 'id required' };

  try {
    const lead = await fetchLead(id);
    if (!lead) return { statusCode: 404, headers, body: 'lead not found' };

    const { text, html } = buildEmail(lead);
    const subject = `New lead — ${lead.name || 'Unknown'}${lead.stone_type ? ' · ' + lead.stone_type : ''}`;
    const to   = requireEnv('NOTIFY_TO');
    const from = process.env.NOTIFY_FROM || 'Ring Collective <onboarding@resend.dev>';

    const result = await sendEmail({ to, from, subject, text, html });

    return {
      statusCode: 200,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, id: result && result.id }),
    };
  } catch (err) {
    console.error('notify-lead error:', err);
    return {
      statusCode: 500,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: String(err.message || err) }),
    };
  }
};
