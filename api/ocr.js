'use strict';

const MAX_BODY_BYTES = 3.8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2.75 * 1024 * 1024;
const MAX_ITEMS = 200;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 10;
const buckets = new Map();
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_LANGUAGES = new Set(['en', 'zh-Hans', 'zh-Hant']);

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

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw httpError(400, '请上传 JPEG、PNG 或 WebP 图片');
  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIME.has(mimeType)) throw httpError(400, '不支持的图片格式');

  const base64 = match[2].replace(/\s/g, '');
  const byteLength = Buffer.byteLength(base64, 'base64');
  if (!byteLength) throw httpError(400, '图片内容为空');
  if (byteLength > MAX_IMAGE_BYTES) throw httpError(413, '图片过大，请重新裁剪或压缩到 2.7 MB 以下');
  return { mimeType, base64, byteLength };
}

function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    try {
      return Promise.resolve(JSON.parse(raw));
    } catch {
      return Promise.reject(httpError(400, '请求内容不是有效 JSON'));
    }
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, '请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, '请求内容不是有效 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function checkRateLimit(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const key = forwarded || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }

  current.count += 1;
  if (current.count <= RATE_LIMIT) return { ok: true, retryAfter: 0 };
  return { ok: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
}

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return '';

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  try {
    if (host && new URL(origin).host === host) return origin;
  } catch {
    return null;
  }

  const configured = String(process.env.OCR_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return configured.includes(origin) ? origin : null;
}

function setCorsHeaders(res, origin) {
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function runVisionOcr(base64, languageHints) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) throw httpError(503, 'OCR 服务尚未配置 GOOGLE_VISION_API_KEY');

  const response = await fetch(
    'https://vision.googleapis.com/v1/images:annotate',
    {
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
    }
  );

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

async function handler(req, res) {
  const origin = getAllowedOrigin(req);
  if (origin === null) {
    res.status(403).json({ error: '当前来源不允许调用 OCR 服务' });
    return;
  }
  setCorsHeaders(res, origin);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ error: '只支持 POST' });
    return;
  }

  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    res.status(413).json({ error: '请求内容过大' });
    return;
  }

  const rate = checkRateLimit(req);
  if (!rate.ok) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    res.status(429).json({ error: '识别过于频繁，请稍后再试' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const image = parseDataUrl(body.image);
    const requestedLanguages = Array.isArray(body.languageHints)
      ? body.languageHints.filter(value => ALLOWED_LANGUAGES.has(value))
      : [];
    const languageHints = requestedLanguages.length ? requestedLanguages : ['en', 'zh-Hans'];
    const result = await runVisionOcr(image.base64, languageHints);
    res.status(200).json({
      provider: 'google-vision',
      text: result.text,
      items: result.items,
      imageBytes: image.byteLength
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    const message = status >= 500 && !error.status
      ? 'OCR 服务暂时不可用'
      : error.message || 'OCR 识别失败';
    if (!res.headersSent) res.status(status).json({ error: message });
  }
}

module.exports = handler;
module.exports._test = {
  extractItems,
  normalizeEnglish,
  parseDataUrl,
  stripListMarker
};
