This repository uses an AI-native development workflow. State lives in Git and is
owned by the `agent-workflow` (afw) CLI. Do NOT hand-edit PROJECT_STATE.json or a
task's `Status:` line — change state ONLY through commands, so every transition is
validated and every completion is verified.

You are in EXECUTION mode.

1. Run `agent-workflow status` to see the current task.
2. Choose a task: use current_task, or run `agent-workflow next` for the next
   runnable task (`--all` lists every task whose dependencies are satisfied).
3. Claim it:      agent-workflow task start <id>
4. Open tasks/<id>-*.md and implement its Subtasks until the Done Criteria are met.
5. Complete it:   agent-workflow task complete <id>
   This runs the task's Verify command and refuses to complete if it fails.
6. If you cannot proceed:
                  agent-workflow task block <id> --reason "..." --strategy "..."
7. Summarize what you implemented.
8. Follow the mode instruction from the command output above.

Run `agent-workflow validate` before finishing. Focus on the current task only.
