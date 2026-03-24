Rules for AI agents working in this repository.

- Only one task may be in progress.

## Task Requirements

All tasks must include:
- Status
- Goal
- Context
- Dependencies
- Subtasks
- Done Criteria
- Verification
- Next Step
- Blockers

## Task Selection

- `current_task` is optional in hybrid mode.
- If `current_task` exists and matches a task file, use it.
- If `current_task` is null, missing, or invalid, scan `/tasks`, ignore tasks with `Status: completed` or `Status: blocked`, and pick the first task whose dependencies are all listed in `completed_tasks`.
- If no task qualifies, trigger finalization.

## When completing a task

1. Set Status to completed
2. Add task to completed_tasks in PROJECT_STATE.json
3. Select next task
4. Update next_step

## When blocked

1. Set blocked=true in PROJECT_STATE.json
2. Add:
   - block_reason
   - unblock_strategy
3. Update task file Blockers section

## Finalization step

If:
- current_task is null or no valid task can be selected
- no pending tasks exist

Then:

1. Generate:
   - /docs/completion-summary.md
   - /docs/user-story.md
2. Update PROJECT_STATE.json:
   "phase": "completed"
