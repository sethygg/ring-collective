// netlify/functions/maya-followup.js
//
// Scheduled function — runs every hour. Finds leads in the Maya follow-up
// sequence that are due for a touch, asks Claude to write a personalized
// email as Maya Reyes, and sends it via Resend.
//
// Sequence cadence (hours after quote sent): [24, 72, 168] → touches 1, 2, 3.
// After touch 3, sequence auto-completes. Any time the lead flips status
// (won/lost) or unsubscribes, the sequence stops.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   ANTHROPIC_API_KEY
//   MAYA_FROM           — e.g. "Maya Reyes <maya@theringcollective.net>"
//   SALES_REPLY_TO      — e.g. "sales@theringcollective.net"
//   SITE_URL            — e.g. "https://theringcollective.netlify.app" (for unsubscribe link)

const CLAUDE_MODEL = 'claude-sonnet-4-5';

// Hours after quote sent for each touch
const CADENCE_HOURS = [24, 72, 168];

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
  return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
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

// Find leads ready to be touched right now.
async function findDueLeads() {
  const nowIso = new Date().toISOString();
  const q = new URLSearchParams({
    select: '*',
    auto_sequence_enabled: 'eq.true',
    status: 'eq.quoted',
    unsubscribed_at: 'is.null',
    next_touch_at: `lte.${nowIso}`,
    'touch_count': 'lt.3',
    limit: '25',
  });
  return sbFetch(`/rest/v1/quote_requests?${q.toString()}`);
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

// Build the Claude prompt for a given touch.
function buildPrompt(lead, touchNumber) {
  const first = (lead.name || '').split(' ')[0] || 'there';

  const stoneBits = [];
  if (lead.diamond_carat) stoneBits.push(`${lead.diamond_carat}ct`);
  if (lead.shape) stoneBits.push(lead.shape);
  if (lead.stone_type) stoneBits.push(lead.stone_type);
  const stone = stoneBits.join(' ') || lead.stone_category || 'center stone';

  const metal = [lead.karat, lead.metal].filter(Boolean).join(' ') || 'metal';
  const setting = lead.setting_style ? lead.setting_style.replace(/-/g, ' ') : null;
  const total = lead.quote_total ? fmtUSD(lead.quote_total) : null;

  // Different angle for each touch so the three emails don't feel repetitive
  const angles = {
    1: `GENTLE CHECK-IN. Warm, light, 2-3 short paragraphs max. Acknowledge their estimate landed in their inbox. Offer to answer any questions — about the stone, the metal, anything. Mention that the next step whenever they are ready is just the $100 design deposit to start their custom CAD. No urgency, no pressure. End with a soft question like "Is there anything I can help make clearer?" that invites reply.`,
    2: `VALUE + TRUST ANGLE. Still warm, not pushy. Remind them briefly that The Ring Collective is the workshop that has been crafting custom rings for retail jewelers for over a decade — so the price they are seeing is the same price a jewelry store would pay us wholesale. 2-3 short paragraphs. Can mention that lab diamonds vs moissanite can shift the total if budget is a factor. Close with "happy to hop on a quick call if easier than email."`,
    3: `LAST SOFT NUDGE. This is the final outreach. Acknowledge gently that they may have chosen another direction or the timing is not right. Make it easy to say "not right now" without feeling bad. Reaffirm the quote is still valid if they want to come back, and that Maya would genuinely love to help when they are ready. 2 short paragraphs. Close with "either way, wishing you the best with this — it is a big moment."`,
  };

  return `You are Maya Reyes, Client Experience Lead at The Ring Collective, a custom engagement ring workshop. You are writing a follow-up email to a couple who received their personalized ring estimate ${Math.round((Date.now() - new Date(lead.last_touch_at || lead.created_at).getTime()) / (1000*60*60))} hours ago and has not replied.

TONE: Warm, human, quietly confident. Never pushy. You work at a boutique atelier, not a call center. Think thoughtful small-business owner, not sales rep. Use contractions. Vary sentence length. Avoid corporate phrases like "circling back," "just following up," "touching base," "at your earliest convenience." Avoid em dashes.

THIS SPECIFIC TOUCH — ${angles[touchNumber]}

CUSTOMER CONTEXT (use naturally, don't dump all of it):
- First name: ${first}
- Their design: ${stone} in ${metal}${setting ? `, ${setting} setting` : ''}
${total ? `- Estimated total: ${total}` : ''}
- Next step for them: $100 design deposit (starts their custom 3D CAD with 3 free revisions; applies to final price)

HARD RULES:
- Do NOT quote a different price or discount.
- Do NOT promise any timeline not in the original quote.
- Do NOT pretend you remember a conversation you did not have.
- Do NOT use exclamation points more than once.
- Do NOT reference that you are an AI or a sequence or a system.
- Sign off as: Maya
- Do NOT add a title under "Maya" — that goes in the signature block (added separately).
- Do NOT include a subject line in the body.

Return valid JSON only, in this exact shape:
{"subject": "...", "body": "..."}

The body should be plain text (no HTML). Use blank lines between paragraphs. Keep it short: 80-130 words total.`;
}

async function askClaude(prompt) {
  const key = requireEnv('ANTHROPIC_API_KEY');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Claude ${resp.status}: ${text}`);
  const parsed = JSON.parse(text);
  const content = parsed.content && parsed.content[0] && parsed.content[0].text;
  if (!content) throw new Error('Claude returned no content');
  // Claude sometimes wraps JSON in code fences; strip them
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

function wrapEmail(lead, bodyText, unsubscribeUrl) {
  const paragraphs = bodyText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const htmlParagraphs = paragraphs
    .map(p => `<p style="font-size:15px;line-height:1.65;color:#303641;margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;background:#fff;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;padding:32px 20px;color:#22252b">
  <div style="max-width:560px;margin:0 auto">
    ${htmlParagraphs}
    <div style="margin-top:24px;font-size:15px;color:#22252b;line-height:1.5">
      Maya<br>
      <span style="color:#707683;font-size:13px">Maya Reyes · Client Experience Lead<br>The Ring Collective</span>
    </div>
    <div style="margin-top:42px;padding-top:18px;border-top:1px solid #EFEBE3;font-size:11px;color:#a0a6b1;line-height:1.5">
      You're receiving this because you requested a custom ring quote from The Ring Collective.<br>
      <a href="${esc(unsubscribeUrl)}" style="color:#a0a6b1;text-decoration:underline">Unsubscribe from follow-ups</a>
    </div>
  </div>
</body></html>`;

  const text = paragraphs.join('\n\n') +
    '\n\nMaya\nMaya Reyes · Client Experience Lead\nThe Ring Collective\n\n—\nUnsubscribe: ' + unsubscribeUrl;

  return { html, text };
}

async function sendEmail({ to, from, replyTo, subject, html, text }) {
  const key = requireEnv('RESEND_API_KEY');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, reply_to: replyTo, subject, html, text }),
  });
  const respText = await resp.text();
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${respText}`);
  return respText ? JSON.parse(respText) : null;
}

