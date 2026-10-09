Status: pending

Goal: Free text can contain any line; renaming a title no longer renames the file

Source: review: fragile parser; title rename renames file

Context:
Replace the line-based parser with frontmatter fields and a free-form body. Files become T-007.md. Add a format version and an agent-workflow migrate command for existing projects (bookmarks demo included). Remove RESERVED_LINE_RE.

Dependencies: T-002, T-003, T-004, T-005

Subtasks:

Done Criteria:
Existing projects migrate and validate; titles with 'Goal:' lines round-trip

Verification:

Verify: node --test cli/core.test.js cli/agent_workflow.test.js cli/mcp_server.test.js

Next Step:
Proceed to T-007.

Blockers:
None
