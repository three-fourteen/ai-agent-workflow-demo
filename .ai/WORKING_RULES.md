Rules for AI agents working in this repository.

State is owned by the `agent-workflow` (afw) CLI. Never hand-edit PROJECT_STATE.json
or a task's `Status:` line — use commands so transitions stay valid.

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

- Single-task mode: work `current_task`.
- Parallel mode: `agent-workflow next --all` lists every runnable task (all
  dependencies completed, not already claimed). `task start` claims a task; two
  agents cannot claim the same one.

## Verification

`task complete` runs the task's `Verify:` command and refuses to complete if it
fails. Only use --force with explicit human approval.

## Blocking

`task block` sets the project `blocked` flag and records block_reason /
unblock_strategy. `task unblock` clears it once nothing else is blocked.

## Finalization

When `agent-workflow next` reports nothing runnable and no pending tasks remain:

1. Generate:
   - /docs/completion-summary.md
   - /docs/user-story.md
2. Run `agent-workflow finalize` to set phase to "completed".

Always run `agent-workflow validate` before finishing.
