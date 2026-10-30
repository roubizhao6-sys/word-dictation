const MAX_IMAGE_CHARS = 4_000_000;
const MAX_BODY_BYTES = 5_500_000;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

function isAllowedOrigin(origin, env) {
  if (!origin) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

function responseHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (origin && isAllowedOrigin(origin, env)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(request, body, status, env) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(request, env) });
}

function parseImage(value) {
  if (typeof value !== 'string' || !value.startsWith('data:')) {
    throw new Error('请上传 JPG、PNG 或 WebP 图片');
  }
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match || !ALLOWED_MIME.has(match[1])) {
    throw new Error('仅支持 JPG、PNG 或 WebP 图片');
  }
  const base64 = match[2].replace(/\s/g, '');
  if (!base64 || base64.length > MAX_IMAGE_CHARS) {
    throw new Error('图片过大或内容为空，请压缩后再试');
  }
  return { mimeType: match[1], base64 };
}

function normalizeWords(text) {
  const seen = new Set();
  const words = [];
  const prepared = String(text || '')
    .replace(/(^|\s)\d{1,3}[.)、]\s+/g, '\n')
    .replace(/\r/g, '');

  for (const rawLine of prepared.split(/\n+/)) {
    const line = rawLine
      .replace(/\b(?:n|v|vt|vi|adj|adv|prep|conj|pron|num|phr)\.\s*/gi, ' ')
      .replace(/[|｜;,，；]/g, '\t');
    for (const part of line.split(/\t|\s{2,}/)) {
      const word = part
        .replace(/[^A-Za-z' .-]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[.' -]+|[.' -]+$/g, '')
        .trim();
      if (!word || word.length > 80 || !/^[A-Za-z][A-Za-z' .-]*$/.test(word)) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      words.push({ word });
      if (words.length >= 100) return words;
    }
  }
  return words;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (origin && !isAllowedOrigin(origin, env)) {
      return json(request, { error: '不允许的跨域来源' }, 403, env);
    }

    if (request.method === 'OPTIONS') {
      const headers = responseHeaders(request, env);
      delete headers['Content-Type'];
      delete headers['Cache-Control'];
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      const response = json(request, { error: '仅支持 POST' }, 405, env);
      response.headers.set('Allow', 'POST');
      return response;
    }

    if (!env.GOOGLE_VISION_API_KEY) {
      return json(request, { error: 'OCR 服务未配置 GOOGLE_VISION_API_KEY' }, 500, env);
    }

    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return json(request, { error: '请求体过大，请压缩图片后重试' }, 413, env);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json(request, { error: '请求格式不正确' }, 400, env);
    }

    let image;
    try {
      image = parseImage(body.image);
    } catch (error) {
      return json(request, { error: error.message }, 400, env);
    }

    try {
      const upstream = await fetch(
        'https://vision.googleapis.com/v1/images:annotate',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': env.GOOGLE_VISION_API_KEY
          },
          body: JSON.stringify({
            requests: [{
              image: { content: image.base64 },
              features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
              imageContext: { languageHints: ['en'] }
            }]
          })
        }
      );

      const data = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        const detail = data && data.error && data.error.message
          ? String(data.error.message).slice(0, 240)
          : `Google Vision HTTP ${upstream.status}`;
        return json(request, { error: 'OCR 识别失败', detail }, 502, env);
      }

      const result = data && data.responses && data.responses[0];
      if (result && result.error) {
        return json(request, {
          error: 'OCR 识别失败',
          detail: String(result.error.message || 'Google Vision 返回错误').slice(0, 240)
        }, 502, env);
      }

      const text = result && (
        (result.fullTextAnnotation && result.fullTextAnnotation.text) ||
        (result.textAnnotations && result.textAnnotations[0] && result.textAnnotations[0].description)
      );
      const words = normalizeWords(text);
      if (!words.length) {
        return json(request, { error: '没有识别到英文单词，请换一张更清晰的照片' }, 422, env);
      }
      return json(request, { words }, 200, env);
    } catch (error) {
      console.error('Google Vision request failed:', error);
      return json(request, { error: 'OCR 服务暂时不可用' }, 502, env);
    }
  }
};
