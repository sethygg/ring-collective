// netlify/functions/send-quote.js
//
// Admin-only endpoint: builds the personalized quote email for a lead
// and sends it to the customer via Resend. Also marks the lead as
// status = 'quoted' and persists the quote total.
//
// Required env vars:
//   ADMIN_PASSWORD
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   NOTIFY_FROM   — e.g. "Ring Collective <leads@theringcollective.net>"

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

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

function fmtUSD(n) {
  const v = Math.round(Number(n) * 100) / 100;
  return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${text}`);
  return text ? JSON.parse(text) : null;
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

function buildQuoteEmail(lead, total, replyTo) {
  const first = (lead.name || '').split(' ')[0] || 'there';
  const cadDeposit = 100;
  const productionDeposit = total / 2;

  const detailRows = [];
  if (lead.stone_type) {
    const caratStr = lead.diamond_carat ? `${lead.diamond_carat} ct ` : '';
    detailRows.push(['Center stone', `${caratStr}${lead.stone_type}`]);
  } else if (lead.stone_category) {
    detailRows.push(['Center stone', lead.stone_category]);
  }
  if (lead.shape)       detailRows.push(['Shape',   lead.shape]);
  if (lead.metal)       detailRows.push(['Metal',   [lead.karat, lead.metal].filter(Boolean).join(' ')]);
  if (lead.setting_style) detailRows.push(['Setting', lead.setting_style.replace(/\b\w/g, c=>c.toUpperCase())]);
  if (lead.ring_size)   detailRows.push(['Size',    lead.ring_size]);

  const rowsHtml = detailRows.map(([k, v]) => `
    <tr>
      <td style="padding:7px 0;color:#707683;font-size:14px;vertical-align:top;width:40%">${esc(k)}</td>
      <td style="padding:7px 0;color:#22252b;font-weight:500;font-size:14px">${esc(v)}</td>
    </tr>
  `).join('');

  const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Your Ring Collective Estimate</title></head>
<body style="margin:0;background:#e9e4da;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;padding:40px 20px;color:#22252b">
  <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.08)">

    <div style="background:#1F2A44;padding:36px 40px;text-align:center;color:#fff">
      <div style="font-family:Georgia,serif;font-size:26px;letter-spacing:2px;margin:0">The Ring Collective</div>
      <div style="color:#D9B48C;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-top:6px">Your Personalized Estimate</div>
    </div>

    <div style="padding:36px 40px">
      <h1 style="font-family:Georgia,serif;font-size:22px;color:#1F2A44;margin:0 0 18px;font-weight:500">Hi ${esc(first)},</h1>
      <p style="font-size:15px;line-height:1.65;color:#303641;margin:0 0 14px">Thank you for sending your inspiration over — we've put together a personalized estimate based on the design you shared. Everything below is fully adjustable, so please treat this as a starting point for our conversation.</p>

      <div style="margin:26px 0;border:1px solid #E9E4DA;border-radius:8px;padding:22px 24px;background:#FAF7F2">
        <div style="color:#D9B48C;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 10px;font-weight:600">Your Ring</div>
        <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">${rowsHtml}</table>
        <div style="border-top:1px solid #E9E4DA;margin-top:14px;padding-top:14px;display:flex;justify-content:space-between;align-items:baseline">
          <span style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#707683">Estimated Total</span>
          <span style="font-family:Georgia,serif;font-size:28px;color:#1F2A44;font-weight:600">${esc(fmtUSD(total))}</span>
        </div>
      </div>

      <p style="font-size:15px;line-height:1.65;color:#303641;margin:0 0 14px">This includes materials, the center stone, expert labor, and all of our design work. If you'd like to explore a different carat, metal, or setting style, just reply and we'll reprice any option at no cost.</p>

      <div style="background:#F4EFE5;border-radius:8px;padding:24px 26px;margin:26px 0">
        <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#D9B48C;margin-bottom:12px;font-weight:600">A note from our founder</div>
        <p style="font-size:15px;line-height:1.7;color:#303641;margin:0 0 12px">We know a ring isn't just jewelry — it's a symbol of one of the most important moments of your life. That's a tremendous amount of trust to place in someone, and we take it seriously with every piece we craft.</p>
        <p style="font-size:15px;line-height:1.7;color:#303641;margin:0 0 12px">Over the years we've had the honor of making more than <strong>10,000 rings</strong> for couples who found their "yes," and we'd be so grateful for the chance to make yours next. Every ring we create is handcrafted to your exact specifications and quality-checked personally before it ever leaves our hands.</p>
        <p style="font-size:15px;line-height:1.7;color:#303641;margin:0 0 12px">If you have any questions at all — about the stone, the metal, timing, or anything in between — just reply to this email. It comes straight to me.</p>
        <div style="font-family:Georgia,serif;font-size:20px;color:#2E5C4A;margin-top:18px;font-style:italic">With gratitude,<br>Kelsey G.</div>
        <div style="font-size:12px;color:#707683;letter-spacing:1px;margin-top:2px">Founder, The Ring Collective</div>
      </div>

      <div style="margin:26px 0;padding:20px 22px;background:#fff;border:1px solid #E9E4DA;border-radius:8px">
        <div style="color:#2E5C4A;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 10px;font-weight:600">How payment works</div>
        <p style="font-size:14px;line-height:1.65;color:#303641;margin:0 0 8px"><strong style="color:#1F2A44">Payment 1 — $100 design deposit.</strong> This starts your custom 3D CAD rendering, which you can adjust up to three times free. The full $100 applies toward your final price.</p>
        <p style="font-size:14px;line-height:1.65;color:#303641;margin:0 0 8px"><strong style="color:#1F2A44">Payment 2 — 50% production deposit (${esc(fmtUSD(productionDeposit))}).</strong> Once you approve the CAD, this deposit starts production of your finished ring.</p>
        <p style="font-size:14px;line-height:1.65;color:#303641;margin:0"><strong style="color:#1F2A44">Payment 3 — Remaining balance.</strong> Due when your ring ships (3–4 weeks after production deposit), fully insured via Parcel Pro.</p>
      </div>

      <p style="font-size:15px;line-height:1.65;color:#303641;margin:0 0 14px">Ready to get started? Your next step is the <strong>$100 design deposit</strong> below.</p>

      <div style="margin:28px 0;border:2px solid #D9B48C;border-radius:10px;padding:26px;text-align:center;background:#FAF7F2">
        <div style="color:#D9B48C;font-size:11px;letter-spacing:3px;text-transform:uppercase;font-weight:600;margin-bottom:8px">Lock In Your Design</div>
        <div style="font-family:Georgia,serif;font-size:36px;color:#1F2A44;font-weight:600;margin-bottom:4px">${esc(fmtUSD(cadDeposit))}</div>
        <div style="color:#707683;font-size:13px;margin-bottom:18px">Custom 3D CAD + 3 free revisions · Applied to your final price</div>
        <a href="mailto:${esc(replyTo)}?subject=${encodeURIComponent('Ready to start my CAD design — ' + (lead.name || ''))}" style="display:inline-block;background:#2E5C4A;color:#fff;text-decoration:none;padding:16px 40px;border-radius:6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;font-weight:500">Reply to Start Your Design</a>
        <div style="color:#9098a5;font-size:11px;margin-top:14px;letter-spacing:.5px">Secure payment link coming soon · In the meantime, reply and we'll send instructions</div>
      </div>

      <div style="margin:28px 0;padding:22px 24px;background:#fff;border:1px solid #E9E4DA;border-radius:10px">
        <div style="color:#2E5C4A;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 14px;font-weight:600;text-align:center">Your full timeline</div>
        <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">
          <tr>
            <td style="vertical-align:top;padding:8px 0;width:36px"><div style="width:26px;height:26px;border-radius:50%;background:#D9B48C;color:#fff;font-size:13px;font-weight:600;text-align:center;line-height:26px">1</div></td>
            <td style="padding:8px 0 8px 12px"><div style="font-size:14px;color:#1F2A44;font-weight:600;margin-bottom:2px">Lock in your design — ${esc(fmtUSD(cadDeposit))}</div><div style="font-size:13px;color:#707683;line-height:1.5">Custom CAD with 3 free revisions until it's exactly right.</div></td>
          </tr>
          <tr>
            <td style="vertical-align:top;padding:8px 0"><div style="width:26px;height:26px;border-radius:50%;background:#D9B48C;color:#fff;font-size:13px;font-weight:600;text-align:center;line-height:26px">2</div></td>
            <td style="padding:8px 0 8px 12px"><div style="font-size:14px;color:#1F2A44;font-weight:600;margin-bottom:2px">Approve CAD → begin production — 50%</div><div style="font-size:13px;color:#707683;line-height:1.5">${esc(fmtUSD(productionDeposit))} deposit starts your ring. Balance due at shipping.</div></td>
          </tr>
          <tr>
            <td style="vertical-align:top;padding:8px 0"><div style="width:26px;height:26px;border-radius:50%;background:#D9B48C;color:#fff;font-size:13px;font-weight:600;text-align:center;line-height:26px">3</div></td>
            <td style="padding:8px 0 8px 12px"><div style="font-size:14px;color:#1F2A44;font-weight:600;margin-bottom:2px">Ring at your door — 3–4 weeks</div><div style="font-size:13px;color:#707683;line-height:1.5">Shipped directly to your home, fully insured via Parcel Pro.</div></td>
          </tr>
        </table>
      </div>

      <p style="text-align:center;color:#707683;font-size:13px">Prefer to talk first? Just reply to this email — it comes straight to Kelsey.</p>

      <div style="font-size:11px;color:#9098a5;font-style:italic;margin-top:20px;line-height:1.55">This estimate is valid for 14 days and reflects current precious-metal market prices at time of quoting. Final invoice may vary slightly if metal markets shift significantly before production begins.</div>
    </div>

    <div style="padding:22px 40px;background:#FAF7F2;color:#707683;font-size:12px;text-align:center;border-top:1px solid #E9E4DA">
      The Ring Collective · Custom engagement rings, handcrafted with care<br>
      <a href="mailto:${esc(replyTo)}" style="color:#2E5C4A;text-decoration:none">${esc(replyTo)}</a>
    </div>
  </div>
</body></html>`;

  // Plain-text fallback
  const textLines = [
    `Hi ${first},`,
    '',
    'Thank you for sending your inspiration over — here is your personalized estimate:',
    '',
    ...detailRows.map(([k, v]) => `${k}: ${v}`),
    `Estimated Total: ${fmtUSD(total)}`,
    '',
    'A note from Kelsey G., Founder:',
    'We know a ring is not just jewelry — it is a symbol of one of the most important moments of your life. Over the years we have had the honor of making more than 10,000 rings for couples who found their "yes," and we would be so grateful for the chance to make yours next.',
    '',
    `Next step — Lock in your design: ${fmtUSD(cadDeposit)}. We build a custom 3D CAD of your ring with up to 3 free revisions. The $100 applies toward your final price.`,
    '',
    'Your full timeline:',
    `  1. Lock in your design — ${fmtUSD(cadDeposit)} (CAD + 3 free revisions)`,
    `  2. Approve CAD → begin production — 50% (${fmtUSD(productionDeposit)}); balance due at shipping`,
    `  3. Ring at your door — 3–4 weeks, shipped insured via Parcel Pro`,
    '',
    `Reply to this email to start your CAD design or ask any questions — it goes straight to Kelsey.`,
    '',
    'With gratitude,',
    'Kelsey G.',
    'Founder, The Ring Collective',
  ];

  return { html, text: textLines.join('\n') };
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
  const respText = await resp.text();
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${respText}`);
  return respText ? JSON.parse(respText) : null;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, headers, { error: 'Invalid JSON' }); }

  const { id, password, total: totalIn } = body;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return json(500, headers, { error: 'ADMIN_PASSWORD not set' });
  if (password !== adminPassword) return json(401, headers, { error: 'Invalid password' });
  if (!id) return json(400, headers, { error: 'id required' });
  if (typeof totalIn !== 'number' || totalIn <= 0) return json(400, headers, { error: 'valid total required' });

  try {
    const lead = await getLead(id);
    if (!lead) return json(404, headers, { error: 'lead not found' });
    if (!lead.email) return json(400, headers, { error: 'lead has no email' });

    const replyTo = process.env.NOTIFY_TO || 'sales@theringcollective.net';
    const { html, text } = buildQuoteEmail(lead, totalIn, replyTo);
    const subject = `Your custom ring estimate — The Ring Collective`;
    const from = process.env.NOTIFY_FROM || 'Ring Collective <leads@theringcollective.net>';

    const result = await sendEmail({
      to: lead.email,
      from,
      subject,
      text,
      html,
      replyTo,
    });

    // Persist: round total to whole dollars for the DB column (integer), mark status quoted.
    await updateLead(id, {
      status: 'quoted',
      quote_total: Math.round(totalIn),
    });

    return json(200, headers, { ok: true, id: result && result.id });
  } catch (err) {
    console.error('send-quote error:', err);
    return json(500, headers, { ok: false, error: String(err.message || err) });
  }
};
