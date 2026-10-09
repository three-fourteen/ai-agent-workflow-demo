# Contributing

Contributions are welcome. If you improve the workflow or test with other agents, please open a PR.

## Development setup

Requires Node.js 18+.

```bash
git clone https://github.com/three-fourteen/ai-agent-workflow-demo
cd ai-agent-workflow-demo
npm install
```

The CLI **core** (scaffolding and all state commands) uses only Node.js built-ins.
The one dependency, `@modelcontextprotocol/sdk`, is used solely by the optional MCP
server (`agent-workflow mcp`) and is loaded lazily — every other command runs
without it.

## Running tests

```bash
npm test
```

76 tests using Node's built-in `node:test` runner, across:

- `cli/core.test.js` — the engine: task parsing, the state machine, verification, the scheduler, locks, and validation
- `cli/agent_workflow.test.js` — the CLI surface: every command, flags, and error paths
- `cli/mcp_server.test.js` — the MCP server, driven over stdio with the official MCP client

## Architecture

- `cli/core.js` — the workflow engine. Pure-ish functions that read and mutate
  on-disk state and **throw `WorkflowError`** (never `console.log` / `process.exit`),
  so the same logic backs the CLI, the MCP server, and tests.
- `cli/agent_workflow.js` — a thin CLI wrapper: parse args → call `core.js` → format
  output → map `WorkflowError` to stderr + exit code.
- `cli/templates.js` — the `.ai/` scaffolding written by `init`.
- `cli/mcp_server.js` — MCP tools over the engine.
- `schema/project-state.schema.json` — JSON Schema for `PROJECT_STATE.json` (editor support).

**Concurrency.** `PROJECT_STATE.json` is written atomically (temp file + rename), and every
mutating command runs its read-modify-write under `withStateLock` (`.ai/state.lock`, an
exclusive-create lock that is re-entrant in-process, waits up to 10s, and reclaims a lock
older than 30s). Parallel agents can therefore start and complete tasks at the same time
without losing updates. `completeTask` takes the lock only for the write phase, never while
a task's `Verify:` command runs. New mutators should be exported through `locked(...)`.

**Verification evidence.** `completeTask` runs the task's `Verify:` (which must also match its
optional `Verify-Expect:` regex) and the optional project-wide `project_verify` command from
`PROJECT_STATE.json` (`verify-config`); either failing blocks completion. On success an indented
`Evidence:` section (commands, output tail, exit codes, timestamp, git commit) is written to the
task file. `startTask` runs Verify once after claiming (outside the lock) and returns a `warning`
if it already passes. Verify runs are bounded by `AFW_VERIFY_TIMEOUT_MS` (default 10 min).

State transitions are **owned by the CLI**: agents never hand-edit `PROJECT_STATE.json`
or a task's `Status:` line. Keep that invariant — new behavior belongs behind a command
and the state machine, not in freehand file edits.

## Adding a new command

1. Implement the logic as a pure function in `cli/core.js` (throw `WorkflowError` on
   failure) and export it.
2. Add a thin `cmdYourCommand(...)` and a `main()` branch in `cli/agent_workflow.js`.
3. Update the `USAGE` string.
4. If it should be agent-callable, add a matching tool in `cli/mcp_server.js`.
5. Add tests in `cli/core.test.js` (logic) and `cli/agent_workflow.test.js` (CLI).
