'use strict';

/// <reference path="../worker-configuration.d.ts" />

// Cloudflare Worker port of the former Vercel function at api/ocr.js.
// The site stays on GitHub Pages; this Worker is only the OCR API.

const MAX_BODY_BYTES = 3.8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2.75 * 1024 * 1024;
const MAX_ITEMS = 200;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 10;
const DEFAULT_ALLOWED_ORIGINS = 'https://roubizhao6-sys.github.io';
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_LANGUAGES = new Set(['en', 'zh-Hans', 'zh-Hant']);

// Per-isolate counters only. Isolates do not share memory, matching the old
// serverless limit (best-effort, not a global quota). Values are counts, not
// request objects.
const buckets = new Map();

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeText(value, maxLength = 200) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function stripListMarker(line) {
  return normalizeText(line, 500)
    .replace(/^[•·*\-–—]+\s*/, '')
    .replace(/^\d{1,3}\s*[.)、:：\-]\s*/, '');
}

function normalizeEnglish(english, meaning) {
  let word = normalizeText(english, 80)
    .replace(/[.。:：,，;；]+$/g, '')
    .trim();
  let prefix = '';

  const pos = word.match(/\s+(n|v|vt|vi|adj|adv|prep|pron|conj|num|art|phr)\.?$/i);
  if (pos) {
    prefix = `${pos[1].toLowerCase()}.`;
    word = word.slice(0, pos.index).trim();
  }

  if (!/^[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3}$/.test(word)) {
    return null;
  }

  const cleanMeaning = normalizeText(meaning, 240);
  return {
    word,
    meaning: [prefix, cleanMeaning].filter(Boolean).join(' ')
  };
}

function extractItems(ocrText) {
  const lines = String(ocrText || '')
    .split(/\r?\n/)
    .map(stripListMarker)
    .filter(Boolean);

  const items = [];
  const byWord = new Map();
  let pendingEnglish = '';

  function addItem(english, meaning = '') {
    const item = normalizeEnglish(english, meaning);
    if (!item) return;
    const key = item.word.toLowerCase();
    const previous = byWord.get(key);
    if (previous) {
      if (!previous.meaning && item.meaning) previous.meaning = item.meaning;
      return;
    }
    byWord.set(key, item);
    items.push(item);
  }

  for (const line of lines) {
    const hasChinese = /[\u3400-\u9fff]/.test(line);
    const hasEnglish = /[A-Za-z]/.test(line);

    if (!hasEnglish && hasChinese && pendingEnglish) {
      addItem(pendingEnglish, line);
      pendingEnglish = '';
      continue;
    }

    if (hasEnglish && !hasChinese) {
      if (pendingEnglish) addItem(pendingEnglish);
      pendingEnglish = line;
      continue;
    }

    if (hasEnglish && hasChinese) {
      if (pendingEnglish) {
        addItem(pendingEnglish);
        pendingEnglish = '';
      }

      let matched = false;
      const pairPattern = /([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})\s*(?:[:：=\-–—]\s*|\s+)?([\u3400-\u9fff][\u3400-\u9fff\s，,、；;：:（）()《》·…]*?)(?=\s*[A-Za-z][A-Za-z'’\-]*\s*[\u3400-\u9fff]|\s*$)/g;
      for (const match of line.matchAll(pairPattern)) {
        addItem(match[1], match[2]);
        matched = true;
      }

      if (!matched) {
        const english = line.match(/[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z'’\-]*){0,3}/);
        const meaning = line.match(/[\u3400-\u9fff][\u3400-\u9fff\s，,、；;：:（）()《》·…]*/);
        if (english) addItem(english[0], meaning ? meaning[0] : '');
      }
      continue;
    }

    if (pendingEnglish) {
      addItem(pendingEnglish);
      pendingEnglish = '';
    }
  }

  if (pendingEnglish) addItem(pendingEnglish);
  return items.slice(0, MAX_ITEMS);
}

function base64DecodedByteLength(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw httpError(400, '请上传 JPEG、PNG 或 WebP 图片');
  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIME.has(mimeType)) throw httpError(400, '不支持的图片格式');

  const base64 = match[2].replace(/\s/g, '');
  const byteLength = base64DecodedByteLength(base64);
  if (!byteLength) throw httpError(400, '图片内容为空');
  if (byteLength > MAX_IMAGE_BYTES) throw httpError(413, '图片过大，请重新裁剪或压缩到 2.7 MB 以下');
  return { mimeType, base64, byteLength };
}

function headerValue(request, name) {
  return request.headers.get(name) || '';
}

function allowedOrigins(env) {
  const configured = env && env.OCR_ALLOWED_ORIGINS;
  const raw = configured == null || String(configured).trim() === ''
    ? DEFAULT_ALLOWED_ORIGINS
    : String(configured);
  return raw.split(',').map(value => value.trim()).filter(Boolean);
}

function getAllowedOrigin(request, env) {
  const origin = headerValue(request, 'origin');
  if (!origin) return '';

  // Workers expose Host. The Fetch API in Node hides that forbidden header,
  // so fall back to the request URL, which is the same authority.
  const hostHeader = headerValue(request, 'x-forwarded-host') || headerValue(request, 'host');
  let host = String(hostHeader).split(',')[0].trim();
  if (!host) {
    try {
      host = new URL(request.url).host;
    } catch {
      host = '';
    }
  }
  try {
    if (host && new URL(origin).host === host) return origin;
  } catch {
    return null;
  }

  return allowedOrigins(env).includes(origin) ? origin : null;
}

function applyCors(headers, origin) {
  if (!origin) return;
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
}

function jsonResponse(body, status, origin, extra) {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'no-store');
  applyCors(headers, origin);
  return Response.json(body, { status, headers });
}

function emptyResponse(status, origin, extra) {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'no-store');
  applyCors(headers, origin);
  return new Response(null, { status, headers });
}

function clientKey(request) {
  // cf-connecting-ip is set by Cloudflare and is not client-controlled.
  // x-forwarded-for remains the fallback for local runtimes.
  const connecting = headerValue(request, 'cf-connecting-ip').trim();
  if (connecting) return connecting;
  const forwarded = headerValue(request, 'x-forwarded-for').split(',')[0].trim();
  return forwarded || 'unknown';
}

function checkRateLimit(request) {
  const key = clientKey(request);
  const now = Date.now();
  if (buckets.size > 512) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }

  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }

  current.count += 1;
  if (current.count <= RATE_LIMIT) return { ok: true, retryAfter: 0 };
  return { ok: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
}

