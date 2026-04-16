// netlify/functions/chat-ai.js
//
// Multi-turn concierge for the home-page chat widget. Claude Haiku 4.5
// answers tier-1 questions directly (process, materials, policies,
// pricing ranges). For tier-2 questions (specific stone sourcing,
// heirloom stones, existing quotes, payment terms, complaints, specific
// final prices, or anything requiring human judgment) Claude calls the
// escalate_to_kelsey tool, which emails Kelsey via Resend with reply-to
// set to the customer and returns an acknowledgment for the chat UI.
//
// Request body: { messages: [{role:'user'|'assistant', content:string}], page?:string }
// Response:     { type: 'reply'|'escalated'|'error', message: string, email?: string }
//
// Env vars:
//   ANTHROPIC_API_KEY         — for Claude API
//   RESEND_API_KEY            — for escalation emails
//   NOTIFY_TO                 — Kelsey/Seth's inbox
//   NOTIFY_FROM               — optional; defaults to Resend sandbox

const ALLOWED_ORIGINS = [
  /^https?:\/\/theringcollective\.netlify\.app$/i,
  /^https?:\/\/theringcollective\.co$/i,
  /^https?:\/\/www\.theringcollective\.co$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];

// Per-IP rate limit: 30 messages / 10 min. Chat is chatty so a bit looser than detect-ring.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 30;
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

// Scan the conversation history (most recent first) for an email address.
// Used as a safety net when Claude calls escalate_to_kelsey without passing
// customer_email — the customer almost certainly typed one in a recent turn.
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
function findEmailInMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
    const match = m.content.match(EMAIL_REGEX);
    if (match) return match[0];
  }
  return null;
}
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Server misconfigured: ${name} missing.`);
  return v;
}

// ===== System prompt — the concierge's knowledge & behavior =====
const SYSTEM_PROMPT = `You are the concierge for The Ring Collective, a direct-to-consumer custom engagement ring business. You answer customer questions in a chat widget on the website.

# About The Ring Collective
- 30+ years of combined craftsmanship. We've spent our careers making custom rings for retail jewelry stores; now we sell direct to couples.
- Our pricing is roughly 50% below retail because we skip the storefront markup. Same quality, jeweler pricing.
- Kelsey is the design specialist who handles direct customer communication. When a question needs a human, you escalate to her.

# The Process
1. Customer uses the online quote builder, or uploads a reference photo (our AI identifies shape, metal, setting, and accent diamonds). A detailed quote lands in their inbox within 24 hours.
2. Once the budget is agreed, we build a custom 3D CAD rendering. Three free revisions. No stone is cut until the CAD is approved.
3. Production takes 3–4 weeks. Ships fully insured, both directions.

# Materials
- Center stones: lab diamonds (IGI/GIA certified), mined diamonds, moissanite, sapphires, and other colored gems.
- Lab diamonds are physically and chemically identical to mined diamonds. Same 4Cs grading. Roughly 50–70% less expensive. We recommend them for engagement rings — you can afford a larger, better stone at the same budget.
- Metals: 14k and 18k white gold, yellow gold, rose gold, and platinum. Platinum and white gold look nearly identical; platinum is denser and more expensive.
- Center stone shapes we cut: Round, Oval, Emerald, Cushion, Pear, Princess, Marquise, Radiant.
- Setting styles: solitaire, halo, pavé, three-stone. Plus band accent patterns (shoulders, half-eternity, three-quarter-eternity, full-eternity) and hidden halos.

# General Pricing Ranges (NEVER quote a specific final price)
- Typical lab-diamond engagement rings: $2,500–$6,000 depending on carat, metal, setting, and accents.
- Moissanite rings start around $1,500.
- Platinum adds cost over gold due to material price.
- For a specific itemized quote, always direct the customer to the quote builder (quote-builder-c.html) or escalate to Kelsey.

# Policies
- Lifetime warranty on craftsmanship.
- Free resizing within 12 months of purchase.
- 30-day return window.
- Fully insured shipping, both directions.
- All diamonds are GIA or IGI certified.

