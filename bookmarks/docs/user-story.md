# User Story

As a developer,
I can save, list, remove and tag-search bookmarks from my terminal,

So that I can keep useful links at hand without leaving the command line.

## Features included

- `bookmarks add <url> <title> [tags...]`
- `bookmarks list`, `bookmarks rm <id>`, `bookmarks search <tag>`
- Bookmarks persist as JSON (`$BOOKMARKS_FILE`, default `~/.bookmarks.json`)
- Zero runtime dependencies; tests use `node --test`

## Future improvements

- Browser bookmark import
- Edit an existing bookmark
- Duplicate-URL detection
