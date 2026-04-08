# ai-agent-workflow-demo

![AI workflow](docs/workflow-diagram.png)

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

Agents follow a simple loop:

1. Read `.ai/PROJECT_STATE.json`
2. Open the current task in `tasks/`
3. Execute subtasks
4. Update the project state
5. Continue with the next task

Because the **state lives in the repository**, different agents can collaborate without shared memory.

Example relay:

```
Claude → executes task
Gemini → continues
Codex → finishes
```

---

# Installation

### Option A — npx (no install needed)

```bash
npx github:three-fourteen/ai-agent-workflow-demo init my-project
```

> Requires Node.js 18+. npx fetches and runs the CLI in one step — nothing is installed permanently.

### Option B — global install with npm

```bash
npm install -g github:three-fourteen/ai-agent-workflow-demo
agent-workflow --help
afw --help
```

### Uninstall

```bash
npm uninstall -g agent-workflow
```

---

# CLI

A zero-dependency Node.js CLI for scaffolding and managing projects.

```
agent-workflow init <project> [--description "..."]
agent-workflow task add <project> <title> [--description "..."] [--after T-001]
agent-workflow status [project]
agent-workflow start <project>
```

### init

Scaffolds a new project with the full `.ai/` structure and an empty `tasks/` directory.

```
agent-workflow init my-app --description "A SaaS for team time tracking"
```

### task add

Creates the next numbered task file (`T-001-...`, `T-002-...`, etc.) and sets it as `current_task` if none is active.

```
agent-workflow task add my-app "Setup project"
agent-workflow task add my-app "Build dashboard" --after T-001
```

### status

Prints an overview of all projects in the current directory.

```
Project        Phase      Current Task                 Done   Blocked
---------------------------------------------------------------------
my-app         prototype  T-001-setup-project          0/2    no
social-feed    prototype  T-001-setup-project          0/4    no
```

### start

Prints a ready-to-paste prompt to kick off any AI agent on a project.

```
agent-workflow start my-app
```

```
Navigate to my-app/ and follow .ai/AGENT_START_HERE.md to begin working.
Current state: phase=prototype, current_task=T-001-setup-project, blocked=false.
Completed: 0/2 tasks.
```

---

# How to try it

**Option A — use the CLI to create a new project:**

```
agent-workflow init my-project --description "describe your project"
agent-workflow task add my-project "Setup project"
agent-workflow start my-project
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
│   └─ agent_workflow.js
│
├─ docs/
│   └─ workflow-diagram.png
│
├─ social-feed/
├─ dashboard/
└─ mini-saas/
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