# Behavior rules
- Warm, knowledgeable, never pushy. You're a helpful concierge, not a salesperson.
- Short replies — 2–4 sentences typically. Only go longer when the question truly requires it.
- NEVER fabricate specifics (don't invent prices, stone availability, timelines for specific orders, team names, etc.).
- NEVER quote a specific final price for a specific configuration. Give ranges, then point them to the quote builder or escalate to Kelsey for a firm number.
- Plain language. Avoid jargon. Don't use the phrase "master bench."
- HTML links are fine: <a href="quote-builder-c.html">start your quote</a>. Use relative paths only.
- Plain text only — no markdown, headers, or bullet lists unless a list is genuinely needed for clarity.
- If the customer writes in another language, reply in that language.

# When to escalate (call the escalate_to_kelsey tool)
Escalate when the question requires human judgment or a commitment only Kelsey can make. Always escalate for:
- Sourcing a specific stone ("can you find me a 3ct F-VS1 oval")
- Using a family heirloom stone or resetting an existing ring
- Anything about an existing quote, order, or CAD revision
- Payment terms, financing, or rush production
- Complaints or issues with a current order
- A request for a specific firm price (not a range) for a specific configuration
- Explicit request for a human, designer, or Kelsey
- Requests outside standard process (engraving, mixed metals, unusual shapes, special deadlines)
- Any question where you're not confident in your answer

Before calling the tool, if you don't already have the customer's email address anywhere in this conversation, ask for it in a normal message first. DO NOT call the tool without an email — we can't reply without one.

CRITICAL — how to fill in customer_email when you call the tool:
- Scan the WHOLE conversation, not just the last message. The customer may have given their email several turns ago.
- If any user message contains a string matching name@domain.tld, that IS the customer's email — pass it verbatim as customer_email.
- If the user's most recent message is just an email address (e.g. "sethkgilbert@gmail.com"), that is them answering your request for their email — use it directly.
- NEVER call escalate_to_kelsey with customer_email missing, empty, or a placeholder like "unknown" or "n/a". If no email exists anywhere in the transcript, do not call the tool — ask for the email in plain text instead.

When you DO call the tool, ALSO write a short text message to the customer (in the same turn) acknowledging that you're pulling Kelsey in and that she'll reply by email shortly.

# When NOT to escalate
Handle these yourself: process/timeline questions, lab vs mined explanations, 4Cs questions, metal/setting/shape explanations, general price ranges, warranty/return/shipping policy, how to use the quote builder or photo uploader, ring sizing tips.`;

// ===== Tool definition =====
const TOOLS = [
  {
    name: 'escalate_to_kelsey',
    description: "Escalate the conversation to Kelsey (the human design specialist) when the customer's question requires human judgment — sourcing a specific stone, heirloom stones, existing orders, payment terms, firm pricing for a specific configuration, complaints, or explicit request for a human. Only call this AFTER you have captured the customer's email in the conversation.",
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why this needs human attention, in one short sentence. Example: "Customer wants to source a specific heirloom stone."',
        },
        summary: {
          type: 'string',
          description: "1–2 sentence summary of what the customer is asking for, so Kelsey has context without reading the full chat.",
        },
        customer_email: {
          type: 'string',
          description: "Customer's email address as provided in the conversation. REQUIRED — do not call this tool without one.",
        },
        customer_name: {
          type: 'string',
          description: "Customer's first name if they've shared it.",
        },
        urgency: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'Low = general follow-up; normal = standard inquiry; high = existing order issue or time-sensitive.',
        },
      },
      required: ['reason', 'summary', 'customer_email'],
    },
  },
];

// ===== Escalation: send the email to Kelsey/Seth =====
async function emailEscalation({ reason, summary, customer_email, customer_name, urgency, messages, page, ip }) {
  const key = requireEnv('RESEND_API_KEY');
  const to   = requireEnv('NOTIFY_TO');
  const from = process.env.NOTIFY_FROM || 'Ring Collective <onboarding@resend.dev>';

  const transcript = (messages || []).map(m =>
    `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
  ).join('\n\n');

  const rows = [
    ['Customer',   customer_name ? `${customer_name} <${customer_email}>` : customer_email],
    ['Urgency',    urgency || 'normal'],
    ['Reason',     reason],
    ['Summary',    summary],
    ['Page',       page || '—'],
    ['IP',         ip || '—'],
    ['Time',       new Date().toISOString()],
  ];
  const rowsHtml = rows.map(([k, v]) => `
    <tr>
      <td style="padding:5px 14px 5px 0;color:#707683;font-size:12px;vertical-align:top">${esc(k)}</td>
      <td style="padding:5px 0;color:#22252b;font-size:13px">${esc(v)}</td>
    </tr>
  `).join('');

  const subject = `Chat escalation${urgency === 'high' ? ' [HIGH]' : ''} — ${customer_email}: ${String(summary).slice(0, 60)}`;

  const text = [
    `Claude escalated a chat to you.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    '--- Conversation transcript ---',
    transcript,
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',Arial,sans-serif;background:#FAF7F2;padding:28px 20px">
      <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #E9E4DA;border-radius:8px;overflow:hidden">
        <div style="padding:20px 26px;border-bottom:1px solid #E9E4DA;background:${urgency === 'high' ? '#b3321c' : '#1F2A44'};color:#fff">
          <div style="font-family:'Playfair Display',Georgia,serif;font-size:18px">The Ring Collective</div>
          <div style="color:#D9B48C;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:2px">Chat Escalation${urgency === 'high' ? ' &middot; HIGH' : ''}</div>
        </div>
        <div style="padding:22px 26px">
          <div style="background:#FAF7F2;border-left:3px solid #D9B48C;padding:12px 14px;margin-bottom:16px;font-size:13px;line-height:1.6;color:#2A3654">
            <div style="font-weight:600;color:#1F2A44;margin-bottom:4px">${esc(summary)}</div>
            <div style="color:#666;font-size:12px">Reason: ${esc(reason)}</div>
          </div>
          <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin-bottom:18px">${rowsHtml}</table>
          <details style="margin-bottom:18px">
            <summary style="cursor:pointer;color:#2E5C4A;font-size:13px;font-weight:600">View full conversation transcript</summary>
            <pre style="background:#FAF7F2;padding:12px;border-radius:4px;font-size:12px;line-height:1.5;color:#2A3654;white-space:pre-wrap;margin-top:8px">${esc(transcript)}</pre>
          </details>
          <a href="mailto:${esc(customer_email)}" style="display:inline-block;background:#2E5C4A;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;letter-spacing:1px;text-transform:uppercase">Reply to ${esc(customer_email)}</a>
        </div>
      </div>
    </div>`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text, html, reply_to: customer_email }),
  });
  const bodyText = await resp.text();
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${bodyText}`);
  return bodyText ? JSON.parse(bodyText) : null;
}

// ===== Claude call =====
async function callClaude(messages) {
  const key = requireEnv('ANTHROPIC_API_KEY');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${errText}`);
  }
  return resp.json();
}

