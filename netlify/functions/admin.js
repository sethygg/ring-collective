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
  /^https?:\/\/theringcollective\.co$/i,
  /^https?:\/\/www\.theringcollective\.co$/i,
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

// --- Factory packet ------------------------------------------------------
//
// Transforms a quote_requests row into the structured info the factory
// needs (metal / purity / color / size / center stone / accents / photos).
// Used by `preview_factory_packet` (admin modal) and `send_to_factory`
// (email it out).

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

function parseBudgetUsd(budget) {
  if (budget == null) return null;
  const n = Number(String(budget).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Lab-diamond grade auto-rule based on budget.
// Every Ring Collective lab diamond is IGI certified; grade auto-standardizes.
function diamondGradeForBudget(budgetUsd) {
  if (budgetUsd == null) {
    return { color: 'D\u2013F', clarity: 'VVS1 (standard)', notes: '' };
  }
  if (budgetUsd < 3000) {
    return { color: 'D\u2013F', clarity: 'VVS2', notes: '' };
  }
  if (budgetUsd <= 6000) {
    return { color: 'D\u2013F', clarity: 'VVS1', notes: '' };
  }
  return { color: 'D\u2013F', clarity: 'VVS1', notes: 'Upgrade to IF if available in stock.' };
}

// Break `metal` + `karat` into the three fields the factory wants:
//   type    — Silver | Gold | Platinum | Other
//   purity  — 925 | 10K | 14K | 18K | — | (free text)
//   color   — Yellow | White | Rose | — (gold only)
function splitMetal(lead) {
  const metal = String(lead.metal || '').trim();
  const karat = String(lead.karat || '').trim();

  if (/^silver/i.test(metal)) {
    return { type: 'Silver', purity: '925', color: '\u2014' };
  }
  if (/platinum/i.test(metal)) {
    return { type: 'Platinum', purity: '\u2014', color: '\u2014' };
  }
  const goldColor = (metal.match(/^(Yellow|White|Rose)/i) || [])[1] || '';
  if (goldColor) {
    return {
      type: 'Gold',
      purity: karat || '14K',
      color: goldColor.charAt(0).toUpperCase() + goldColor.slice(1).toLowerCase(),
    };
  }
  // Fallback — unknown metal string; dump what we have.
  return {
    type: metal || '\u2014',
    purity: karat || '\u2014',
    color: '\u2014',
  };
}

// -------------------------------------------------------------------------
// CT → MM converter for center stones.
//
// The factory quotes stones in millimeters, but customers pick a carat weight.
// For each shape we keep a short anchor table of (ct → mm) derived from the
// industry-standard faceted-diamond size charts (GIA/Blue Nile). For fancy
// shapes the mm value is a [length, width] pair reflecting a typical ratio.
// We linearly interpolate between the two nearest anchors; out-of-range carats
// clamp to the end anchors.
//
// Moissanite and CZ suppliers generally quote in diamond-equivalent weight
// (DEW), so the diamond table works for them too; colored-stone densities
// vary, so we label the MM row "approx" for non-diamond stones.
// -------------------------------------------------------------------------

// Round: single diameter (mm).
const MM_TABLE_ROUND = [
  [0.25, 4.1], [0.33, 4.4], [0.50, 5.2], [0.75, 5.8],
  [1.00, 6.5], [1.25, 6.9], [1.50, 7.4], [1.75, 7.8],
  [2.00, 8.1], [2.50, 8.8], [3.00, 9.3], [4.00, 10.2],
];

// Fancy shapes: [length, width] in mm at a typical ratio.
const MM_TABLE_FANCY = {
  Oval:     [[0.50,[6.0,4.0]],[0.75,[6.5,4.5]],[1.00,[7.0,5.0]],[1.25,[7.7,5.5]],[1.50,[8.0,6.0]],[2.00,[9.0,7.0]],[3.00,[10.5,8.0]]],
  Emerald:  [[0.50,[5.5,3.5]],[0.75,[6.0,4.0]],[1.00,[7.0,5.0]],[1.25,[7.3,5.3]],[1.50,[7.5,5.5]],[2.00,[8.5,6.5]],[3.00,[9.3,7.5]]],
  Cushion:  [[0.50,[5.0,5.0]],[0.75,[5.5,5.5]],[1.00,[5.8,5.8]],[1.25,[6.0,6.0]],[1.50,[6.5,6.5]],[2.00,[7.3,7.3]],[3.00,[8.4,8.4]]],
  Pear:     [[0.50,[6.0,4.0]],[0.75,[7.0,5.0]],[1.00,[7.7,5.4]],[1.25,[8.0,5.5]],[1.50,[8.5,6.0]],[2.00,[10.0,6.5]],[3.00,[11.0,7.5]]],
  Princess: [[0.50,[4.5,4.5]],[0.75,[5.0,5.0]],[1.00,[5.5,5.5]],[1.25,[6.0,6.0]],[1.50,[6.5,6.5]],[2.00,[7.0,7.0]],[3.00,[8.0,8.0]]],
  Marquise: [[0.50,[8.0,4.0]],[0.75,[9.0,4.5]],[1.00,[10.0,5.0]],[1.25,[11.0,5.5]],[1.50,[12.0,6.0]],[2.00,[13.0,6.5]],[3.00,[14.5,7.5]]],
  Radiant:  [[0.50,[5.0,4.0]],[0.75,[5.5,4.5]],[1.00,[6.0,5.0]],[1.25,[6.5,5.5]],[1.50,[7.0,5.5]],[2.00,[8.0,6.5]],[3.00,[9.0,7.5]]],
};

function normalizeShape(shape) {
  const s = String(shape || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('round')) return 'Round';
  if (s.startsWith('oval')) return 'Oval';
  if (s.startsWith('emerald')) return 'Emerald';
  if (s.startsWith('cushion')) return 'Cushion';
  if (s.startsWith('pear')) return 'Pear';
  if (s.startsWith('princess')) return 'Princess';
  if (s.startsWith('marquise')) return 'Marquise';
  if (s.startsWith('radiant')) return 'Radiant';
  if (s.startsWith('asscher')) return 'Princess';  // square step-cut, close enough
  if (s.startsWith('heart'))   return 'Cushion';   // square-ish fallback
  return null;
}

// Linear interpolate between two (ct, value) anchors. `value` may be a scalar
// (Round) or a [length, width] array (fancy shapes).
function interpolateMm(table, ct) {
  if (ct <= table[0][0]) return table[0][1];
  if (ct >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [a, av] = table[i];
    const [b, bv] = table[i + 1];
    if (ct >= a && ct <= b) {
      const t = (ct - a) / (b - a);
      if (Array.isArray(av)) {
        return [av[0] + (bv[0] - av[0]) * t, av[1] + (bv[1] - av[1]) * t];
      }
      return av + (bv - av) * t;
    }
  }
  return table[table.length - 1][1];
}

// Returns a factory-friendly mm string, or null if we can't estimate.
// e.g. "6.5 mm" for Round, "7.0 \u00d7 5.0 mm" for fancy shapes.
function caratToMm(shape, caratRaw) {
  const ct = Number(caratRaw);
  if (!Number.isFinite(ct) || ct <= 0) return null;
  const norm = normalizeShape(shape);
  if (!norm) return null;
  if (norm === 'Round') {
    const mm = interpolateMm(MM_TABLE_ROUND, ct);
    return `${mm.toFixed(1)} mm`;
  }
  const table = MM_TABLE_FANCY[norm];
  if (!table) return null;
  const [l, w] = interpolateMm(table, ct);
  return `${l.toFixed(1)} \u00d7 ${w.toFixed(1)} mm`;
}

// Lab diamond / Moissanite / CZ / colored — normalize + flag grading-relevant rows.
function classifyStone(lead) {
  const raw = String(lead.stone_type || lead.stone_category || '').trim();
  const lower = raw.toLowerCase();
  const isLabDiamond = /lab.*diamond/.test(lower) || lower === 'diamond';
  const isMoissanite = /moissanite/.test(lower);
  const isCZ         = /\bcz\b|cubic zirconia/.test(lower);
  const isColored    = lead.stone_category === 'colored' || (!isLabDiamond && !isMoissanite && !isCZ && raw !== '');
  return { raw: raw || 'Unknown', isLabDiamond, isMoissanite, isCZ, isColored };
}

function buildAccentSummary(lead) {
  const pattern = lead.accent_pattern;
  const size    = lead.accent_melee_size;
  const tcw     = lead.estimated_accent_tcw;
  const count   = lead.estimated_accent_count;
  const hiddenHalo = !!lead.hidden_halo;

  if ((!pattern || pattern === 'none') && !hiddenHalo) {
    return { summary: 'None', pattern: 'None', size: '\u2014', count: '\u2014', tcw: '\u2014', hiddenHalo: 'No' };
  }
  const prettyPattern = pattern && pattern !== 'none'
    ? pattern.replace(/-/g, ' ')
    : 'None';
  return {
    summary: [
      prettyPattern !== 'None' ? prettyPattern : null,
      size && size !== 'none' ? `${size} melee` : null,
      count ? `~${count} stones` : null,
      tcw ? `~${Number(tcw).toFixed(2)} ct tcw` : null,
      hiddenHalo ? 'hidden halo' : null,
    ].filter(Boolean).join(' \u00b7 '),
    pattern: prettyPattern,
    size: size && size !== 'none' ? size : '\u2014',
    count: count ? String(count) : '\u2014',
    tcw: tcw ? `${Number(tcw).toFixed(2)} ct` : '\u2014',
    hiddenHalo: hiddenHalo ? 'Yes' : 'No',
  };
}

// Build a fully hydrated packet object. Includes signed photo URLs with a
// 30-day expiry so the factory can pull the images from the email.
// `overrideNotes` lets the admin modal pass the latest textarea value
// without needing to re-save to DB first; falls back to the stored value.
async function buildFactoryPacket(lead, overrideNotes) {
  const metal = splitMetal(lead);
  const stone = classifyStone(lead);
  const budget = parseBudgetUsd(lead.budget);
  const grade = stone.isLabDiamond ? diamondGradeForBudget(budget) : null;
  const accents = buildAccentSummary(lead);

  // Sign photo URLs — 30 days for factory convenience.
  const photos = [];
  for (const path of (lead.photo_paths || [])) {
    try {
      const url = await signedPhotoUrl(path, 30 * 24 * 3600);
      const label = (path.split('/').pop() || '').replace(/\.[^.]+$/, '');
      photos.push({ path, url, label: label || 'photo' });
    } catch (e) {
      photos.push({ path, url: null, label: 'photo', error: String(e.message || e) });
    }
  }

  // Compose the structured rows the packet will render.
  const referenceId = `RC-${String(lead.id || '').slice(0, 8).toUpperCase()}`;

  const mmSize = caratToMm(lead.shape, lead.diamond_carat);
  const mmLabel = stone.isLabDiamond || stone.isMoissanite
    ? 'Size (mm)'
    : 'Size (mm, approx)';
  const stoneRows = [
    ['Material',  stone.raw],
    ['Size',      lead.diamond_carat ? `${lead.diamond_carat} ct` : '\u2014'],
    ['Shape',     lead.shape || '\u2014'],
  ];
  if (mmSize) {
    stoneRows.push([mmLabel, mmSize]);
  }
  if (stone.isLabDiamond && grade) {
    stoneRows.push(['Color',   grade.color]);
    stoneRows.push(['Clarity', grade.clarity]);
    stoneRows.push(['Cert',    'Yes (IGI)']);
    if (grade.notes) stoneRows.push(['Notes', grade.notes]);
  } else if (stone.isMoissanite) {
    stoneRows.push(['Color',   '\u2014 (moissanite, n/a)']);
    stoneRows.push(['Clarity', '\u2014 (moissanite, n/a)']);
    stoneRows.push(['Cert',    '\u2014 (moissanite, n/a)']);
  } else if (stone.isCZ) {
    stoneRows.push(['Color',   '\u2014 (CZ, n/a)']);
    stoneRows.push(['Clarity', '\u2014 (CZ, n/a)']);
    stoneRows.push(['Cert',    '\u2014 (CZ, n/a)']);
  } else if (stone.isColored) {
    stoneRows.push(['Color',   lead.stone_type_note || '\u2014']);
    stoneRows.push(['Cert',    'Confirm sourcing before build']);
  }

  // Prefer the live override (textarea content) — falls back to the
  // stored column so preview loads whatever was sent last time.
  const factoryNotes = (typeof overrideNotes === 'string'
    ? overrideNotes
    : (lead.factory_notes || '')
  ).trim();

  return {
    reference_id: referenceId,
    submitted_at: lead.created_at,
    customer: {
      name:  lead.name || '\u2014',
      email: lead.email || '\u2014',
    },
    metal,
    ring: {
      finger_size: lead.ring_size || '\u2014',
    },
    stone: {
      raw: stone.raw,
      is_lab_diamond: stone.isLabDiamond,
      rows: stoneRows,
    },
    accents,
    notes: {
      setting_style: lead.setting_style || '\u2014',
      build_weight:  lead.weight_class || '\u2014',
      budget:        budget ? `$${budget.toLocaleString()}` : (lead.budget || '\u2014'),
      timeline:      lead.timeline || (lead.custom_date || '\u2014'),
    },
    factory_notes: factoryNotes,
    photos,
  };
}

function renderFactoryEmail(packet) {
  const rows = (arr) => arr.map(([k, v]) => `
    <tr>
      <td style="padding:5px 14px 5px 0;color:#707683;font-size:12px;vertical-align:top;width:130px">${esc(k)}</td>
      <td style="padding:5px 0;color:#22252b;font-size:13px">${esc(v)}</td>
    </tr>`).join('');

  const section = (title, body) => `
    <div style="margin-bottom:18px">
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#D9B48C;font-weight:600;margin-bottom:6px">${esc(title)}</div>
      ${body}
    </div>`;

  const metalRows = rows([
    ['Type',   packet.metal.type],
    ['Purity', packet.metal.purity],
    ['Color',  packet.metal.color],
  ]);
  const ringRows = rows([
    ['Finger size', packet.ring.finger_size],
  ]);
  const stoneRows = rows(packet.stone.rows);

  const photosHtml = packet.photos.length
    ? `<ul style="padding-left:20px;margin:6px 0;color:#22252b;font-size:13px;line-height:1.7">
        ${packet.photos.map(p => p.url
          ? `<li><strong>${esc(p.label)}</strong> &mdash; <a href="${esc(p.url)}" style="color:#2E5C4A">view photo</a></li>`
          : `<li><strong>${esc(p.label)}</strong> &mdash; (unavailable)</li>`
        ).join('')}
      </ul>
      <div style="color:#888;font-size:11px;margin-top:4px">Photo links expire in 30 days.</div>`
    : `<div style="color:#888;font-size:13px">No photos uploaded.</div>`;

  const notesHtml = packet.factory_notes
    ? `<div style="background:#faf7f2;border-left:3px solid #D9B48C;padding:12px 14px;font-size:13px;color:#2A3654;line-height:1.6;white-space:pre-wrap">${esc(packet.factory_notes)}</div>`
    : '';

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',Arial,sans-serif;background:#FAF7F2;padding:28px 20px">
      <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #E9E4DA;border-radius:8px;overflow:hidden">
        <div style="padding:22px 28px;border-bottom:1px solid #E9E4DA;background:#1F2A44;color:#fff">
          <div style="font-family:'Playfair Display',Georgia,serif;font-size:20px">The Ring Collective</div>
          <div style="color:#D9B48C;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:2px">Production packet &middot; ${esc(packet.reference_id)}</div>
        </div>
        <div style="padding:24px 28px">
          ${section('Reference', `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse">${rows([['Name', packet.customer.name], ['Ref', packet.reference_id]])}</table>`)}
          ${section('Metal', `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse">${metalRows}</table>`)}
          ${section('Ring', `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse">${ringRows}</table>`)}
          ${section('Center stone', `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse">${stoneRows}</table>`)}
          ${packet.factory_notes ? section('Custom notes', notesHtml) : ''}
          ${section('Photos', photosHtml)}
        </div>
      </div>
    </div>`;

  // Plain-text equivalent so any non-HTML email client still gets it.
  const line = (k, v) => `  ${k.padEnd(14)} ${v}`;
  const text = [
    `Production packet — ${packet.reference_id}`,
    `Submitted: ${packet.submitted_at}`,
    '',
    'REFERENCE',
    line('Name', packet.customer.name),
    line('Ref',  packet.reference_id),
    '',
    'METAL',
    line('Type', packet.metal.type),
    line('Purity', packet.metal.purity),
    line('Color', packet.metal.color),
    '',
    'RING',
    line('Finger size', packet.ring.finger_size),
    '',
    'CENTER STONE',
    ...packet.stone.rows.map(([k, v]) => line(k, v)),
    '',
    ...(packet.factory_notes ? ['CUSTOM NOTES', packet.factory_notes, ''] : []),
    'PHOTOS',
    ...packet.photos.map((p, i) => `  ${i + 1}. ${p.label} — ${p.url || '(unavailable)'}`),
    '',
    '— The Ring Collective',
  ].join('\n');

  return { html, text };
}

async function sendFactoryEmail(packet) {
  const key = requireEnv('RESEND_API_KEY');
  const to   = process.env.FACTORY_EMAIL || 'sethkgilbert@gmail.com';
  const from = process.env.NOTIFY_FROM || 'Ring Collective <onboarding@resend.dev>';

  const { html, text } = renderFactoryEmail(packet);
  const subject = `Production packet ${packet.reference_id} — ${packet.stone.raw || 'ring'}, ${packet.metal.type}${packet.metal.purity && packet.metal.purity !== '\u2014' ? ' ' + packet.metal.purity : ''}`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text, html }),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${body}`);
  return { to, response: body ? JSON.parse(body) : null };
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

      case 'preview_factory_packet': {
        if (!body.id) return json(400, headers, { error: 'id required' });
        const lead = await getLead(body.id);
        if (!lead) return json(404, headers, { error: 'not found' });
        // If the caller passes `notes`, re-render with them (useful for
        // live-preview updates); otherwise use the stored value.
        const packet = await buildFactoryPacket(
          lead,
          typeof body.notes === 'string' ? body.notes : undefined
        );
        const to = process.env.FACTORY_EMAIL || 'sethkgilbert@gmail.com';
        return json(200, headers, {
          packet,
          factory_email: to,
          already_sent_at: lead.factory_sent_at || null,
          current_status: lead.status,
          factory_notes: lead.factory_notes || '',
        });
      }

      case 'send_to_factory': {
        if (!body.id) return json(400, headers, { error: 'id required' });
        const lead = await getLead(body.id);
        if (!lead) return json(404, headers, { error: 'not found' });
        const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
        const packet = await buildFactoryPacket(lead, notes);
        const result = await sendFactoryEmail(packet);
        const now = new Date().toISOString();
        const updated = await updateLead(body.id, {
          status: 'in_production',
          factory_sent_at: now,
          factory_notes: notes || null,
        });
        return json(200, headers, {
          ok: true,
          factory_email: result.to,
          sent_at: now,
          lead: Array.isArray(updated) ? updated[0] : updated,
        });
      }

      default:
        return json(400, headers, { error: `unknown action: ${action}` });
    }
  } catch (err) {
    console.error('admin error:', err);
    return json(500, headers, { error: String(err.message || err) });
  }
};