function nextTouchAt(touchCount) {
  // touchCount is the number of touches already SENT (0, 1, 2)
  if (touchCount >= CADENCE_HOURS.length) return null;
  const hours = CADENCE_HOURS[touchCount];
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function processLead(lead) {
  const touchNumber = lead.touch_count + 1; // 1, 2, or 3
  const prompt = buildPrompt(lead, touchNumber);
  const { subject, body } = await askClaude(prompt);

  const siteUrl = process.env.SITE_URL || 'https://theringcollective.netlify.app';
  const unsubscribeUrl = `${siteUrl}/.netlify/functions/unsubscribe?id=${encodeURIComponent(lead.id)}`;

  const { html, text } = wrapEmail(lead, body, unsubscribeUrl);

  const from = process.env.MAYA_FROM || 'Maya Reyes <maya@theringcollective.net>';
  const replyTo = process.env.SALES_REPLY_TO || 'sales@theringcollective.net';

  const result = await sendEmail({ to: lead.email, from, replyTo, subject, html, text });

  // Append to sequence log
  const logEntry = {
    touch: touchNumber,
    sent_at: new Date().toISOString(),
    subject,
    resend_id: result && result.id,
  };
  const newLog = [...(lead.sequence_log || []), logEntry];

  const nextCount = lead.touch_count + 1;
  const patch = {
    touch_count: nextCount,
    last_touch_at: new Date().toISOString(),
    next_touch_at: nextTouchAt(nextCount),
    sequence_log: newLog,
  };
  if (nextCount >= CADENCE_HOURS.length) {
    patch.auto_sequence_enabled = false; // sequence complete
  }

  await updateLead(lead.id, patch);
  return { id: lead.id, touch: touchNumber, subject };
}

// Fetch a single lead by id (used by the manual test hook below)
async function fetchLeadById(id) {
  const rows = await sbFetch(`/rest/v1/quote_requests?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

exports.handler = async (event) => {
  try {
    // Manual testing hook:  /.netlify/functions/maya-followup?leadId=<uuid>&key=<ADMIN_PASSWORD>
    // Bypasses the next_touch_at gate so you can fire a follow-up on demand.
    const qs = event.queryStringParameters || {};
    if (qs.leadId) {
      if (qs.key !== process.env.ADMIN_PASSWORD) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'bad key' }) };
      }
      const lead = await fetchLeadById(qs.leadId);
      if (!lead) return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'lead not found' }) };
      if (!lead.email) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'lead has no email' }) };
      if (lead.touch_count >= 3) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'sequence complete' }) };
      const r = await processLead(lead);
      return { statusCode: 200, body: JSON.stringify({ ok: true, manual: true, result: r }) };
    }

    const leads = await findDueLeads();
    if (!leads || leads.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, processed: 0 }) };
    }

    const results = [];
    const errors = [];
    for (const lead of leads) {
      try {
        if (!lead.email) continue;
        const r = await processLead(lead);
        results.push(r);
      } catch (err) {
        console.error(`Failed for lead ${lead.id}:`, err);
        errors.push({ id: lead.id, error: String(err.message || err) });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, processed: results.length, results, errors }),
    };
  } catch (err) {
    console.error('maya-followup fatal:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};

// Netlify scheduled function — runs every hour
exports.config = { schedule: '@hourly' };