// ===== Main handler =====
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
      body: JSON.stringify({ type: 'error', message: 'Too many messages — please try again in a few minutes.' }),
    };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers, body: 'Invalid JSON' }; }

  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const page = typeof payload.page === 'string' ? payload.page.slice(0, 200) : '';

  // Sanitize the conversation: only keep user/assistant roles with string content,
  // cap each message at 4000 chars, cap history at the last 20 turns.
  const messages = rawMessages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return {
      statusCode: 400,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'error', message: 'Expected last message to be from user.' }),
    };
  }

  try {
    const data = await callClaude(messages);
    const blocks = Array.isArray(data.content) ? data.content : [];
    const textBlocks = blocks.filter(b => b.type === 'text').map(b => b.text).filter(Boolean);
    const toolUse = blocks.find(b => b.type === 'tool_use' && b.name === 'escalate_to_kelsey');

    const replyText = textBlocks.join('\n\n').trim()
      || (toolUse
          ? "I'm pulling in Kelsey on this one — she'll get back to you by email shortly."
          : "Sorry, I blanked for a second. Could you rephrase that?");

    if (toolUse) {
      const input = toolUse.input || {};
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      // Claude sometimes forgets to pass customer_email even when the customer
      // has clearly given it. If the tool input is missing or malformed, fall
      // back to scanning the transcript ourselves.
      let customerEmail = typeof input.customer_email === 'string'
        ? input.customer_email.trim()
        : '';
      if (!emailRegex.test(customerEmail)) {
        const extracted = findEmailInMessages(messages);
        console.log('chat-ai: tool called without valid customer_email', {
          tool_input: input,
          extracted_from_transcript: extracted,
        });
        if (extracted) {
          customerEmail = extracted;
        }
      }

      // If even the transcript doesn't have an email, downgrade to a polite
      // ask instead of silently dropping the escalation.
      if (!emailRegex.test(customerEmail)) {
        console.log('chat-ai: escalation downgraded — no email found anywhere');
        return {
          statusCode: 200,
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'reply',
            message: "I'd love to loop Kelsey in on this — can you drop your email so she can reply?",
          }),
        };
      }

      try {
        await emailEscalation({
          reason: input.reason || 'Customer question needs human review.',
          summary: input.summary || 'See transcript.',
          customer_email: customerEmail,
          customer_name: input.customer_name,
          urgency: input.urgency || 'normal',
          messages,
          page,
          ip,
        });
      } catch (emailErr) {
        console.error('escalation email failed:', emailErr);
        // Still return success to the user — Kelsey can check the chat log tool later.
      }

      return {
        statusCode: 200,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'escalated',
          message: replyText,
          email: customerEmail,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'reply', message: replyText }),
    };
  } catch (err) {
    console.error('chat-ai error:', err);
    return {
      statusCode: 500,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'error',
        message: "I hit a snag on my end. Mind trying that again? Or email us directly and we'll sort it out.",
      }),
    };
  }
};
