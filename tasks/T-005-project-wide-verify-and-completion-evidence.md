Status: in-progress

Goal: A passing completion means the whole project still works, and the proof is recorded

Source: both reviews: verify only checks exit code

Context:
Optional project-level verify run on every complete_task alongside the task's own. Record verify output and commit SHA in the task file. Add optional verify_expect (output regex) and a red-first warning on start.

Dependencies: T-001

Subtasks:

Done Criteria:
A task whose own check passes but project check fails cannot complete; evidence appears in the task file

Verification:

Verify: node --test cli/core.test.js cli/agent_workflow.test.js cli/mcp_server.test.js

Next Step:
Proceed to T-006.

Blockers:
None
