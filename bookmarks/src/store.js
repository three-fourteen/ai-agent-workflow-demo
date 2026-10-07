'use strict';

/** In-memory bookmark store. Pure data — no I/O, no formatting. */
function createStore(initial = []) {
  let items = initial.map(b => ({ ...b, tags: [...(b.tags || [])] }));
  let nextId = items.reduce((m, b) => Math.max(m, b.id), 0) + 1;

  return {
    add({ url, title, tags = [] } = {}) {
      if (!url || !String(url).trim()) throw new Error('url is required');
      if (!title || !String(title).trim()) throw new Error('title is required');
      const bookmark = {
        id: nextId++,
        url: String(url).trim(),
        title: String(title).trim(),
        tags: [...new Set(tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))],
      };
      items.push(bookmark);
      return bookmark;
    },
    list() { return items.map(b => ({ ...b, tags: [...b.tags] })); },
    remove(id) {
      const i = items.findIndex(b => b.id === Number(id));
      if (i < 0) return false;
      items.splice(i, 1);
      return true;
    },
    search(tag) {
      const t = String(tag).trim().toLowerCase();
      return items.filter(b => b.tags.includes(t)).map(b => ({ ...b, tags: [...b.tags] }));
    },
  };
}

module.exports = { createStore };