function resetRateLimits() {
  buckets.clear();
}

async function readJsonBody(request) {
  if (!request.body) throw httpError(400, '请求内容不是有效 JSON');

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw httpError(413, '请求内容过大');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw httpError(400, '请求内容不是有效 JSON');
  }
}

async function runVisionOcr(base64, languageHints, env) {
  const apiKey = env && env.GOOGLE_VISION_API_KEY;
  if (!apiKey) throw httpError(503, 'OCR 服务尚未配置 GOOGLE_VISION_API_KEY');

  const response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey
    },
    body: JSON.stringify({
      requests: [{
        image: { content: base64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints }
      }]
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw httpError(502, payload?.error?.message || `OCR 上游服务失败（${response.status}）`);
  }

  const result = payload?.responses?.[0];
  if (result?.error?.message) throw httpError(502, result.error.message);

  const blocks = result?.fullTextAnnotation?.pages?.flatMap(page =>
    (page.blocks || []).flatMap(block =>
      (block.paragraphs || []).flatMap(paragraph =>
        (paragraph.words || []).map(word =>
          (word.symbols || []).map(symbol => symbol.text || '').join('')
        )
      )
    )
  );
  const rawText = result?.fullTextAnnotation?.text || result?.textAnnotations?.[0]?.description || blocks?.join('\n') || '';
  const text = normalizeText(rawText, 50000);

  return {
    text,
    items: extractItems(rawText)
  };
}

function logEvent(level, fields) {
  const line = JSON.stringify(fields);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

async function handleFetch(request, env) {
  const origin = getAllowedOrigin(request, env);
  if (origin === null) {
    logEvent('warn', { message: 'ocr origin rejected', status: 403 });
    return jsonResponse({ error: '当前来源不允许调用 OCR 服务' }, 403, '');
  }

  if (request.method === 'OPTIONS') {
    return emptyResponse(204, origin);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: '只支持 POST' }, 405, origin, { Allow: 'POST, OPTIONS' });
  }

  const declaredLength = Number(headerValue(request, 'content-length') || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: '请求内容过大' }, 413, origin);
  }

  const rate = checkRateLimit(request);
  if (!rate.ok) {
    return jsonResponse(
      { error: '识别过于频繁，请稍后再试' },
      429,
      origin,
      { 'Retry-After': String(rate.retryAfter) }
    );
  }

  try {
    const body = await readJsonBody(request);
    const image = parseDataUrl(body.image);
    const requestedLanguages = Array.isArray(body.languageHints)
      ? body.languageHints.filter(value => ALLOWED_LANGUAGES.has(value))
      : [];
    const languageHints = requestedLanguages.length ? requestedLanguages : ['en', 'zh-Hans'];
    const result = await runVisionOcr(image.base64, languageHints, env);
    logEvent('info', {
      message: 'ocr complete',
      status: 200,
      imageBytes: image.byteLength,
      items: result.items.length
    });
    return jsonResponse({
      provider: 'google-vision',
      text: result.text,
      items: result.items,
      imageBytes: image.byteLength
    }, 200, origin);
  } catch (error) {
    const status = Number(error.status) || 500;
    const message = status >= 500 && !error.status
      ? 'OCR 服务暂时不可用'
      : error.message || 'OCR 识别失败';
    logEvent(status >= 500 ? 'error' : 'warn', {
      message: 'ocr failed',
      status
    });
    return jsonResponse({ error: message }, status, origin);
  }
}

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @returns {Promise<Response>}
   */
  fetch(request, env) {
    return handleFetch(request, env);
  }
};

export {
  extractItems,
  normalizeEnglish,
  parseDataUrl,
  stripListMarker,
  handleFetch,
  resetRateLimits,
  base64DecodedByteLength
};
