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
      'You are analyzing photos of an engagement ring. Identify five things:',
      '1. stoneCategory: exactly "diamond" (clear/colorless center stone) or "colored" (non-white gemstone like sapphire, ruby, emerald, etc.).',
      '2. shape: exactly one of ' + SHAPES.join(', ') + '.',
      '3. metalColor: exactly one of ' + METALS.join(', ') + '. Platinum and white gold look identical in photos, so default to "White Gold" unless obviously different.',
      '4. settingStyle: exactly one of ' + SETTINGS.join(', ') + '. "solitaire" = single center stone with plain band, "halo" = center stone surrounded by a ring of smaller stones, "pave" = small diamonds set along the band, "three-stone" = one center + two side stones.',
      '5. weightClass: exactly one of ' + WEIGHTS.join(', ') + ' describing how substantial the band and setting appear. "delicate" = very thin/dainty, "standard" = average heft, "substantial" = chunky/heavy/wide.',
      '',
      'Return ONLY a minified JSON object with exactly those five string fields. No preamble, no markdown, no code fences. If uncertain, pick the single most likely option.'
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
        max_tokens: 200,
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
    const out = {
      stoneCategory: parsed.stoneCategory === 'colored' ? 'colored' : 'diamond',
      shape: SHAPES.includes(parsed.shape) ? parsed.shape : 'Round',
      metalColor: METALS.includes(parsed.metalColor) ? parsed.metalColor : 'White Gold',
      settingStyle: SETTINGS.includes(parsed.settingStyle) ? parsed.settingStyle : 'solitaire',
      weightClass: WEIGHTS.includes(parsed.weightClass) ? parsed.weightClass : 'standard'
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
