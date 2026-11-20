---
name: agent-workflow
description: Plan and execute work through the git-native agent-workflow (afw) task CLI or MCP server. Use when a repo has a .ai/ directory or PROJECT_STATE.json, or when asked to plan, claim, verify or complete tasks.
---

# agent-workflow

State lives in git and is owned by the `agent-workflow` (alias `afw`) CLI or its MCP
server. Never hand-edit `.ai/PROJECT_STATE.json` or a task's `status`.

## Planning (no tasks yet)
1. Read `.ai/AGENT_PLAN_HERE.md` and `.ai/WORKING_RULES.md`.
2. Ask clarifying questions, then draft tasks: MCP `set_brief` -> `plan_project`
   (dry run, shows parallel waves) -> `add_tasks` once the user approves.
   CLI: `agent-workflow task add "<title>" [--after T-001]`.
3. Give every task a runnable `Verify:` command. Run `agent-workflow validate`.

## Executing
1. `agent-workflow next` (`--all` for parallel work) -> `task start <id> --agent NAME`.
2. Implement the task's subtasks until its Done Criteria are met.
3. `task complete <id>` runs `Verify` and refuses to complete on failure.
   If stuck: `task block <id> --reason "..." --strategy "..."`.
4. Record non-obvious choices with `record_decision`. Run `validate` before finishing.

Parallel agents: use a distinct `--agent` name and `worktree <id>` for isolation.
Install: copy this folder to `.claude/skills/agent-workflow/` (or your agent's skills dir).
