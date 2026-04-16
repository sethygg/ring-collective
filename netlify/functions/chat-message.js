// netlify/functions/chat-message.js
//
// Receives a message from the home-page chat widget and emails Seth via Resend.
// This is the MVP: no AI yet, just capture + notify. Later this endpoint
// will be replaced (or wrapped) by a Claude-backed concierge that answers
// tier-1 questions automatically and only escalates tier-2 to Seth.
//
// Payload: { message, email?, name?, page, source }
//
// Required env vars:
//   RESEND_API_KEY
//   NOTIFY_TO    — Seth's email
//   NOTIFY_FROM  — e.g. "Ring Collective Chat <chat@theringcollective.net>"

const ALLOWED_ORIGINS = [
  /^https?:\/\/theringcollective\.netlify\.app$/i,
  /^https?:\/\/theringcollective\.co$/i,
  /^https?:\/\/www\.theringcollective\.co$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];

// Rudimentary per-IP rate limit: 10 / 10 min.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 10;
const hits = new Map();

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(re => re.test(origin || ''));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function rateLimit(ip) {
  const now = Date.now();
  const history = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (history.length >= MAX_PER_WINDOW) return false;
  history.push(now);
  hits.set(ip, history);
  return true;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Server misconfigured: ${name} missing.`);
  return v;
}

async function sendEmail({ to, from, subject, text, html, replyTo }) {
  const key = requireEnv('RESEND_API_KEY');
  const body = { from, to, subject, text, html };
  if (replyTo) body.reply_to = replyTo;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await resp.text();
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${out}`);
  return out ? JSON.parse(out) : null;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };
  if (!ALLOWED_ORIGINS.some(re => re.test(origin))) {
    return { statusCode: 403, headers, body: 'Origin not allowed' };
  }

  const ip = event.headers['x-nf-client-connection-ip']
    || event.headers['client-ip']
    || (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || 'unknown';
  if (!rateLimit(ip)) {
    return {
      statusCode: 429,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Too many chat messages. Try again shortly.' }),
    };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers, body: 'Invalid JSON' }; }

  const message = truncate((payload.message || '').trim(), 2000);
  const email   = truncate((payload.email   || '').trim(), 200);
  const name    = truncate((payload.name    || '').trim(), 120);
  const page    = truncate((payload.page    || '').trim(), 200);
  const source  = truncate((payload.source  || 'chat-widget').trim(), 60);

  if (!message) return { statusCode: 400, headers, body: 'message required' };

  // Build email body
  const heading = email ? `Chat reply needed — ${email}` : `New chat message (no email yet)`;
  const rows = [
    ['From',    email || '(anonymous)'],
    ['Name',    name || '—'],
    ['Page',    page || '—'],
    ['Source',  source],
    ['IP',      ip],
    ['Time',    new Date().toISOString()],
  ];
  const rowsHtml = rows.map(([k, v]) => `
    <tr>
      <td style="padding:4px 12px 4px 0;color:#707683;font-size:12px;vertical-align:top">${esc(k)}</td>
      <td style="padding:4px 0;color:#22252b;font-size:13px">${esc(v)}</td>
    </tr>
  `).join('');

  const text = [
    heading,
    '',
    `Message:`,
    message,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',Arial,sans-serif;background:#FAF7F2;padding:28px 20px">
      <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E9E4DA;border-radius:8px;overflow:hidden">
        <div style="padding:20px 26px;border-bottom:1px solid #E9E4DA">
          <div style="font-family:'Playfair Display',Georgia,serif;font-size:18px;color:#1F2A44">The Ring Collective</div>
          <div style="color:#D9B48C;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:2px">Chat Message</div>
        </div>
        <div style="padding:22px 26px">
          <div style="background:#FAF7F2;border-left:3px solid #D9B48C;padding:14px 16px;margin-bottom:18px;font-size:14px;line-height:1.6;color:#2A3654;white-space:pre-wrap">${esc(message)}</div>
          <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">${rowsHtml}</table>
          ${email ? `<div style="margin-top:22px"><a href="mailto:${esc(email)}" style="display:inline-block;background:#2E5C4A;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;letter-spacing:1px;text-transform:uppercase">Reply to ${esc(email)}</a></div>` : '<div style="margin-top:14px;color:#a06c0e;font-size:12px">No email captured yet. They may follow up — or it was anonymous.</div>'}
        </div>
      </div>
    </div>`;

  try {
    const to   = requireEnv('NOTIFY_TO');
    const from = process.env.NOTIFY_FROM || 'Ring Collective <onboarding@resend.dev>';
    const subject = email
      ? `Chat — ${email}: ${truncate(message, 60)}`
      : `Chat (anon) — ${truncate(message, 60)}`;
    await sendEmail({ to, from, subject, text, html, replyTo: email || undefined });

    return {
      statusCode: 200,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error('chat-message error:', err);
    return {
      statusCode: 500,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: String(err.message || err) }),
    };
  }
};
