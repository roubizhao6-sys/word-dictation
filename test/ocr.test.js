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
const BAIDU_ENV = {
  BAIDU_OCR_API_KEY: 'test-api-key',
  BAIDU_OCR_SECRET_KEY: 'test-secret-key'
};

function jsonResult(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

function installBaiduFetch({ tokenPayload, ocrPayload, onToken, onOcr } = {}) {
  const originalFetch = global.fetch;
  const calls = [];
  let tokenCount = 0;
  let ocrCount = 0;
  global.fetch = async (url, options) => {
    const entry = { url: String(url), options };
    calls.push(entry);
    if (entry.url.includes('/oauth/2.0/token')) {
      tokenCount += 1;
      if (onToken) return onToken(entry, tokenCount);
      return jsonResult(200, tokenPayload || { access_token: `tok-${tokenCount}`, expires_in: 2592000 });
    }
    ocrCount += 1;
    if (onOcr) return onOcr(entry, ocrCount);
    return jsonResult(200, ocrPayload || {
      words_result: [
        { words: 'banana 香蕉', location: { top: 80, left: 4 } },
        { words: 'apple 苹果', location: { top: 12, left: 6 } }
      ]
    });
  };
  return {
    calls,
    restore() {
      global.fetch = originalFetch;
    }
  };
}

function postedForm(options) {
  return new URLSearchParams(options.body);
}

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
  assert.doesNotMatch(body.error, /GOOGLE_VISION_API_KEY|BAIDU_OCR|AIza/);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://example.test');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('either missing Baidu secret is not configured, and a Google key is ignored', async () => {
  for (const env of [
    { BAIDU_OCR_API_KEY: 'only-api' },
    { BAIDU_OCR_SECRET_KEY: 'only-secret' },
    { GOOGLE_VISION_API_KEY: 'test-only-key' }
  ]) {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers: { 'x-forwarded-for': '203.0.113.40' }
    }), env);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, 'OCR 服务尚未配置');
    assert.doesNotMatch(body.error, /only-api|only-secret|test-only-key|GOOGLE|BAIDU/);
  }
});

test('handler sends the image to Baidu handwriting and returns structured items', async () => {
  const mock = installBaiduFetch();
  const request = postRequest('https://example.test/api/ocr', {
    origin: 'https://example.test',
    body: JSON.stringify({
      image: SAMPLE_IMAGE,
      languageHints: ['en', 'zh-Hans', 'fr']
    }),
    headers: { 'x-forwarded-for': '203.0.113.10' }
  });

  try {
    const response = await api.handleFetch(request, BAIDU_ENV);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider, 'baidu-ocr');
    assert.equal(body.text, 'apple 苹果 banana 香蕉');
    assert.equal(body.imageBytes, 8);
    assert.deepEqual(body.items, [
      { word: 'apple', meaning: '苹果' },
      { word: 'banana', meaning: '香蕉' }
    ]);
  } finally {
    mock.restore();
  }

  const tokenCall = mock.calls.find(call => call.url.includes('/oauth/2.0/token'));
  const ocrCall = mock.calls.find(call => call.url.includes('/handwriting'));
  const tokenUrl = new URL(tokenCall.url);
  assert.equal(`${tokenUrl.origin}${tokenUrl.pathname}`, 'https://aip.baidubce.com/oauth/2.0/token');
  assert.equal(tokenUrl.searchParams.get('grant_type'), 'client_credentials');
  assert.equal(tokenUrl.searchParams.get('client_id'), 'test-api-key');
  assert.equal(tokenUrl.searchParams.get('client_secret'), 'test-secret-key');
  assert.equal(tokenCall.options.redirect, 'follow');
  const tokenForm = postedForm(tokenCall.options);
  assert.equal(tokenForm.get('grant_type'), 'client_credentials');
  assert.equal(tokenForm.get('client_id'), 'test-api-key');
  assert.equal(tokenForm.get('client_secret'), 'test-secret-key');

  const ocrUrl = new URL(ocrCall.url);
  assert.equal(`${ocrUrl.origin}${ocrUrl.pathname}`, 'https://aip.baidubce.com/rest/2.0/ocr/v1/handwriting');
  assert.equal(ocrUrl.searchParams.get('access_token'), 'tok-1');
  assert.equal(ocrCall.options.redirect, 'follow');
  assert.doesNotMatch(ocrCall.url, /test-api-key|test-secret-key|accurate_basic|vision\.googleapis/);
  const ocrForm = postedForm(ocrCall.options);
  assert.equal(ocrForm.get('image'), 'iVBORw0KGgo=');
  assert.equal(ocrForm.get('eng_granularity'), 'word');
  assert.equal(ocrForm.get('detect_direction'), 'true');
  assert.equal(ocrForm.get('language_type'), 'CHN_ENG');
  assert.equal(mock.calls.length, 2);
});

