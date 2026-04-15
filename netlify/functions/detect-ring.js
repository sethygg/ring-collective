// netlify/functions/detect-ring.js
// Serverless function that sends uploaded ring photos to Claude Vision
// and returns structured detections { stoneCategory, shape, metalColor }.
//
// Guards:
//   1. Origin check — only allows calls from the site's own domain(s).
//   2. Per-IP rate limit — 20 requests / rolling hour (in-memory).
//
// Requires ANTHROPIC_API_KEY env var set in Netlify site settings.

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = 20;
const hits = new Map(); // ip -> [timestamps]

const ALLOWED_ORIGINS = [
  /^https?:\/\/theringcollective\.netlify\.app$/i,
  /^https?:\/\/theringcollective\.co$/i,
  /^https?:\/\/www\.theringcollective\.co$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];

const SHAPES = ['Round','Oval','Emerald','Cushion','Pear','Princess','Marquise','Radiant'];
const METALS = ['White Gold','Yellow Gold','Rose Gold','Platinum'];
const SETTINGS = ['solitaire','halo','pave','three-stone'];
const WEIGHTS  = ['delicate','standard','substantial'];
const ACCENT_PATTERNS = ['none','shoulders','half-eternity','three-quarter-eternity','full-eternity'];
const MELEE_SIZES = ['none','small','medium','large'];

// Estimated stone count by (pattern × melee size) on a ~size 6.5 band.
// Counts are approximations — close enough for pricing, but the admin
// can always override. Hidden halo adds extra stones on top.
const COUNTS_BY_PATTERN = {
  'none':                    { small: 0,  medium: 0,  large: 0  },
  'shoulders':               { small: 14, medium: 12, large: 10 },
  'half-eternity':           { small: 18, medium: 14, large: 11 },
  'three-quarter-eternity':  { small: 28, medium: 22, large: 17 },
  'full-eternity':           { small: 36, medium: 28, large: 22 },
};
// Average ct per stone by size class (1.2-1.5mm / 1.6-2.0mm / 2.0mm+).
const CT_PER_STONE = { small: 0.012, medium: 0.022, large: 0.040 };
// Hidden halo: small circle of ~18 tiny stones (~1.2mm, ~0.008 ct each).
const HIDDEN_HALO_COUNT = 18;
const HIDDEN_HALO_CT_EACH = 0.008;

