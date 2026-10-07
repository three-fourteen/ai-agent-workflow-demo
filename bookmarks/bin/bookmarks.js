#!/usr/bin/env node
'use strict';
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/store');
const { formatBookmarks } = require('../src/format');
const { load, save } = require('../src/persist');

const USAGE = `Usage:
  bookmarks add <url> <title> [tags...]
  bookmarks list
  bookmarks rm <id>
  bookmarks search <tag>

Data file: $BOOKMARKS_FILE (default ~/.bookmarks.json)`;

function run(argv, file) {
  const [cmd, ...args] = argv;
  const store = createStore(load(file));
  switch (cmd) {
    case 'add': {
      const [url, title, ...tags] = args;
      const b = store.add({ url, title, tags });
      save(file, store.list());
      return `Added #${b.id}: ${b.title}`;
    }
    case 'list':
      return formatBookmarks(store.list());
    case 'rm': {
      if (!store.remove(args[0])) throw new Error(`no bookmark with id ${args[0]}`);
      save(file, store.list());
      return `Removed #${args[0]}`;
    }
    case 'search':
      if (!args[0]) throw new Error('search needs a tag');
      return formatBookmarks(store.search(args[0]));
    default:
      throw new Error(cmd ? `unknown command '${cmd}'\n${USAGE}` : USAGE);
  }
}

if (require.main === module) {
  const file = process.env.BOOKMARKS_FILE || path.join(os.homedir(), '.bookmarks.json');
  try {
    console.log(run(process.argv.slice(2), file));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { run };
