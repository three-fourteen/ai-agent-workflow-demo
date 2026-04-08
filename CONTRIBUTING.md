# Contributing

Contributions are welcome. If you improve the workflow or test with other agents, please open a PR.

## Development setup

Requires Node.js 18+. No dependencies to install.

```bash
git clone https://github.com/three-fourteen/ai-agent-workflow-demo
cd ai-agent-workflow-demo
```

## Running tests

```bash
npm test
```

17 tests covering all four CLI commands (`init`, `task add`, `status`, `start`),
error paths, and slug generation. Tests use Node's built-in `node:test` runner —
no extra packages needed.

## CLI entry point

`cli/agent_workflow.js` is the sole source of truth for the CLI.
It has no dependencies and uses only Node.js built-ins (`fs`, `path`, `process`).

## Adding a new command

1. Implement `cmdYourCommand(...)` in `cli/agent_workflow.js`
2. Add a branch in the `main()` switch
3. Update the `USAGE` string
4. Add tests in `cli/agent_workflow.test.js`