test('english-only language hints select ENG', async () => {
  const mock = installBaiduFetch({
    ocrPayload: { words_result: [{ words: 'apple' }] }
  });
  try {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      body: JSON.stringify({ image: SAMPLE_IMAGE, languageHints: ['en', 'fr'] }),
      headers: { 'x-forwarded-for': '203.0.113.11' }
    }), BAIDU_ENV);
    assert.equal(response.status, 200);
  } finally {
    mock.restore();
  }
  const ocrCall = mock.calls.find(call => call.url.includes('/handwriting'));
  assert.equal(postedForm(ocrCall.options).get('language_type'), 'ENG');
});

test('reuses a cached Baidu access token until it is near expiry', async () => {
  const mock = installBaiduFetch();
  try {
    for (let i = 0; i < 2; i += 1) {
      const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
        origin: 'https://example.test',
        headers: { 'x-forwarded-for': '203.0.113.12' }
      }), BAIDU_ENV);
      assert.equal(response.status, 200);
    }
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.filter(call => call.url.includes('/oauth/2.0/token')).length, 1);
  assert.equal(mock.calls.filter(call => call.url.includes('/handwriting')).length, 2);
});

test('does not cache an access token that is already inside the refresh window', async () => {
  const mock = installBaiduFetch({
    tokenPayload: { access_token: 'short-lived', expires_in: 30 }
  });
  try {
    for (let i = 0; i < 2; i += 1) {
      const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
        origin: 'https://example.test',
        headers: { 'x-forwarded-for': '203.0.113.13' }
      }), BAIDU_ENV);
      assert.equal(response.status, 200);
    }
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.filter(call => call.url.includes('/oauth/2.0/token')).length, 2);
});

test('concurrent photos share one token request', async () => {
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  let tokenCalls = 0;
  const mock = installBaiduFetch({
    async onToken() {
      tokenCalls += 1;
      await gate;
      return jsonResult(200, { access_token: 'shared-token', expires_in: 2592000 });
    }
  });
  const pending = Promise.all([0, 1].map(index => api.handleFetch(postRequest('https://example.test/api/ocr', {
    origin: 'https://example.test',
    headers: { 'x-forwarded-for': `203.0.113.${50 + index}` }
  }), BAIDU_ENV)));
  try {
    const start = Date.now();
    while (tokenCalls < 1) {
      if (Date.now() - start > 1000) throw new Error('token request did not start');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(tokenCalls, 1);
    release();
    const responses = await pending;
    assert.equal(tokenCalls, 1);
    for (const response of responses) assert.equal(response.status, 200);
  } finally {
    release();
    await pending.catch(() => {});
    mock.restore();
  }
});

test('refreshes an invalid access token once', async () => {
  const mock = installBaiduFetch({
    onOcr(_entry, count) {
      if (count === 1) {
        return jsonResult(200, { error_code: 110, error_msg: 'Access token invalid or no longer valid' });
      }
      return jsonResult(200, { words_result: [{ words: 'apple 苹果' }] });
    }
  });
  try {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers: { 'x-forwarded-for': '203.0.113.14' }
    }), BAIDU_ENV);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.items, [{ word: 'apple', meaning: '苹果' }]);
    assert.doesNotMatch(JSON.stringify(body), /Access token|test-api-key|test-secret-key/);
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.filter(call => call.url.includes('/oauth/2.0/token')).length, 2);
  const tokens = mock.calls
    .filter(call => call.url.includes('/handwriting'))
    .map(call => new URL(call.url).searchParams.get('access_token'));
  assert.deepEqual(tokens, ['tok-1', 'tok-2']);
});

test('allows the mainland origins configured in wrangler.jsonc', async () => {
  const wrangler = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
  const match = wrangler.match(/"OCR_ALLOWED_ORIGINS":\s*"([^"]+)"/);
  assert.ok(match);
  const env = { OCR_ALLOWED_ORIGINS: match[1] };
  const origins = [
    'https://roubizhao6-sys.github.io',
    'http://120.77.70.33',
    'http://tingxieyou.cn',
    'https://tingxieyou.cn',
    'http://www.tingxieyou.cn',
    'https://www.tingxieyou.cn'
  ];
  assert.deepEqual(match[1].split(',').map(value => value.trim()), origins);
  for (const origin of origins) {
    const response = await api.handleFetch(postRequest('https://ocr.example/', {
      origin,
      method: 'OPTIONS'
    }), env);
    assert.equal(response.status, 204, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }
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

test('a still-invalid token becomes a Chinese 502 and hides the Baidu message', async () => {
  const mock = installBaiduFetch({
    onOcr() {
      return jsonResult(200, { error_code: 110, error_msg: 'Access token invalid test-secret-key' });
    }
  });
  try {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers: { 'x-forwarded-for': '203.0.113.15' }
    }), BAIDU_ENV);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.error, 'OCR 上游服务失败，访问凭证无效');
    assert.doesNotMatch(body.error, /test-api-key|test-secret-key|Access token/);
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.filter(call => call.url.includes('/oauth/2.0/token')).length, 2);
});

