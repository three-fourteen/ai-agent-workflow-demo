Status: pending

Goal: Changing scope or the verify command of a claimed task takes one call, not five

Source: review: cannot edit a task in progress

Context:
Add task reset (in_progress -> pending, releases the claim, keeps history) and let the claimant update_task description and verify. Expose both in the CLI and MCP server.

Dependencies: T-001

Subtasks:

Done Criteria:
reset and in-progress update_task work from CLI and MCP; non-claimants are refused

Verification:

Verify: node --test cli/core.test.js cli/agent_workflow.test.js cli/mcp_server.test.js

Next Step:
Proceed to T-004.

Blockers:
None
