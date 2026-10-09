Status: completed

Goal: A project can finalize while keeping backlog items on record

Source: review: no deferred status

Context:
New status in the state machine, schema, validate and finalize. Deferred tasks do not block finalize and are listed in status.

Dependencies: T-001

Subtasks:

Done Criteria:
finalize succeeds with deferred tasks present; deferred tasks can be reopened

Verification:

Verify: node --test cli/core.test.js cli/agent_workflow.test.js

Next Step:
Proceed to T-005.

Blockers:
None
