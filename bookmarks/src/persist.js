'use strict';
const fs = require('node:fs');

/** Load bookmarks from a JSON file. A missing file is an empty list. */
function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

function save(file, bookmarks) {
  fs.writeFileSync(file, JSON.stringify(bookmarks, null, 2) + '\n', 'utf8');
}

module.exports = { load, save };
