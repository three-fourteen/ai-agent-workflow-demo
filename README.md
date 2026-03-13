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

# How to try it

Open one of the project folders (for example `social-feed/`) and ask your AI coding agent to:

```
Follow .ai/AGENT_START_HERE.md
```

The agent will:

1. Read the current project state
2. open the active task
3. execute the subtasks
4. update the workflow state

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
