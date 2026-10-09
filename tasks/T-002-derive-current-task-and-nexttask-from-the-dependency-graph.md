Status: pending

Goal: status and complete never point at a stale or null next task under parallel work

Source: review: current_task and Next step assume a line

Context:
selectNextTask and the auto-written 'Proceed to T-00X' lines ignore the graph. Use runnableTasks; drop the Proceed text or replace it with the runnable set.

Dependencies: T-001

Subtasks:

Done Criteria:
Completing a task that unblocks another reports it; current_task is never a task that is not in progress or runnable

Verification:

Verify: node --test cli/core.test.js cli/agent_workflow.test.js

Next Step:
Proceed to T-003.

Blockers:
None
