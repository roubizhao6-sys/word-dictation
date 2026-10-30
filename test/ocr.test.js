'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/ocr');
const { _test } = handler;

test('extracts English words with optional Chinese meanings', () => {
  const items = _test.extractItems(`
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
  const items = _test.extractItems('apple\n苹果\nbanana\n香蕉');
  assert.deepEqual(items, [
    { word: 'apple', meaning: '苹果' },
    { word: 'banana', meaning: '香蕉' }
  ]);
});

test('handles several pairs on one line and deduplicates words', () => {
  const items = _test.extractItems(`
    apple 苹果 banana 香蕉
    apple 苹果（重复）
  `);
  assert.deepEqual(items, [
    { word: 'apple', meaning: '苹果' },
    { word: 'banana', meaning: '香蕉' }
  ]);
});

test('keeps English-only words and strips list numbering', () => {
  assert.equal(_test.stripListMarker('12. procedure'), 'procedure');
  assert.deepEqual(_test.extractItems('12. procedure\n13. moisture 水分'), [
    { word: 'procedure', meaning: '' },
    { word: 'moisture', meaning: '水分' }
  ]);
});

test('rejects non-image data URLs', () => {
  assert.throws(() => _test.parseDataUrl('data:text/plain;base64,SGVsbG8='), /JPEG/);
});

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; }
  };
}

test('handler returns 503 when the server key is missing', async () => {
  const previous = process.env.GOOGLE_VISION_API_KEY;
  delete process.env.GOOGLE_VISION_API_KEY;
  const req = {
    method: 'POST',
    headers: { origin: 'https://example.test', host: 'example.test', 'content-length': '80' },
    body: { image: 'data:image/png;base64,iVBORw0KGgo=' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  const res = mockResponse();
  await handler(req, res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /GOOGLE_VISION_API_KEY/);
  if (previous === undefined) delete process.env.GOOGLE_VISION_API_KEY;
  else process.env.GOOGLE_VISION_API_KEY = previous;
});

test('handler sends the image to Vision and returns structured items', async () => {
  const previous = process.env.GOOGLE_VISION_API_KEY;
  process.env.GOOGLE_VISION_API_KEY = 'test-only-key';
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

  const req = {
    method: 'POST',
    headers: { origin: 'https://example.test', host: 'example.test', 'content-length': '100' },
    body: { image: 'data:image/png;base64,iVBORw0KGgo=', languageHints: ['en', 'zh-Hans'] },
    socket: { remoteAddress: '127.0.0.2' }
  };
  const res = mockResponse();

  try {
    await handler(req, res);
  } finally {
    global.fetch = originalFetch;
    if (previous === undefined) delete process.env.GOOGLE_VISION_API_KEY;
    else process.env.GOOGLE_VISION_API_KEY = previous;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'google-vision');
  assert.deepEqual(res.body.items, [
    { word: 'apple', meaning: '苹果' },
    { word: 'banana', meaning: '香蕉' }
  ]);
  assert.match(upstreamRequest.url, /vision\.googleapis\.com/);
  assert.equal(upstreamRequest.options.headers['X-Goog-Api-Key'], 'test-only-key');
  assert.doesNotMatch(upstreamRequest.url, /test-only-key/);
});
