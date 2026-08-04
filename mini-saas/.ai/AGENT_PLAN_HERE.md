This repository uses an AI-native development workflow. State lives in Git and is
owned by the `agent-workflow` (afw) CLI. Do NOT hand-edit PROJECT_STATE.json or
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
5. Run `agent-workflow validate` to confirm the graph is sound.

Follow the mode instruction from the command output above.
Do not explore the repository unnecessarily. Do not start implementing.
