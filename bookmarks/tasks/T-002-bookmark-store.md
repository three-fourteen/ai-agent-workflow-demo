Status: completed

Goal: In-memory store: add, list, remove, search by tag

Source: brief.md#must-have

Context:

Dependencies: T-001

Subtasks:
1. add({url,title,tags}) returns a bookmark with a numeric id
2. list(), remove(id), search(tag)
3. Reject a missing url or title

Done Criteria:
store tests pass

Verification:

Verify: node --test test/store.test.js

Next Step:
Proceed to T-003.

Blockers:
None
