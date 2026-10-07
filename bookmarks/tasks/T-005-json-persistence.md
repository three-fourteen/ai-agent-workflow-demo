Status: completed

Goal: Load and save bookmarks as JSON in a file so they survive between runs

Source: brief.md#nice-to-have

Context:

Dependencies: T-002

Subtasks:

Done Criteria:
round-trip test passes; a missing file loads as an empty list

Verification:

Verify: node --test test/persist.test.js

Next Step:
None.

Blockers:
None
