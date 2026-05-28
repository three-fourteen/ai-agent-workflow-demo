This repository uses an AI-native development workflow.

You are in EXECUTION mode.

1. Read PROJECT_STATE.json
2. If current_task exists and is valid, open it
3. Else:
   - scan /tasks
   - resolve dependencies
   - pick next task
4. Execute the task's subtasks
5. When the task is complete:
   - Set Status to completed
   - Add task to completed_tasks in PROJECT_STATE.json
   - Update current_task to the next pending task (or null if none remain)
6. Summarize what you implemented for the completed task
7. Follow the mode instruction from the command output above

Do not explore the repository unnecessarily.
Focus on the current task only.
