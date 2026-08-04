'use strict';

/**
 * templates.js — embedded scaffolding written by `agent-workflow init`.
 * Kept in one place so both the CLI and the core engine share a single source.
 *
 * The workflow is CLI-owned: state in PROJECT_STATE.json and each task's
 * `Status:` line are mutated ONLY through `agent-workflow` commands, never by
 * hand. This keeps every transition validated and every completion verified.
 */

const AGENT_PLAN_HERE = `\
This repository uses an AI-native development workflow. State lives in Git and is
owned by the \`agent-workflow\` (afw) CLI. Do NOT hand-edit PROJECT_STATE.json or
task files — create tasks with commands so the dependency graph stays valid.

You are in PLANNING mode. Do not implement anything yet.

1. Read PROJECT_STATE.json and .ai/WORKING_RULES.md
2. Ask the user any clarifying questions needed before creating tasks
   (scope, requirements, constraints, priorities). Wait for answers.
3. Create tasks with the CLI (one per unit of work):
     agent-workflow task add "<title>" [--after T-00X]
   Use --after to declare dependencies. Then edit each task file to fill in
   Goal, Context, Subtasks, Done Criteria, and a runnable Verify command.
4. Present the task plan to the user.
5. Run \`agent-workflow validate\` to confirm the graph is sound.

Follow the mode instruction from the command output above.
Do not explore the repository unnecessarily. Do not start implementing.
`;

const AGENT_START_HERE = `\
This repository uses an AI-native development workflow. State lives in Git and is
owned by the \`agent-workflow\` (afw) CLI. Do NOT hand-edit PROJECT_STATE.json or a
task's \`Status:\` line — change state ONLY through commands, so every transition is
validated and every completion is verified.

You are in EXECUTION mode.

1. Run \`agent-workflow status\` to see the current task.
2. Choose a task: use current_task, or run \`agent-workflow next\` for the next
   runnable task (\`--all\` lists every task whose dependencies are satisfied).
3. Claim it:      agent-workflow task start <id>
4. Open tasks/<id>-*.md and implement its Subtasks until the Done Criteria are met.
5. Complete it:   agent-workflow task complete <id>
   This runs the task's Verify command and refuses to complete if it fails.
6. If you cannot proceed:
                  agent-workflow task block <id> --reason "..." --strategy "..."
7. Summarize what you implemented.
8. Follow the mode instruction from the command output above.

Run \`agent-workflow validate\` before finishing. Focus on the current task only.
`;

const WORKING_RULES = `\
Rules for AI agents working in this repository.

State is owned by the \`agent-workflow\` (afw) CLI. Never hand-edit PROJECT_STATE.json
or a task's \`Status:\` line — use commands so transitions stay valid.

## Task lifecycle (state machine)

    pending ──▶ in-progress ──▶ completed
       └──────────▶ blocked ◀──────────┘   (unblock returns a task to pending)

- Start:    agent-workflow task start <id>        (pending → in-progress)
- Complete: agent-workflow task complete <id>     (in-progress → completed; runs Verify)
- Block:    agent-workflow task block <id> --reason "..." [--strategy "..."]
- Unblock:  agent-workflow task unblock <id>       (blocked → pending)

Illegal transitions are rejected by the CLI.

## Task requirements

Each task file must include:
- Status
- Goal
- Context
- Dependencies
- Subtasks
- Done Criteria
- Verification
- Verify        (a shell command that proves the task; exit 0 = pass)
- Next Step
- Blockers

## Selecting work

- Single-task mode: work \`current_task\`.
- Parallel mode: \`agent-workflow next --all\` lists every runnable task (all
  dependencies completed, not already claimed). \`task start\` claims a task; two
  agents cannot claim the same one.

## Verification

\`task complete\` runs the task's \`Verify:\` command and refuses to complete if it
fails. Only use --force with explicit human approval.

## Blocking

\`task block\` sets the project \`blocked\` flag and records block_reason /
unblock_strategy. \`task unblock\` clears it once nothing else is blocked.

## Finalization

When \`agent-workflow next\` reports nothing runnable and no pending tasks remain:

1. Generate:
   - /docs/completion-summary.md
   - /docs/user-story.md
2. Run \`agent-workflow finalize\` to set phase to "completed".

Always run \`agent-workflow validate\` before finishing.
`;

const TASK_TEMPLATE = `\
Status: pending | in-progress | completed | blocked

Goal

Context

Dependencies: none

Subtasks

Done Criteria

Verification

Verify:

Next Step

Blockers
`;

const TASK_INDEX = JSON.stringify(
  {
    mode: 'placeholder',
    notes: 'Reserved for future optimization. Hybrid mode scans /tasks when current_task is missing.',
  },
  null,
  2
);

module.exports = {
  AGENT_PLAN_HERE,
  AGENT_START_HERE,
  WORKING_RULES,
  TASK_TEMPLATE,
  TASK_INDEX,
};
