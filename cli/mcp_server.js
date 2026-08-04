'use strict';

/**
 * mcp_server.js — Model Context Protocol server over the workflow engine.
 *
 * Exposes the same operations as the CLI as MCP tools, so an agent can drive the
 * git-native workflow through a typed interface. Git remains the source of
 * truth: every tool mutates the same PROJECT_STATE.json / task files that the
 * CLI does, through cli/core.js.
 *
 * Started by `agent-workflow mcp [<project>]`.
 */

const core = require('./core');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const PROJECT_PROP = {
  project: {
    type: 'string',
    description: 'Project directory (relative to where the server was launched). Defaults to the launch directory.',
  },
};
const ID_PROP = {
  id: { type: 'string', description: 'Task id, e.g. "T-001".', pattern: '^T-\\d+$' },
};

/** Build the tool table. `base` is the default project directory. */
function buildTools(base) {
  const proj = args => (args && args.project) || base;

  return [
    {
      name: 'get_state',
      description: 'Read PROJECT_STATE.json for a project.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP } },
      run: a => core.readState(proj(a)),
    },
    {
      name: 'list_tasks',
      description: 'List all tasks with their status and dependencies.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP } },
      run: a => core.listTasks(proj(a)).map(t => ({
        id: t.id, status: t.status, goal: t.goal, dependencies: t.dependencies, verify: t.verify,
      })),
    },
    {
      name: 'get_task',
      description: 'Read one task by id.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP, ...ID_PROP }, required: ['id'] },
      run: a => {
        const t = core.findTask(proj(a), a.id);
        return { id: t.id, status: t.status, goal: t.goal, dependencies: t.dependencies, verify: t.verify, raw: t.raw };
      },
    },
    {
      name: 'next_tasks',
      description: 'Return runnable tasks (pending, dependencies satisfied, unclaimed). Set all=false for just the first.',
      inputSchema: {
        type: 'object',
        properties: { ...PROJECT_PROP, all: { type: 'boolean', description: 'Return every runnable task (default true).' } },
      },
      run: a => {
        const runnable = core.runnableTasks(proj(a)).map(t => ({ id: t.id, goal: t.goal, dependencies: t.dependencies }));
        return a && a.all === false ? runnable.slice(0, 1) : runnable;
      },
    },
    {
      name: 'start_task',
      description: 'Claim a task and move it pending → in-progress.',
      inputSchema: {
        type: 'object',
        properties: { ...PROJECT_PROP, ...ID_PROP, agent: { type: 'string', description: 'Agent name recorded on the lock.' } },
        required: ['id'],
      },
      run: a => core.startTask(proj(a), a.id, { agent: a.agent || 'mcp' }),
    },
    {
      name: 'verify_task',
      description: 'Run a task\'s Verify command without changing its status.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP, ...ID_PROP }, required: ['id'] },
      run: a => core.verifyTask(proj(a), a.id),
    },
    {
      name: 'complete_task',
      description: 'Move a task in-progress → completed. Runs its Verify command first and refuses on failure unless force/no_verify is set.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT_PROP, ...ID_PROP,
          force: { type: 'boolean', description: 'Skip verification.' },
          no_verify: { type: 'boolean', description: 'Complete a task that has no Verify command.' },
        },
        required: ['id'],
      },
      run: a => core.completeTask(proj(a), a.id, { force: !!a.force, noVerify: !!a.no_verify }),
    },
    {
      name: 'block_task',
      description: 'Mark a task blocked with a reason and unblock strategy.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT_PROP, ...ID_PROP,
          reason: { type: 'string' },
          strategy: { type: 'string' },
        },
        required: ['id'],
      },
      run: a => core.blockTask(proj(a), a.id, { reason: a.reason || '', strategy: a.strategy || '' }),
    },
    {
      name: 'unblock_task',
      description: 'Return a blocked task to pending.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP, ...ID_PROP }, required: ['id'] },
      run: a => core.unblockTask(proj(a), a.id),
    },
    {
      name: 'validate',
      description: 'Validate the state file and task graph. Returns { ok, errors }.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP } },
      run: a => core.validateProject(proj(a)),
    },
  ];
}

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errorResult(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Create and connect the MCP server. Returns the connected Server. */
async function runServer(base = '.') {
  const tools = buildTools(base);
  const byName = new Map(tools.map(t => [t.name, t]));

  const server = new Server(
    { name: 'agent-workflow', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = byName.get(name);
    if (!tool) return errorResult(`unknown tool '${name}'`);
    try {
      return textResult(await tool.run(args || {}));
    } catch (err) {
      if (err instanceof core.WorkflowError) return errorResult(err.message);
      throw err;
    }
  });

  await server.connect(new StdioServerTransport());
  return server;
}

module.exports = { runServer, buildTools };

if (require.main === module) {
  runServer(process.argv[2] || '.').catch(err => {
    process.stderr.write(`mcp server failed: ${err.stack || err}\n`);
    process.exit(1);
  });
}
