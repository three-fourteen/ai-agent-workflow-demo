# ai-agent-workflow-demo

A demonstration of **Git-native task orchestration for AI coding agents**.

This repository explores a simple idea:
AI agents can collaborate on software projects by **sharing workflow state directly inside the repository**.

Instead of relying on chat history or external tools, agents coordinate through:

- `.ai/PROJECT_STATE.json` → current project state
- `tasks/*.md` → structured work units
- `.ai/AGENT_START_HERE.md` → deterministic entry point

This allows **multiple agents to continue the same project across sessions**.

---

# Why this exists

Current AI coding tools are excellent at **writing code**, but they lack a simple way to **coordinate work across agents and sessions**.

Typical workflow:

Agent → code → session ends → context lost.

This repository explores a lightweight alternative:

Store the **project workflow directly in Git using Markdown and JSON**.

Agents read the current state, execute tasks, and update the repository so the next agent can continue.

---

# Projects included

This demo contains three small projects that use the same workflow:

### social-feed

Minimal Threads/X-style social feed UI.

Tasks include:

- project setup
- fetching UI mockups from Stitch
- building feed layout
- adding interaction buttons

### dashboard

Simple analytics dashboard.

Tasks include:

- project setup
- dashboard layout
- charts
- mock API data

### mini-saas

Minimal SaaS flow.

Tasks include:

- landing page
- signup UI
- fake authentication
- user dashboard

### bookmarks

A working zero-dependency CLI bookmark manager, built **end to end through the MCP
tools** starting from `bookmarks/brief.md`: `init_project` (in place) → `set_brief` →
`plan_project` → `add_tasks` → `start_task` / `complete_task` with real `Verify:`
commands. It also shows mid-run re-planning (`remove_task`, `add_tasks`, `update_task`).
Unlike the other demos it contains real code: `cd bookmarks && npm test`.

Each project contains:

```
.ai/
  AGENT_START_HERE.md
  PROJECT_STATE.json
  WORKING_RULES.md
  TASK_TEMPLATE.md

tasks/
```

---

# How the workflow works

State is **owned by the CLI**, not hand-edited. Agents change state only through
commands, so every transition is validated and every completion is verified.

Agents follow a simple loop:

1. `agent-workflow next` — find the next runnable task (dependencies satisfied, unclaimed)
2. `agent-workflow task start <id>` — claim it (pending → in-progress)
3. Implement the task's subtasks
4. `agent-workflow task complete <id>` — runs the task's `Verify` command, then marks it completed (in-progress → completed)
5. Repeat; `agent-workflow validate` before finishing

Tasks move through a guarded state machine — illegal transitions are rejected:

```
pending ──▶ in-progress ──▶ completed
   └──────────▶ blocked ◀──────────┘   (unblock returns a task to pending)
```

Because the **state lives in the repository**, different agents can collaborate without shared memory.
Multiple agents can work in parallel: `agent-workflow next --all` lists every independent
runnable task, and `agent-workflow task start` claims one atomically so two agents never
pick up the same work.

Example relay:

```
Claude → executes task
Gemini → continues
Codex → finishes
```

---

# Installation

### Option A — npx (one-shot, no install)

Use npx to scaffold a project without installing anything permanently:

```bash
npx github:three-fourteen/ai-agent-workflow-demo init my-project
```

> Requires Node.js 18+. npx runs `init` only — for `task add`, `status`, and `start` use Option B (global install) or prefix each command with `npx github:three-fourteen/ai-agent-workflow-demo`.

### Option B — global install with npm

```bash
npm install -g github:three-fourteen/ai-agent-workflow-demo
agent-workflow --help
afw --help
```

### Option C — clone and link (works on any npm version)

```bash
git clone https://github.com/three-fourteen/ai-agent-workflow-demo
cd ai-agent-workflow-demo && npm install && npm link
agent-workflow --help
```

### Troubleshooting: `EALLOWGIT`

```
npm error code EALLOWGIT
npm error Fetching packages of type "git" have been disabled
```

