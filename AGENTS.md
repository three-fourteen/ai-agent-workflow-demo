# Agent instructions

This project uses the git-native `agent-workflow` (afw) task workflow. Workflow state
is owned by the CLI (or its MCP server): never hand-edit `.ai/PROJECT_STATE.json` or a
task's `status` field.

- No tasks yet, or asked to plan: read `.ai/AGENT_PLAN_HERE.md`.
- Otherwise: read `.ai/AGENT_START_HERE.md` and follow it.
- Rules for every task: `.ai/WORKING_RULES.md`.

Quick loop: `agent-workflow next` -> `task start <id>` -> implement ->
`task complete <id>` (runs the task's Verify command) -> `validate`.

Claude Code reads `CLAUDE.md`; to share these instructions, put `@AGENTS.md` in it.
