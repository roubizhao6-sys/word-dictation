import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function embeddedWords(html) {
  const match = html.match(/^const WORDS = (.*);$/m);
  assert.ok(match, 'missing const WORDS assignment');
  return JSON.parse(match[1]);
}

test('root page still ships the full built-in word list', () => {
  const words = embeddedWords(read('index.html'));
  const json = JSON.parse(read('words.json'));
  assert.equal(words.length, 689);
  assert.equal(json.length, 689);
  assert.equal(words[0].word, 'moisture');
  assert.equal(words.at(-1).word, 'enormous');
  assert.equal(json[0].word, 'moisture');
  assert.match(read('index.html'), /src="config\.js"/);
  assert.match(read('index.html'), /const LS='dictation_idict_v1'/);
  assert.match(read('index.html'), /const IDB_NAME='word_dictation_db'/);
  assert.doesNotMatch(read('index.html'), /dictation_blank_v1/);
  assert.equal(read('config.js').includes('https://word-dictation-ocr.roubizhao6.workers.dev'), true);
});

test('empty pages path has no bundled words and keeps shared OCR config', () => {
  const html = read('empty/index.html');
  const words = embeddedWords(html);
  assert.deepEqual(words, []);
  assert.equal(JSON.parse(read('empty/words.json')).length, 0);
  const csvLines = read('empty/words.csv').trim().split(/\n/);
  assert.equal(csvLines.length, 1);
  assert.match(csvLines[0], /^序号,单词,/);
  assert.doesNotMatch(html, /moisture/);
  assert.match(html, /src="\.\.\/config\.js"/);
  assert.doesNotMatch(html, /src="config\.js"/);
  assert.match(html, /const LS='dictation_blank_v1'/);
  assert.match(html, /const IDB_NAME='word_dictation_blank_db'/);
  assert.doesNotMatch(html, /dictation_idict_v1/);
  assert.match(html, /暂无单词，请添加/);
  assert.match(html, /https:\/\/roubizhao6-sys\.github\.io\/word-dictation\/empty\//);
  assert.match(html, /拍照导入/);
});

test('empty site generator matches the committed page', () => {
  const result = spawnSync('python3', ['scripts/build-empty-site.py', '--check'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
