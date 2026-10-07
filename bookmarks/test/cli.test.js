'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const BIN = join(__dirname, '..', 'bin', 'bookmarks.js');

function withFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bm-cli-'));
  const env = { ...process.env, BOOKMARKS_FILE: join(dir, 'b.json') };
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });
  try { fn(run); } finally { rmSync(dir, { recursive: true }); }
}

test('add, list and search persist between runs', () => withFile(run => {
  assert.match(run('add', 'https://nodejs.org', 'Node', 'js', 'docs').stdout, /Added #1/);
  run('add', 'https://go.dev', 'Go', 'go');
  const list = run('list').stdout;
  assert.match(list, /Node/);
  assert.match(list, /Go/);
  const found = run('search', 'js').stdout;
  assert.match(found, /Node/);
  assert.doesNotMatch(found, /go\.dev/);
}));

test('rm removes a bookmark and reports unknown ids', () => withFile(run => {
  run('add', 'https://a.dev', 'A');
  assert.match(run('rm', '1').stdout, /Removed #1/);
  const again = run('rm', '1');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /no bookmark with id 1/);
  assert.match(run('list').stdout, /No bookmarks yet/);
}));

test('usage on no command, error on a bad one', () => withFile(run => {
  assert.match(run().stdout + run().stderr, /Usage/);
  const bad = run('frobnicate');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown command/);
}));
