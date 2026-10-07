'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/store');

test('add assigns increasing ids and normalises tags', () => {
  const s = createStore();
  const a = s.add({ url: 'https://a.dev', title: 'A', tags: ['Dev', 'dev', ' tools '] });
  const b = s.add({ url: 'https://b.dev', title: 'B' });
  assert.deepEqual([a.id, b.id], [1, 2]);
  assert.deepEqual(a.tags, ['dev', 'tools']);
});

test('add rejects a missing url or title', () => {
  const s = createStore();
  assert.throws(() => s.add({ title: 'x' }), /url is required/);
  assert.throws(() => s.add({ url: 'https://x.dev' }), /title is required/);
});

test('remove deletes by id and reports whether it existed', () => {
  const s = createStore();
  const a = s.add({ url: 'https://a.dev', title: 'A' });
  assert.equal(s.remove(a.id), true);
  assert.equal(s.remove(a.id), false);
  assert.deepEqual(s.list(), []);
});

test('search matches a tag case-insensitively', () => {
  const s = createStore();
  s.add({ url: 'https://a.dev', title: 'A', tags: ['js'] });
  s.add({ url: 'https://b.dev', title: 'B', tags: ['go'] });
  assert.deepEqual(s.search('JS').map(b => b.title), ['A']);
  assert.deepEqual(s.search('rust'), []);
});

test('ids continue after the highest seeded id', () => {
  const s = createStore([{ id: 7, url: 'u', title: 't', tags: [] }]);
  assert.equal(s.add({ url: 'https://n.dev', title: 'N' }).id, 8);
});
