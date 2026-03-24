This repository uses an AI-native development workflow.

When working on this project:

1. Read PROJECT_STATE.json
2. If current_task exists and is valid, open it
3. Else:
   - scan /tasks
   - resolve dependencies
   - pick next task
4. Execute subtasks
5. Update state
6. If no tasks remain, generate completion artifacts as defined in WORKING_RULES.md.

Do not explore the repository unnecessarily.
Focus on the current task only.