test('token endpoint failures stay Chinese and do not echo the secret', async () => {
  const mock = installBaiduFetch({
    onToken() {
      return jsonResult(401, { error: 'invalid_client', error_description: 'unknown client id test-secret-key' });
    }
  });
  try {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers: { 'x-forwarded-for': '203.0.113.16' }
    }), BAIDU_ENV);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.error, 'OCR 上游服务失败，无法获取访问凭证（unknown client id）');
    assert.doesNotMatch(JSON.stringify(body), /test-secret-key|test-api-key/);
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.some(call => call.url.includes('/handwriting')), false);
});

test('a token error that is only the secret stays generic', async () => {
  const mock = installBaiduFetch({
    onToken() {
      return jsonResult(401, {
        error: 'invalid_client',
        error_description: 'test-secret-key'
      });
    }
  });
  try {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers: { 'x-forwarded-for': '203.0.113.22' }
    }), BAIDU_ENV);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.error, 'OCR 上游服务失败，无法获取访问凭证');
    assert.doesNotMatch(JSON.stringify(body), /test-secret-key|test-api-key|invalid_client/);
  } finally {
    mock.restore();
  }
});

test('Baidu image and quota errors use Chinese messages', async () => {
  const format = installBaiduFetch({
    onOcr() {
      return jsonResult(200, { error_code: 216201, error_msg: 'image format error' });
    }
  });
  try {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers: { 'x-forwarded-for': '203.0.113.17' }
    }), BAIDU_ENV);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error, '图片格式不受支持，请使用 JPEG 或 PNG');
    assert.doesNotMatch(body.error, /image format error/);
  } finally {
    format.restore();
  }

  const quota = installBaiduFetch({
    onOcr() {
      return jsonResult(200, { error_code: 18, error_msg: 'Open api qps request limit reached' });
    }
  });
  try {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers: { 'x-forwarded-for': '203.0.113.18' }
    }), BAIDU_ENV);
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.error, 'OCR 调用过于频繁，请稍后再试');
  } finally {
    quota.restore();
  }
});

test('network failures do not return the token URL or secret', async () => {
  const mock = installBaiduFetch({
    onToken() {
      throw new Error('connect failed client_secret=test-secret-key');
    }
  });
  try {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers: { 'x-forwarded-for': '203.0.113.19' }
    }), BAIDU_ENV);
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.error, 'OCR 服务暂时不可用');
    assert.doesNotMatch(body.error, /test-secret-key|client_secret/);
  } finally {
    mock.restore();
  }
});

test('an empty handwriting result still returns text and items', async () => {
  const mock = installBaiduFetch({ ocrPayload: { words_result: [], words_result_num: 0 } });
  try {
    const response = await api.handleFetch(postRequest('https://example.test/api/ocr', {
      origin: 'https://example.test',
      headers: { 'x-forwarded-for': '203.0.113.21' }
    }), BAIDU_ENV);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider, 'baidu-ocr');
    assert.equal(body.text, '');
    assert.deepEqual(body.items, []);
  } finally {
    mock.restore();
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
  assert.match(readme, /wrangler secret put BAIDU_OCR_API_KEY/);
  assert.match(readme, /wrangler secret put BAIDU_OCR_SECRET_KEY/);
  assert.match(readme, /wrangler secret put OCR_ALLOWED_ORIGINS/);
  assert.match(readme, /https:\/\/roubizhao6-sys\.github\.io/);
  assert.match(readme, /http:\/\/120\.77\.70\.33/);
  assert.match(readme, /https:\/\/tingxieyou\.cn/);
  assert.match(readme, /https:\/\/www\.tingxieyou\.cn/);
  assert.match(readme, /ocr\/v1\/handwriting/);
  assert.doesNotMatch(readme, /GOOGLE_VISION|Cloud Vision|vision\.googleapis/);
  assert.doesNotMatch(readme, /vercel\.app/i);
  const source = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
  const wrangler = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
  assert.match(source, /aip\.baidubce\.com\/rest\/2\.0\/ocr\/v1\/handwriting/);
  assert.match(source, /eng_granularity/);
  assert.match(source, /extractItems\(rawText\)/);
  assert.doesNotMatch(source, /GOOGLE_VISION|vision\.googleapis|runVisionOcr/);
  assert.match(wrangler, /BAIDU_OCR_API_KEY/);
  assert.match(wrangler, /BAIDU_OCR_SECRET_KEY/);
  assert.doesNotMatch(wrangler, /GOOGLE_VISION_API_KEY/);
  assert.equal(fs.existsSync(path.join(root, 'vercel.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'api/ocr.js')), false);
});
