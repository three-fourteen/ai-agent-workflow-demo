'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { load, save } = require('../src/persist');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bm-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true }); }
}

test('a missing file loads as an empty list', () => withDir(dir => {
  assert.deepEqual(load(join(dir, 'nope.json')), []);
}));

test('save then load round-trips', () => withDir(dir => {
  const file = join(dir, 'b.json');
  const data = [{ id: 1, url: 'https://a.dev', title: 'A', tags: ['x'] }];
  save(file, data);
  assert.deepEqual(load(file), data);
}));

test('a corrupt file raises a readable error', () => withDir(dir => {
  const file = join(dir, 'bad.json');
  writeFileSync(file, '{not json');
  assert.throws(() => load(file), /cannot read/);
}));
