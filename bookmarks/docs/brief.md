> Source: brief.md

# Bookmarks — brief

A tiny command-line bookmark manager for developers. Zero dependencies, Node 18+.

## Must have
- Add a bookmark: URL, title, optional tags.
- List bookmarks as readable text.
- Remove a bookmark by id.
- Search bookmarks by tag.

## Nice to have
- Bookmarks survive between runs (stored as JSON in a file).

## Constraints
- No runtime dependencies; tests use `node --test`.
- Keep the store logic separate from output formatting so each is testable alone.

## Out of scope
- Syncing, browser import, a web UI.
