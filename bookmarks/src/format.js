'use strict';

/** Render bookmarks as readable text. Pure function — no I/O. */
function formatBookmarks(bookmarks) {
  if (!bookmarks.length) return 'No bookmarks yet. Add one with: bookmarks add <url> <title> [tags...]';
  return bookmarks
    .map(b => `${String(b.id).padStart(3)}  ${b.title}\n     ${b.url}${b.tags.length ? `\n     #${b.tags.join(' #')}` : ''}`)
    .join('\n');
}

module.exports = { formatBookmarks };