function estimateAccents({ accentPattern, accentMeleeSize, hiddenHalo }) {
  const pattern = ACCENT_PATTERNS.includes(accentPattern) ? accentPattern : 'none';
  const size = MELEE_SIZES.includes(accentMeleeSize) ? accentMeleeSize : 'none';

  let count = 0;
  let tcw  = 0;
  if (pattern !== 'none' && size !== 'none') {
    count = COUNTS_BY_PATTERN[pattern][size] || 0;
    tcw   = count * (CT_PER_STONE[size] || 0);
  }
  if (hiddenHalo) {
    count += HIDDEN_HALO_COUNT;
    tcw   += HIDDEN_HALO_COUNT * HIDDEN_HALO_CT_EACH;
  }
  return { count, tcw: +tcw.toFixed(3) };
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(re => re.test(origin || ''));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
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

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method not allowed' };
  }
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
      body: JSON.stringify({ error: 'Rate limit exceeded. Please try again in an hour.' })
    };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured: ANTHROPIC_API_KEY missing.' }) };
  }

  let photos;
  try {
    const body = JSON.parse(event.body || '{}');
    photos = body.photos;
  } catch (_) {
    return { statusCode: 400, headers, body: 'Invalid JSON' };
  }
  if (!Array.isArray(photos) || photos.length === 0) {
    return { statusCode: 400, headers, body: 'No photos provided' };
  }

  const content = [{
    type: 'text',
    text: [
      'You are analyzing photos of an engagement ring. Identify eight things:',
      '1. stoneCategory: exactly "diamond" (clear/colorless center stone) or "colored" (non-white gemstone like sapphire, ruby, emerald, etc.).',
      '2. shape: exactly one of ' + SHAPES.join(', ') + '.',
      '3. metalColor: exactly one of ' + METALS.join(', ') + '. Platinum and white gold look identical in photos, so default to "White Gold" unless obviously different.',
      '4. settingStyle: exactly one of ' + SETTINGS.join(', ') + '. "solitaire" = single center stone with plain band, "halo" = center stone surrounded by a ring of smaller stones, "pave" = small diamonds set along the band, "three-stone" = one center + two side stones.',
      '5. weightClass: exactly one of ' + WEIGHTS.join(', ') + ' describing how substantial the band and setting appear. "delicate" = very thin/dainty, "standard" = average heft, "substantial" = chunky/heavy/wide.',
      '',
      'Accent / melee diamonds on the BAND (small stones set into the band itself, NOT the halo around the center stone):',
      '6. accentPattern: exactly one of ' + ACCENT_PATTERNS.join(', ') + '.',
      '   - "none" = plain band, no accent stones on it.',
      '   - "shoulders" = accents only near the center stone head, stopping partway down each side (roughly the top 25-30% of the band).',
      '   - "half-eternity" = accents span the top half of the ring, visible from the front but stop before the bottom.',
      '   - "three-quarter-eternity" = accents cover the top 3/4 of the ring, stopping only at the bottom inch.',
      '   - "full-eternity" = accents go all the way around the entire ring.',
      '7. accentMeleeSize: exactly one of ' + MELEE_SIZES.join(', ') + ' describing how large each individual band accent stone is.',
      '   - "none" = no band accents (accentPattern is "none").',
      '   - "small" = very tiny stones, pave-like (~1.2-1.5mm), many stones close together.',
      '   - "medium" = visibly distinct small stones (~1.6-2.0mm), typical for channel or shared-prong bands.',
      '   - "large" = chunky band stones (~2.0mm+), fewer and more substantial.',
      '8. hiddenHalo: boolean true/false. A "hidden halo" is a small ring of tiny stones set on the side profile of the basket, UNDER the center stone — only visible from the side, not from above. Return false if no hidden halo is visible, or if you cannot see the side profile.',
      '',
      'Return ONLY a minified JSON object with exactly these fields: stoneCategory, shape, metalColor, settingStyle, weightClass, accentPattern, accentMeleeSize, hiddenHalo. No preamble, no markdown, no code fences. If uncertain, pick the single most likely option. If the band clearly has no accents, return accentPattern:"none", accentMeleeSize:"none".'
    ].join('\n')
  }];

  for (const p of photos.slice(0, 4)) {
    const dataUrl = (p && p.dataUrl) || '';
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!m) continue;
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: m[1], data: m[2] }
    });
  }
  if (content.length === 1) {
    return { statusCode: 400, headers, body: 'No valid image data' };
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content }]
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Claude API error:', resp.status, errText);
      return { statusCode: 502, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Vision service unavailable.' }) };
    }
    const data = await resp.json();
    const text = (data && data.content && data.content[0] && data.content[0].text) || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let parsed = {};
    try { parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text); } catch (_) {}

    // Validate + normalize
    const accentPattern = ACCENT_PATTERNS.includes(parsed.accentPattern) ? parsed.accentPattern : 'none';
    const accentMeleeSize = MELEE_SIZES.includes(parsed.accentMeleeSize) ? parsed.accentMeleeSize : 'none';
    const hiddenHalo = parsed.hiddenHalo === true;
    const { count: estimatedAccentCount, tcw: estimatedAccentTcw } =
      estimateAccents({ accentPattern, accentMeleeSize, hiddenHalo });

    const out = {
      stoneCategory: parsed.stoneCategory === 'colored' ? 'colored' : 'diamond',
      shape: SHAPES.includes(parsed.shape) ? parsed.shape : 'Round',
      metalColor: METALS.includes(parsed.metalColor) ? parsed.metalColor : 'White Gold',
      settingStyle: SETTINGS.includes(parsed.settingStyle) ? parsed.settingStyle : 'solitaire',
      weightClass: WEIGHTS.includes(parsed.weightClass) ? parsed.weightClass : 'standard',
      accentPattern,
      accentMeleeSize,
      hiddenHalo,
      estimatedAccentCount,
      estimatedAccentTcw,
    };

    return {
      statusCode: 200,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(out)
    };
  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