npm 12 and later refuse git-hosted packages (`github:…`) by default
([`allow-git`](https://docs.npmjs.com/cli/v12/using-npm/config)). Either use Option C,
or opt in for a single command:

```bash
npm install -g github:three-fourteen/ai-agent-workflow-demo --allow-git=all
npx --allow-git=all github:three-fourteen/ai-agent-workflow-demo init my-project
# or: NPM_CONFIG_ALLOW_GIT=all npx github:three-fourteen/ai-agent-workflow-demo init my-project
```

The MCP server needs a local checkout either way, so register it with an absolute path:

```bash
claude mcp add agent-workflow -- node /ABSOLUTE/PATH/ai-agent-workflow-demo/cli/mcp_server.js .
```

### Uninstall

```bash
npm uninstall -g agent-workflow
```

---

# CLI

A Node.js CLI for scaffolding and driving projects. The **core has no runtime
dependencies**; the optional MCP server (`agent-workflow mcp`) is the one exception
and uses the official `@modelcontextprotocol/sdk`, loaded lazily only when started.

```
agent-workflow init [<project>] [--description "..."]
agent-workflow task add [<project>] <title> [--description "..."] [--after T-001]
agent-workflow task start [<project>] <id> [--agent NAME]
agent-workflow task complete [<project>] <id> [--force] [--no-verify]
agent-workflow task verify [<project>] <id>
agent-workflow task block [<project>] <id> --reason "..." [--strategy "..."]
agent-workflow task unblock [<project>] <id>
agent-workflow next [<project>] [--all] [--json]
agent-workflow claim [<project>] <id> [--agent NAME]
agent-workflow release [<project>] <id>
agent-workflow worktree [<project>] <id>
agent-workflow status [<project>]
agent-workflow validate [<project>]
agent-workflow finalize [<project>]
agent-workflow mcp [<project>]
agent-workflow plan [<project>] [--execute]
agent-workflow start [<project>] [--all]
```

### init

Scaffolds a new project with the full `.ai/` structure and an empty `tasks/` directory.

Pass a name to create a new subdirectory, or omit it to initialise inside the current folder.

```
agent-workflow init my-app --description "A SaaS for team time tracking"
agent-workflow init --description "Working in the current directory"
```

### task add

Creates the next numbered task file (`T-001-...`, `T-002-...`, etc.) and sets it as `current_task` if none is active.

Pass a project name explicitly, or omit it when running from inside a project directory.

```
agent-workflow task add my-app "Setup project"
agent-workflow task add my-app "Build dashboard" --after T-001

# from inside the project directory:
agent-workflow task add "Setup project"
```

### status

Prints an overview of projects. When run from inside a project directory it shows that project; otherwise it scans subdirectories.

```
Project        Phase      Current Task                 Done   Blocked
---------------------------------------------------------------------
my-app         prototype  T-001-setup-project          0/2    no
social-feed    prototype  T-001-setup-project          0/4    no
```

### task start / complete / block / unblock

The CLI owns state transitions. Agents never hand-edit `PROJECT_STATE.json` or a
task's `Status:` line — they call these commands, and the CLI enforces the state
machine.

```
agent-workflow task start T-001            # pending → in-progress (claims the task)
agent-workflow task complete T-001         # in-progress → completed (runs Verify first)
agent-workflow task block T-001 --reason "waiting on API keys" --strategy "ask user"
agent-workflow task unblock T-001          # blocked → pending
```

Illegal transitions (e.g. completing a task that was never started) are rejected.

### task verify / verification-gated completion

Each task file has a `Verify:` line — a shell command that proves the task is done
(exit 0 = pass). `task complete` runs it first and **refuses to complete on failure**.

```
agent-workflow task verify T-001           # run the check on its own
agent-workflow task complete T-001         # blocked if Verify fails
agent-workflow task complete T-001 --force # override (records it as unverified)
agent-workflow task complete T-001 --no-verify   # accept a task that has no Verify command
```

### next

Prints the runnable tasks — pending, all dependencies completed, and not already
claimed. `--all` lists every independent task (the parallel fan-out set); `--json`
emits machine-readable output.

```
agent-workflow next               # the single next task
agent-workflow next --all         # every task that can run right now
agent-workflow next --all --json
```

### claim / release

Atomically claim a task so parallel agents never pick up the same work. `task start`
claims automatically; use these for explicit locking. Locks live in `.ai/locks/`
(git-ignored) and are created race-safe.

```
agent-workflow claim T-002 --agent alice
agent-workflow release T-002
```

### worktree

Creates a git worktree on a `task/<id>-...` branch (placed beside the repo) so an
agent can work a task in isolation while others run in parallel.

```
agent-workflow worktree T-002
```

### validate

Checks the state file and task graph — schema shape, referential integrity,
dependency cycles, and consistency between task statuses and `PROJECT_STATE.json`.
Exits non-zero on any problem, so it works as a git pre-commit hook.

```
agent-workflow validate
```

### mcp

Starts a Model Context Protocol server over stdio, exposing the workflow as typed
tools. Git stays the source of truth; MCP is just a typed interface over the same
file mutations.

| Group | Tool | What it does |
|---|---|---|
| Read | `get_state` | Read `PROJECT_STATE.json` |
| | `list_tasks` | All tasks with status, dependencies and verify command |
| | `get_task` | One task, including its raw file |
| | `next_tasks` | Runnable tasks: pending, dependencies done, unclaimed (`all=false` for just the first) |
| | `validate` | Check the state file and task graph → `{ ok, errors }` |
| Execute | `start_task` | Claim a task (atomic lock) and move it `pending → in-progress` |
| | `verify_task` | Run a task's `Verify:` command without changing status (optional `workdir`) |
| | `complete_task` | Run `Verify:` first, then `in-progress → completed`; refuses on failure (optional `workdir`) |
| | `block_task` / `unblock_task` | Mark a task blocked with a reason, or return it to pending |
| | `release_task` | Clear a stale lock without changing status |
| | `create_worktree` | Isolate a task on its own git worktree and branch (see below) |
| Bootstrap | `init_project` | Scaffold a project (`name: "."` for in place) |
| | `set_brief` | Store the source brief text in `docs/brief.md` |
| | `plan_project` | Dry-run a task plan; returns resolved ids and parallel `waves`, writes nothing |
| | `add_tasks` | Write an approved plan atomically (all tasks or none) |
| Re-plan | `update_task` | Edit a pending, unclaimed task in place |
| | `remove_task` | Delete a pending, unclaimed task nothing depends on |

Every tool except `init_project` takes an optional `project` directory.

MCP deliberately omits `--force`: skipping verification is CLI-only. The optional
`project` argument must stay inside the directory the server was launched in.
`release_task` clears a stale lock left by a crashed agent.

#### Parallel agents in git worktrees

Locks stop two agents claiming the same task, but not editing the same files. To give
each agent its own copy of the code:

1. `start_task` — claim it (pass your own `agent` name, e.g. `codex`).
2. `create_worktree` — creates `task/<id>-<slug>` in a worktree beside the repo and
   returns its `path`.
3. Edit and commit **code** in that worktree.
4. Keep making **state** changes (`complete_task`, `block_task`, …) through the MCP
   tools. The server serves the main checkout, so state and locks stay in one place.
5. Pass the worktree `path` as `workdir` to `verify_task` / `complete_task`, so the
   `Verify:` command runs against the branch instead of the main checkout.

`workdir` is only accepted if git lists it as a worktree of the same repository, and the
command runs in the same sub-path as the project (so projects in a subdirectory work).
Merging the branch and removing the worktree (`git worktree remove`) is left to you.

#### Starting a project from a brief

The MCP can bootstrap a project from any source. It never fetches the brief
itself: the agent reads it (a file, Asana, anything) and passes the text in.

1. `init_project` — `name: "."` initialises the served directory, or a new subdirectory.
2. `set_brief` — stores the brief text in `docs/brief.md` with an opaque `source` ref.
3. `plan_project` — **dry run**. Validates the proposed tasks and returns resolved ids
   and parallel `waves`; writes nothing. Works before `init_project`.
4. `add_tasks` — writes the approved plan atomically (all tasks or none) and echoes
   every `verify` command so it can be reviewed.

Tasks in a plan reference each other by a local `key`; ids (`T-001`…) are assigned
on write. Free text may not contain lines starting with `Status:`, `Dependencies:`,
`Goal:`, `Verify:` or `Source:`, since the task parser would read them as fields.

#### Re-planning

Plans change. Tasks that haven't started can be edited without touching files by hand:

- `update_task` — patches only the fields you pass (`title`, `goal`, `context`,
  `depends_on` as task ids, `subtasks`, `done_criteria`, `verify`, `source`).
  Everything else in the file is preserved. Changing `title` renames the file.
  Unknown dependencies and cycles are rejected.
- `remove_task` — deletes a task nothing else depends on, and repoints
  `current_task` if needed.

Both refuse tasks that are in-progress, completed, blocked or claimed. Task ids are
never renumbered or reused: `PROJECT_STATE.json` keeps a `max_task_id` high-water mark,
so a removed task's id stays retired and references to it (commits, `Source:` notes)
can't silently point at a different task.

```
agent-workflow mcp                # serve the current project
```

### plan

Prints a ready-to-paste prompt that puts the agent into planning mode — it will ask clarifying questions and create tasks before writing any code.

`--execute` tells the agent to proceed straight to execution after the plan is accepted.

```
agent-workflow plan my-app
agent-workflow plan my-app --execute
agent-workflow plan          # from inside the project directory
```

### start

Prints a ready-to-paste prompt that puts the agent into execution mode on the current task.

`--all` tells the agent to keep executing tasks until none remain (instead of stopping after one).

```
agent-workflow start my-app
agent-workflow start my-app --all
agent-workflow start          # from inside the project directory
```

```
Navigate to my-app/ and follow .ai/AGENT_START_HERE.md to begin working.
Mode: single-task — after completing and summarizing one task, ask the user whether to continue with the next task and stop.
Current state: phase=prototype, current_task=T-001, blocked=false.
Completed: 0/2 tasks.
```

---

# How to try it

**Option A — use the CLI to create a new project:**

From a parent directory (creates a `my-project/` subfolder):

```
agent-workflow init my-project --description "describe your project"
agent-workflow task add my-project "Setup project"
agent-workflow start my-project
```

Or from inside an existing directory (no subfolder created):

```
cd my-project
agent-workflow init --description "describe your project"
agent-workflow task add "Setup project"
agent-workflow start
```

Paste the output of `start` into your AI coding agent and it will take it from there.

**Option B — use one of the included demo projects:**

Open a project folder (for example `social-feed/`) and ask your AI coding agent to:

```
Follow .ai/AGENT_START_HERE.md
```

The agent will:

1. Read the current project state
2. Open the active task
3. Execute the subtasks
4. Update the workflow state

Tested with:

- Claude Code
- Gemini CLI
- OpenAI Codex

---

# Repository structure

```
ai-agent-workflow-demo
│
├─ README.md
├─ LICENSE
│
├─ package.json
│
├─ cli/
│   ├─ agent_workflow.js   # thin CLI: arg parsing + output
│   ├─ core.js             # workflow engine: parser, state machine, scheduler, validation
│   ├─ templates.js        # embedded .ai/ scaffolding
│   └─ mcp_server.js       # MCP server over the engine (optional)
│
├─ schema/
│   └─ project-state.schema.json
│
├─ social-feed/
├─ dashboard/
├─ mini-saas/
└─ bookmarks/            # built end to end via the MCP (has real code + tests)
```

Each project is independent and demonstrates the same AI workflow pattern.

---

# Key idea

**Agents coordinate through Git, not through chat history.**

By keeping tasks and state inside the repository, development becomes:

- reproducible
- transparent
- agent-agnostic
- session-independent

---

# Keywords

ai agents, agentic workflows, ai coding tools, llm development workflow,
multi-agent development, repo-native workflow, ai-assisted development

---

# License

MIT License
