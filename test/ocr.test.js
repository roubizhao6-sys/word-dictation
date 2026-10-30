import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.beforeEach(() => {
  api.resetRateLimits();
});

test('extracts English words with optional Chinese meanings', () => {
  const items = api.extractItems(`
    1. apple 苹果
    2. abandon v. 放弃
    look after 照顾
  `);
  assert.deepEqual(items, [
    { word: 'apple', meaning: '苹果' },
    { word: 'abandon', meaning: 'v. 放弃' },
    { word: 'look after', meaning: '照顾' }
  ]);
});

test('pairs English-only and Chinese-only lines', () => {
  const items = api.extractItems('apple\n苹果\nbanana\n香蕉');
  assert.deepEqual(items, [
    { word: 'apple', meaning: '苹果' },
    { word: 'banana', meaning: '香蕉' }
  ]);
});

test('handles several pairs on one line and deduplicates words', () => {
  const items = api.extractItems(`
    apple 苹果 banana 香蕉
    apple 苹果（重复）
  `);
  assert.deepEqual(items, [
    { word: 'apple', meaning: '苹果' },
    { word: 'banana', meaning: '香蕉' }
  ]);
});

test('keeps English-only words and strips list numbering', () => {
  assert.equal(api.stripListMarker('12. procedure'), 'procedure');
  assert.deepEqual(api.extractItems('12. procedure\n13. moisture 水分'), [
    { word: 'procedure', meaning: '' },
    { word: 'moisture', meaning: '水分' }
  ]);
});

test('rejects non-image data URLs', () => {
  assert.throws(() => api.parseDataUrl('data:text/plain;base64,SGVsbG8='), /JPEG/);
});

test('base64 size matches Node Buffer.byteLength', () => {
  const samples = ['iVBORw0KGgo=', 'YQ==', 'abcd', 'A'.repeat(8)];
  for (const sample of samples) {
    assert.equal(api.base64DecodedByteLength(sample), Buffer.byteLength(sample, 'base64'));
  }
});

const SAMPLE_IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

function postRequest(url, { origin, body, headers = {}, method = 'POST' } = {}) {
  const payload = body === undefined ? JSON.stringify({ image: SAMPLE_IMAGE }) : body;
  const init = {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers
    }
  };
  if (origin) init.headers.origin = origin;
  if (method !== 'GET' && method !== 'OPTIONS') init.body = payload;
  return new Request(url, init);
}

test('handler returns 503 when the server key is missing', async () => {
  const request = postRequest('https://example.test/api/ocr', {
    origin: 'https://example.test'
  });
  const response = await api.handleFetch(request, {});
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error, 'OCR 服务尚未配置');
  assert.doesNotMatch(body.error, /GOOGLE_VISION_API_KEY|AIza/);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://example.test');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('handler sends the image to Vision and returns structured items', async () => {
  const originalFetch = global.fetch;
  let upstreamRequest;
  global.fetch = async (url, options) => {
    upstreamRequest = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        responses: [{
          fullTextAnnotation: { text: 'apple 苹果\nbanana 香蕉' }
        }]
      })
    };
  };

  const request = postRequest('https://example.test/api/ocr', {
    origin: 'https://example.test',
    body: JSON.stringify({
      image: SAMPLE_IMAGE,
      languageHints: ['en', 'zh-Hans', 'fr']
    }),
    headers: { 'x-forwarded-for': '203.0.113.10' }
  });

  try {
    const response = await api.handleFetch(request, { GOOGLE_VISION_API_KEY: 'test-only-key' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider, 'google-vision');
    assert.equal(body.text, 'apple 苹果 banana 香蕉');
    assert.equal(body.imageBytes, 8);
    assert.deepEqual(body.items, [
      { word: 'apple', meaning: '苹果' },
      { word: 'banana', meaning: '香蕉' }
    ]);
  } finally {
    global.fetch = originalFetch;
  }

  const upstreamBody = JSON.parse(upstreamRequest.options.body);
  assert.match(upstreamRequest.url, /vision\.googleapis\.com\/v1\/images:annotate$/);
  assert.equal(upstreamRequest.options.headers['X-Goog-Api-Key'], 'test-only-key');
  assert.doesNotMatch(upstreamRequest.url, /test-only-key/);
  assert.deepEqual(upstreamBody.requests[0].imageContext.languageHints, ['en', 'zh-Hans']);
  assert.equal(upstreamBody.requests[0].image.content, 'iVBORw0KGgo=');
});

