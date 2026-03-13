Rules for AI agents working in this repository.

- Only one task may be in progress
- Tasks must include:
  Status
  Goal
  Context
  Subtasks
  Done Criteria
  Dependencies
  Blockers

When a task is completed:

1. Update its Status to completed
2. Add it to completed_tasks in PROJECT_STATE.json
3. Set the next task

When a task cannot continue:

1. Set blocked=true in PROJECT_STATE.json
2. Write block_reason
3. Document unblock strategy
