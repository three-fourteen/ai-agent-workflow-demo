Status: completed

Goal: Concurrent complete/start/claim calls never lose or corrupt state

Source: review: parallel completions might clash

Context:
writeState in cli/core.js. Write to a temp file then rename; take a short-lived lock around read-modify-write. Document the guarantee in CONTRIBUTING.md.

Dependencies: none

Subtasks:

Done Criteria:
A test runs N parallel complete/start calls and the final state matches a serial run

Verification:

Verify: node --test cli/core.test.js

Next Step:
Proceed to T-002.

Blockers:
None
