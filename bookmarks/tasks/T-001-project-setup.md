Status: completed

Goal: Create package.json with a test script

Source: brief.md#constraints

Context:

Dependencies: none

Subtasks:

Done Criteria:
npm test runs node --test

Verification:

Verify: node -e "const p=require('./package.json'); if(!p.scripts||!p.scripts.test) process.exit(1)"

Next Step:
Proceed to T-002.

Blockers:
None
