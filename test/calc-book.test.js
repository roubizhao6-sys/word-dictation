import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('calculus exam wordbook is selectable and plays in-page', () => {
  const js = read('books/calculus.js');
  assert.equal(js.includes('&amp;'), false);
  const sandbox = { window: {} };
  vm.runInNewContext(js, sandbox);
  const books = sandbox.window.BUILTIN_BOOKS;
  assert.equal(books.length, 1);
  const book = books[0];
  assert.equal(book.id, 'calc');
  assert.equal(book.title, '微积分读题词汇');
  assert.equal(book.en, 'Calculus I Harder Exam');
  assert.equal(book.words.length, 112);
  book.words.forEach((word, i) => {
    assert.ok(word.word, `missing en at ${i}`);
    assert.ok(word.meaning, `missing zh at ${i}`);
    assert.ok(word.ctx, `missing ctx at ${i}`);
    assert.match(word.audio, /^https:\/\/translate\.google\.com\/translate_tts\?/);
    assert.equal(word.audio.includes('&amp;'), false);
    assert.equal(word.audio.includes('&'), true);
    assert.ok(word.speak);
    const buf = fs.readFileSync(path.join(root, word.audioLocal));
    assert.ok(buf.length > 500, word.audioLocal);
    const mp3 = buf[0] === 0xff || buf.subarray(0, 3).toString() === 'ID3';
    assert.equal(mp3, true, word.audioLocal);
  });

  const html = read('index.html');
  assert.match(html, /<script src="books\/calculus\.js"><\/script>/);
  assert.match(html, /data-open-book/);
  assert.match(html, /data-drill-book/);
  assert.match(html, /#calc/);
  assert.match(html, /audioLocal/);
  assert.match(html, /playBlobUrl/);
  assert.match(html, /ttsPlay\(w\.speak\|\|w\.word/);
  assert.match(html, /new Audio\(cand\.url\)/);
  assert.doesNotMatch(html, /window\.open/);
  assert.doesNotMatch(html, /target="_blank"/);
  const words = JSON.parse(html.match(/^const WORDS = (.*);$/m)[1]);
  assert.equal(words.length, 689);
  assert.equal(words[0].word, 'moisture');

  const blank = read('empty/index.html');
  assert.doesNotMatch(blank, /books\/calculus\.js/);
  assert.doesNotMatch(blank, /微积分读题词汇/);
  assert.equal(JSON.parse(blank.match(/^const WORDS = (.*);$/m)[1]).length, 0);
});
