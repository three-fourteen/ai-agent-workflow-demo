'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatBookmarks } = require('../src/format');

test('empty list gives a friendly message', () => {
  assert.match(formatBookmarks([]), /No bookmarks yet/);
});

test('renders id, title, url and tags', () => {
  const out = formatBookmarks([{ id: 1, title: 'Node', url: 'https://nodejs.org', tags: ['js', 'docs'] }]);
  assert.match(out, /1  Node/);
  assert.match(out, /https:\/\/nodejs\.org/);
  assert.match(out, /#js #docs/);
});

test('omits the tag line when there are no tags', () => {
  const out = formatBookmarks([{ id: 2, title: 'X', url: 'https://x.dev', tags: [] }]);
  assert.doesNotMatch(out, /#/);
});
