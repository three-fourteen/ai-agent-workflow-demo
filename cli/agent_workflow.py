#!/usr/bin/env python3
"""
agent_workflow.py — CLI for the git-native AI agent workflow.

Usage (from repo root):
  python cli/agent_workflow.py init <project> [--description "..."]
  python cli/agent_workflow.py task add <project> <title> [--description "..."] [--after T-001]
  python cli/agent_workflow.py status [project]
  python cli/agent_workflow.py start <project>
"""

import argparse
import glob
import json
import os
import re
import sys

# ---------------------------------------------------------------------------
# Embedded templates (mirrors .ai/ files in existing demo projects)
# ---------------------------------------------------------------------------

AGENT_START_HERE = """\
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
"""

WORKING_RULES = """\
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
"""

TASK_TEMPLATE = """\
Status: pending | in-progress | completed | blocked

Goal

Context

Dependencies: none

Subtasks

Done Criteria

Verification

Next Step

Blockers
"""

TASK_INDEX = json.dumps(
    {
        "mode": "placeholder",
        "notes": "Reserved for future optimization. Hybrid mode scans /tasks when current_task is missing.",
    },
    indent=2,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def slugify(text):
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    return text.strip("-")


def read_state(project_dir):
    state_path = os.path.join(project_dir, ".ai", "PROJECT_STATE.json")
    if not os.path.isfile(state_path):
        sys.exit(f"Error: {state_path} not found. Is '{project_dir}' a valid project?")
    with open(state_path) as f:
        return json.load(f)


def write_state(project_dir, state):
    state_path = os.path.join(project_dir, ".ai", "PROJECT_STATE.json")
    with open(state_path, "w") as f:
        json.dump(state, f, indent=2)
        f.write("\n")


def count_tasks(project_dir):
    return len(glob.glob(os.path.join(project_dir, "tasks", "T-*.md")))


def next_task_id(project_dir):
    return count_tasks(project_dir) + 1


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_init(args):
    project = args.project
    description = args.description or ""

    if os.path.exists(project):
        sys.exit(f"Error: '{project}' already exists.")

    ai_dir = os.path.join(project, ".ai")
    tasks_dir = os.path.join(project, "tasks")
    os.makedirs(ai_dir)
    os.makedirs(tasks_dir)

    with open(os.path.join(ai_dir, "AGENT_START_HERE.md"), "w") as f:
        f.write(AGENT_START_HERE)

    with open(os.path.join(ai_dir, "WORKING_RULES.md"), "w") as f:
        f.write(WORKING_RULES)

    with open(os.path.join(ai_dir, "TASK_TEMPLATE.md"), "w") as f:
        f.write(TASK_TEMPLATE)

    with open(os.path.join(ai_dir, "TASK_INDEX.json"), "w") as f:
        f.write(TASK_INDEX + "\n")

    state = {
        "project": project,
        "phase": "prototype",
        "current_task": None,
        "blocked": False,
        "completed_tasks": [],
    }
    if description:
        state["description"] = description
    write_state(project, state)

    print(f"Initialized project '{project}'")
    print(f"  {ai_dir}/")
    print(f"  {tasks_dir}/")
    print()
    print("Next: add tasks with:")
    print(f"  python cli/agent_workflow.py task add {project} \"<task title>\"")


def cmd_task_add(args):
    project = args.project
    title = args.title
    description = args.description or title
    after = args.after or None

    if not os.path.isdir(project):
        sys.exit(f"Error: project '{project}' not found.")

    n = next_task_id(project)
    task_id = f"T-{n:03d}"
    slug = slugify(title)
    filename = f"{task_id}-{slug}.md"
    task_path = os.path.join(project, "tasks", filename)

    deps = after if after else "none"
    next_n = n + 1
    next_step = f"Proceed to T-{next_n:03d}."

    content = f"""\
Status: pending

Goal: {description}

Context:

Dependencies: {deps}

Subtasks:

Done Criteria:

Verification:

Next Step:
{next_step}

Blockers:
None
"""

    with open(task_path, "w") as f:
        f.write(content)

    state = read_state(project)
    if not state.get("current_task"):
        state["current_task"] = task_id
        write_state(project, state)
        print(f"Created {task_path}  (set as current_task)")
    else:
        print(f"Created {task_path}")


def cmd_status(args):
    filter_project = args.project if hasattr(args, "project") else None

    pattern = "*/.ai/PROJECT_STATE.json"
    state_files = sorted(glob.glob(pattern))

    if not state_files:
        print("No projects found in current directory.")
        return

    col_w = [14, 10, 28, 6, 8]
    header = (
        f"{'Project':<{col_w[0]}} {'Phase':<{col_w[1]}} {'Current Task':<{col_w[2]}}"
        f" {'Done':<{col_w[3]}} {'Blocked'}"
    )
    divider = "-" * len(header)
    print(header)
    print(divider)

    for sf in state_files:
        project_dir = os.path.dirname(os.path.dirname(sf))
        project_name = os.path.basename(project_dir)

        if filter_project and project_name != filter_project:
            continue

        try:
            with open(sf) as f:
                state = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        phase = state.get("phase", "?")
        current = state.get("current_task") or "-"
        completed = len(state.get("completed_tasks", []))
        total = count_tasks(project_dir)
        blocked = "yes" if state.get("blocked") else "no"
        done = f"{completed}/{total}"

        print(
            f"{project_name:<{col_w[0]}} {phase:<{col_w[1]}} {current:<{col_w[2]}}"
            f" {done:<{col_w[3]}} {blocked}"
        )


def cmd_start(args):
    project = args.project

    if not os.path.isdir(project):
        sys.exit(f"Error: project '{project}' not found.")

    state = read_state(project)
    phase = state.get("phase", "prototype")
    current = state.get("current_task") or "none"
    blocked = state.get("blocked", False)
    completed = len(state.get("completed_tasks", []))
    total = count_tasks(project)

    print(f"Navigate to {project}/ and follow .ai/AGENT_START_HERE.md to begin working.")
    print(
        f"Current state: phase={phase}, current_task={current}, blocked={str(blocked).lower()}."
    )
    print(f"Completed: {completed}/{total} tasks.")


# ---------------------------------------------------------------------------
# Argument parser
# ---------------------------------------------------------------------------


def build_parser():
    parser = argparse.ArgumentParser(
        prog="agent_workflow",
        description="CLI for the git-native AI agent workflow.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # init
    p_init = sub.add_parser("init", help="Scaffold a new project")
    p_init.add_argument("project", help="Project name (becomes directory name)")
    p_init.add_argument("--description", "-d", help="Short project description")
    p_init.set_defaults(func=cmd_init)

    # task
    p_task = sub.add_parser("task", help="Manage tasks")
    task_sub = p_task.add_subparsers(dest="task_command", required=True)

    p_task_add = task_sub.add_parser("add", help="Add a new task to a project")
    p_task_add.add_argument("project", help="Project name")
    p_task_add.add_argument("title", help="Task title")
    p_task_add.add_argument("--description", "-d", help="Task goal/description")
    p_task_add.add_argument("--after", help="Dependency task ID (e.g. T-001)")
    p_task_add.set_defaults(func=cmd_task_add)

    # status
    p_status = sub.add_parser("status", help="Show project status")
    p_status.add_argument("project", nargs="?", help="Filter to a single project")
    p_status.set_defaults(func=cmd_status)

    # start
    p_start = sub.add_parser("start", help="Print agent start prompt for a project")
    p_start.add_argument("project", help="Project name")
    p_start.set_defaults(func=cmd_start)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
