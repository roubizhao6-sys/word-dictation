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
const BAIDU_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
// Default is 通用文字识别（高精度含位置版）. It has a free monthly quota and
// returns line locations, which we use to order notebook lines. Handwriting
// stays available only when BAIDU_OCR_HANDWRITING is enabled, because that
// API must be checked on the Baidu app or it returns error 6 / 216102.
// https://cloud.baidu.com/doc/OCR/s/tk3h7y2aq
// https://cloud.baidu.com/doc/OCR/s/hk3h7y2qq
const BAIDU_ACCURATE_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate';
const BAIDU_HANDWRITING_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/handwriting';
const TOKEN_SKEW_MS = 5 * 60 * 1000;

// Per-isolate counters only. Isolates do not share memory, matching the old
// serverless limit (best-effort, not a global quota). Values are counts, not
// request objects.
const buckets = new Map();

// Isolate-local access_token cache. Isolates do not share memory. This holds
// the token and its expiry only, not photos or request bodies.
const baiduToken = {
  value: '',
  expiresAt: 0,
  tag: ''
};
let tokenQueue = Promise.resolve();

function httpError(status, message, upstreamCode) {
  const error = new Error(message);
  error.status = status;
  if (upstreamCode) error.upstreamCode = upstreamCode;
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

function invalidateBaiduToken() {
  baiduToken.value = '';
  baiduToken.expiresAt = 0;
  baiduToken.tag = '';
}

function resetBaiduTokenCache() {
  invalidateBaiduToken();
  tokenQueue = Promise.resolve();
}

function resetRateLimits() {
  buckets.clear();
  resetBaiduTokenCache();
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

function baiduLanguageType(languageHints) {
  const hints = new Set(languageHints || []);
  const chinese = hints.has('zh-Hans') || hints.has('zh-Hant');
  const english = hints.has('en');
  if (english && !chinese) return 'ENG';
  return 'CHN_ENG';
}

function isBaiduTokenError(payload) {
  const code = Number(payload && payload.error_code);
  return code === 100 || code === 110 || code === 111;
}

function baiduOcrError(payload, httpStatus, notEnabledMessage) {
  const code = Number(payload && payload.error_code);
  if (code === 216201) return httpError(400, '图片格式不受支持，请使用 JPEG 或 PNG', code);
  if (code === 216202) return httpError(400, '图片过大或分辨率过高，请重新裁剪后再试', code);
  if (code === 216200) return httpError(400, '图片内容为空', code);
  if (code === 17 || code === 19) return httpError(502, 'OCR 调用次数已达上限，请稍后再试', code);
  if (code === 4 || code === 18) return httpError(502, 'OCR 调用过于频繁，请稍后再试', code);
  if (code === 6 || code === 216102) {
    return httpError(502, notEnabledMessage || 'OCR 服务尚未开通', code);
  }
  if (code === 100 || code === 110 || code === 111) return httpError(502, 'OCR 上游服务失败，访问凭证无效', code);
  if (code) return httpError(502, `OCR 上游服务失败（${code}）`, code);
  return httpError(502, `OCR 上游服务失败（${httpStatus || 502}）`);
}

function handwritingEnabled(env) {
  const flag = String(env && env.BAIDU_OCR_HANDWRITING || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

function ocrTarget(languageHints, env) {
  const languageType = baiduLanguageType(languageHints);
  if (handwritingEnabled(env)) {
    return {
      endpoint: BAIDU_HANDWRITING_URL,
      fields: {
        eng_granularity: 'word',
        detect_direction: 'true',
        language_type: languageType
      },
      notEnabled: 'OCR 服务尚未开通手写识别'
    };
  }
  // recognize_granularity=big keeps each line whole. small would return
  // characters, and eng_granularity only applies in that mode.
  return {
    endpoint: BAIDU_ACCURATE_URL,
    fields: {
      recognize_granularity: 'big',
      detect_direction: 'true',
      language_type: languageType
    },
    notEnabled: 'OCR 服务尚未开通高精度文字识别'
  };
}

function wordsResultText(payload) {
  const rows = Array.isArray(payload && payload.words_result) ? payload.words_result : [];
  const lines = rows.map(row => ({
    words: String(row && row.words || '').trim(),
    top: Number(row && row.location && row.location.top),
    left: Number(row && row.location && row.location.left)
  })).filter(row => row.words);
  const positioned = lines.every(row => Number.isFinite(row.top) && Number.isFinite(row.left));
  if (positioned && lines.length > 1) {
    lines.sort((a, b) => (a.top - b.top) || (a.left - b.left));
  }
  return lines.map(row => row.words).join('\n');
}

async function credentialTag(apiKey, secretKey) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${apiKey}\n${secretKey}`)
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function baiduCredentials(env) {
  return {
    apiKey: String(env && env.BAIDU_OCR_API_KEY || '').trim(),
    secretKey: String(env && env.BAIDU_OCR_SECRET_KEY || '').trim()
  };
}

function sanitizeBaiduTokenDetail(payload, apiKey, secretKey) {
  const raw = payload && (payload.error_description || payload.error || payload.error_msg);
  if (raw == null) return '';
  let text = String(raw).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const secrets = [apiKey, secretKey].filter(value => value && value.length >= 8);
  for (const secret of secrets) {
    text = text.split(secret).join('');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) text = text.split(encoded).join('');
  }
  text = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return text;
}

async function requestBaiduAccessToken(apiKey, secretKey, tag) {
  // Baidu documents client_id/client_secret on the token URL query string.
  // Also send them in the POST body. Follow redirects; Workers sometimes see
  // a hop that redirect:manual would treat as failure. The API key and secret
  // still never go on the OCR URL — only the resulting access_token does.
  const url = new URL(BAIDU_TOKEN_URL);
  url.searchParams.set('grant_type', 'client_credentials');
  url.searchParams.set('client_id', apiKey);
  url.searchParams.set('client_secret', secretKey);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: apiKey,
    client_secret: secretKey
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'follow',
    cache: 'no-store'
  });
  const payload = await response.json().catch(() => null);
  const accessToken = payload && payload.access_token;
  if (!response.ok || typeof accessToken !== 'string' || !accessToken) {
    const detail = sanitizeBaiduTokenDetail(payload, apiKey, secretKey);
    throw httpError(502, detail
      ? `OCR 上游服务失败，无法获取访问凭证（${detail}）`
      : 'OCR 上游服务失败，无法获取访问凭证');
  }

  const expiresInMs = Number(payload.expires_in) * 1000;
  const ttl = Number.isFinite(expiresInMs) && expiresInMs > TOKEN_SKEW_MS
    ? expiresInMs - TOKEN_SKEW_MS
    : 0;
  if (ttl > 0) {
    baiduToken.value = accessToken;
    baiduToken.expiresAt = Date.now() + ttl;
    baiduToken.tag = tag;
  }
  return accessToken;
}

async function loadCachedToken(apiKey, secretKey) {
  const tag = await credentialTag(apiKey, secretKey);
  if (baiduToken.tag === tag && baiduToken.value && baiduToken.expiresAt > Date.now()) {
    return baiduToken.value;
  }
  return requestBaiduAccessToken(apiKey, secretKey, tag);
}

function getBaiduAccessToken(env) {
  const { apiKey, secretKey } = baiduCredentials(env);
  if (!apiKey || !secretKey) return Promise.reject(httpError(503, 'OCR 服务尚未配置'));

  // Serialize token loads so concurrent photos share one request.
  const run = tokenQueue.then(() => loadCachedToken(apiKey, secretKey));
  tokenQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function callBaiduOcr(base64, languageHints, env, allowRefresh) {
  const accessToken = await getBaiduAccessToken(env);
  const target = ocrTarget(languageHints, env);
  const url = new URL(target.endpoint);
  url.searchParams.set('access_token', accessToken);
  const body = new URLSearchParams({
    image: base64,
    ...target.fields
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'follow',
    cache: 'no-store'
  });
  if (response.status >= 300 && response.status < 400) {
    throw httpError(502, `OCR 上游服务失败（${response.status}）`);
  }
  const payload = await response.json().catch(() => null);
  if (allowRefresh && isBaiduTokenError(payload)) {
    invalidateBaiduToken();
    return callBaiduOcr(base64, languageHints, env, false);
  }
  if (!response.ok || !payload || payload.error_code) {
    throw baiduOcrError(payload, response.status, target.notEnabled);
  }
  return payload;
}

async function runBaiduOcr(base64, languageHints, env) {
  const payload = await callBaiduOcr(base64, languageHints, env, true);
  const rawText = wordsResultText(payload);
  return {
    text: normalizeText(rawText, 50000),
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
    const result = await runBaiduOcr(image.base64, languageHints, env);
    logEvent('info', {
      message: 'ocr complete',
      status: 200,
      imageBytes: image.byteLength,
      items: result.items.length
    });
    return jsonResponse({
      provider: 'baidu-ocr',
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
      status,
      upstreamCode: error.upstreamCode
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
