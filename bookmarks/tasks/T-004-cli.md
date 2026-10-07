Status: completed

Goal: bookmarks add|list|rm|search wired to store and formatter

Source: brief.md#must-have

Context:
Data file path comes from BOOKMARKS_FILE (default ~/.bookmarks.json). Load on start, save after every mutation.

Dependencies: T-002, T-003, T-005

Subtasks:

Done Criteria:

Verification:

Verify: node --test test/cli.test.js

Next Step:
Proceed to T-005.

Blockers:
None