test('allows GitHub Pages by default and echoes that origin', async () => {
  const request = postRequest('https://word-dictation-ocr.example.workers.dev/', {
    origin: 'https://roubizhao6-sys.github.io',
    method: 'OPTIONS'
  });
  const response = await api.handleFetch(request, {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://roubizhao6-sys.github.io');
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.equal(await response.text(), '');
});

test('allows a comma-separated OCR_ALLOWED_ORIGINS list and rejects other origins', async () => {
  const env = { OCR_ALLOWED_ORIGINS: 'https://other.example, https://roubizhao6-sys.github.io' };
  const allowed = await api.handleFetch(postRequest('https://ocr.example/', {
    origin: 'https://other.example',
    method: 'OPTIONS'
  }), env);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://other.example');

  const pages = await api.handleFetch(postRequest('https://ocr.example/', {
    origin: 'https://roubizhao6-sys.github.io',
    method: 'OPTIONS'
  }), env);
  assert.equal(pages.status, 204);

  const denied = await api.handleFetch(postRequest('https://ocr.example/', {
    origin: 'https://evil.example',
    body: JSON.stringify({ image: SAMPLE_IMAGE })
  }), env);
  const body = await denied.json();
  assert.equal(denied.status, 403);
  assert.equal(body.error, '当前来源不允许调用 OCR 服务');
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('an explicit allowlist replaces the GitHub Pages default', async () => {
  const response = await api.handleFetch(postRequest('https://ocr.example/', {
    origin: 'https://roubizhao6-sys.github.io',
    method: 'OPTIONS'
  }), { OCR_ALLOWED_ORIGINS: 'https://only.example' });
  assert.equal(response.status, 403);
});

test('rejects unsupported methods and oversized declared bodies', async () => {
  const method = await api.handleFetch(new Request('https://example.test/api/ocr', {
    method: 'GET',
    headers: { origin: 'https://example.test' }
  }), {});
  const methodBody = await method.json();
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST, OPTIONS');
  assert.equal(methodBody.error, '只支持 POST');

  const huge = await api.handleFetch(postRequest('https://example.test/api/ocr', {
    origin: 'https://example.test',
    headers: { 'content-length': String(4 * 1024 * 1024) }
  }), {});
  assert.equal(huge.status, 413);
});

test('rate limits repeated calls from the same client', async () => {
  const env = {};
  let last;
  for (let i = 0; i < 10; i += 1) {
    last = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers: { 'x-forwarded-for': '198.51.100.8, 10.0.0.1' },
      body: '{'
    }), env);
    assert.equal(last.status, 400);
  }
  const limited = await api.handleFetch(postRequest('https://example.test/api/ocr', {
    origin: 'https://example.test',
    headers: { 'x-forwarded-for': '198.51.100.8' },
    body: '{'
  }), env);
  const body = await limited.json();
  assert.equal(limited.status, 429);
  assert.equal(body.error, '识别过于频繁，请稍后再试');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);

  const other = await api.handleFetch(postRequest('https://example.test/api/ocr', {
    origin: 'https://example.test',
    headers: { 'cf-connecting-ip': '198.51.100.9' },
    body: '{'
  }), env);
  assert.equal(other.status, 400);
});

test('rate limit uses cf-connecting-ip ahead of a spoofed forwarded header', async () => {
  const headers = {
    'x-forwarded-for': '203.0.113.50',
    'cf-connecting-ip': '203.0.113.77'
  };
  for (let i = 0; i < 10; i += 1) {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers,
      body: '{'
    }), {});
    assert.equal(response.status, 400);
  }
  const spoofed = await api.handleFetch(postRequest('https://example.test/api/ocr', {
    origin: 'https://example.test',
    headers: { 'x-forwarded-for': '203.0.113.50', 'cf-connecting-ip': '203.0.113.78' },
    body: '{'
  }), {});
  assert.equal(spoofed.status, 400);
  const limited = await api.handleFetch(postRequest('https://example.test/api/ocr', {
    origin: 'https://example.test',
    headers,
    body: '{'
  }), {});
  assert.equal(limited.status, 429);
});

test('rejects an image larger than the limit', () => {
  const decoded = Math.floor(2.75 * 1024 * 1024) + 8;
  const encodedLength = Math.ceil(decoded / 3) * 4;
  const image = `data:image/jpeg;base64,${'A'.repeat(encodedLength)}`;
  assert.throws(() => api.parseDataUrl(image), /2\.7 MB/);
});

test('upstream Vision errors stay 502 and do not put the key in the URL', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { message: 'API key not valid' } })
  });
  try {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers: { 'x-forwarded-for': '198.51.100.20' }
    }), { GOOGLE_VISION_API_KEY: 'test-only-key' });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.error, 'API key not valid');
  } finally {
    global.fetch = originalFetch;
  }
});

test('frontend calls a configurable Worker URL instead of Vercel', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const config = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(html, /src="config\.js"/);
  assert.match(html, /window\.OCR_API_URL/);
  assert.match(html, /OCR 服务尚未配置/);
  assert.match(html, /function ocrUserMessage/);
  assert.match(html, /sourceIds/);
  assert.doesNotMatch(html, /vercel/i);
  assert.doesNotMatch(html, /\/api\/ocr/);
  assert.match(config, /window\.OCR_API_URL/);
  assert.match(config, /window\.OCR_API_URL\s*=\s*"https:\/\/word-dictation-ocr\.roubizhao6\.workers\.dev"/);
  assert.doesNotMatch(config, /window\.OCR_API_URL\s*=\s*["'][^"']*YOUR_SUBDOMAIN/);
  assert.match(config, /https:\/\/roubizhao6-sys\.github\.io/);
  assert.doesNotMatch(config, /AIza|GOCSPX|ya29\./);
  assert.match(readme, /wrangler secret put GOOGLE_VISION_API_KEY/);
  assert.match(readme, /wrangler secret put OCR_ALLOWED_ORIGINS/);
  assert.match(readme, /https:\/\/roubizhao6-sys\.github\.io/);
  assert.doesNotMatch(readme, /vercel\.app/i);
  assert.equal(fs.existsSync(path.join(root, 'vercel.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'api/ocr.js')), false);
});
