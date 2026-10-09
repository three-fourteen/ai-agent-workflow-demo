Status: pending

Goal: Choices made during a task live in workflow state, not only in chat

Source: review: no place for decisions

Context:
Optional decisions list on complete_task, stored in the task file and shown in status and the project summary.

Dependencies: T-006

Subtasks:

Done Criteria:
Decisions survive complete and show up in stateSummary

Verification:

Verify: node --test cli/core.test.js cli/mcp_server.test.js

Next Step:
Proceed to T-008.

Blockers:
None
