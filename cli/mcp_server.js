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

const path = require('path');
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
const TASK_SPEC = {
  type: 'object',
  required: ['key', 'title'],
  properties: {
    key:           { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', description: 'Plan-local handle, referenced by depends_on.' },
    title:         { type: 'string', maxLength: 80 },
    goal:          { type: 'string', description: 'One line. Defaults to the title.' },
    context:       { type: 'string' },
    depends_on:    { type: 'array', items: { type: 'string' }, description: 'Plan keys, or existing task ids (e.g. "T-003") when appending.' },
    subtasks:      { type: 'array', items: { type: 'string' } },
    done_criteria: { type: 'string' },
    verify:        { type: 'string', description: 'Shell command run from the project dir; exit 0 means done.' },
    verify_expect: { type: 'string', description: 'Single-line regex the verify output must also match, e.g. "# pass [1-9]", so a check that runs zero tests fails.' },
    source:        { type: 'string', description: 'Opaque origin reference, e.g. "asana:1204" or "brief.md#auth".' },
  },
};
const WORKDIR_PROP = {
  workdir: {
    type: 'string',
    description: 'Path of a git worktree created with create_worktree. Runs the Verify command there instead of in the main checkout.',
  },
};
const ID_PROP = {
  id: { type: 'string', description: 'Task id, e.g. "T-001".', pattern: '^T-\\d+$' },
};
const DECISIONS_PROP = {
  type: 'array',
  items: { type: 'string', maxLength: 500 },
  maxItems: 20,
  description: 'Choices made on this task, one short single-line sentence each (e.g. "bookmarks file lives at ~/.bookmarks.json"). Stored on the task and shown to the next agent.',
};

/** Build the tool table. `base` is the default project directory. */
function buildTools(base) {
  // Resolve a path and refuse anything outside the launch directory, so an
  // agent can't point the engine (and its Verify shell commands) at other paths.
  const root = path.resolve(base);
  const confine = (p, label) => {
    const target = path.resolve(root, p);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new core.WorkflowError(`${label} '${p}' is outside the served directory.`);
    }
    return target;
  };
  const proj = args => (args && args.project ? confine(args.project, 'project') : base);

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
      description: 'Claim a task and move it pending → in-progress. Then runs its Verify once; if that ALREADY passes, the result carries a `warning` (possibly vacuous check). Never blocks.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT_PROP, ...ID_PROP, ...WORKDIR_PROP,
          agent: { type: 'string', description: 'Agent name recorded on the lock.' },
          red_first: { type: 'boolean', description: 'Run Verify once after starting and warn if it already passes (default true).' },
        },
        required: ['id'],
      },
      run: a => core.startTask(proj(a), a.id, { agent: a.agent || 'mcp', redFirst: a.red_first !== false, workdir: a.workdir || '' }),
    },
    {
      name: 'start_tasks',
      description: 'Start several tasks in one call (same as start_task for each id, in order). Stops at the first failure and reports it; later ids are returned in `skipped`. Use for a whole parallel wave.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT_PROP,
          ids: { type: 'array', items: { type: 'string', pattern: '^T-\\d+$' }, minItems: 1, maxItems: 25 },
          agent: { type: 'string', description: 'Agent name recorded on every lock.' },
          red_first: { type: 'boolean' },
        },
        required: ['ids'],
      },
      run: a => core.startTasks(proj(a), a.ids, { agent: a.agent || 'mcp', redFirst: a.red_first !== false }),
    },
    {
      name: 'complete_tasks',
      description: 'Complete several tasks in one call (same as complete_task for each id, in order; every task is fully verified and records evidence). Stops at the first failure; later ids are returned in `skipped`. For per-task decisions use complete_task or record_decision.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT_PROP, ...WORKDIR_PROP,
          ids: { type: 'array', items: { type: 'string', pattern: '^T-\\d+$' }, minItems: 1, maxItems: 25 },
          no_verify: { type: 'boolean', description: 'Complete tasks that have no Verify command (project verify still runs).' },
        },
        required: ['ids'],
      },
      run: a => core.completeTasks(proj(a), a.ids, { noVerify: !!a.no_verify, workdir: a.workdir || '' }),
    },
    {
      name: 'verify_task',
      description: 'Run a task\'s Verify command without changing its status.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP, ...ID_PROP, ...WORKDIR_PROP }, required: ['id'] },
      run: a => core.verifyTask(proj(a), a.id, { workdir: a.workdir || '' }),
    },
    {
      name: 'complete_task',
      description: 'Move a task in-progress → completed. Runs its Verify command (and the project-wide project_verify command, if set) first and refuses if either fails or the output misses verify_expect. Records an Evidence section (commands, output tail, exit code, time, git commit) in the task file. no_verify skips only the task check, never the project check. (Skipping verification with --force is CLI-only.)',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT_PROP, ...ID_PROP, ...WORKDIR_PROP,
          no_verify: { type: 'boolean', description: 'Complete a task that has no Verify command.' },
          decisions: DECISIONS_PROP,
        },
        required: ['id'],
      },
      run: a => core.completeTask(proj(a), a.id, { noVerify: !!a.no_verify, workdir: a.workdir || '', decisions: a.decisions || [] }),
    },
    {
      name: 'record_decision',
      description: 'Record choices made while working a task (where a file lives, an output format, a trade-off) so they live in the workflow state and the next agent sees them. Works on a task in any status; duplicates are skipped.',
      inputSchema: {
        type: 'object',
        properties: { ...PROJECT_PROP, ...ID_PROP, decisions: DECISIONS_PROP },
        required: ['id', 'decisions'],
      },
      run: a => core.recordDecisions(proj(a), a.id, a.decisions),
    },
    {
      name: 'list_decisions',
      description: 'Every decision recorded on any task, in task order: [{ task, title, text }].',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP } },
      run: a => core.listDecisions(proj(a)),
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
      name: 'defer_task',
      description: 'Move a pending or blocked task to deferred (backlog): kept on record, never runnable, does not block finalize.',
      inputSchema: {
        type: 'object',
        properties: { ...PROJECT_PROP, ...ID_PROP, reason: { type: 'string', description: 'Why it is deferred. Single line.' } },
        required: ['id'],
      },
      run: a => core.deferTask(proj(a), a.id, { reason: a.reason || '' }),
    },
    {
      name: 'reopen_task',
      description: 'Return a deferred task to pending.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP, ...ID_PROP }, required: ['id'] },
      run: a => core.reopenTask(proj(a), a.id),
    },
    {
      name: 'release_task',
      description: 'Release a task\'s lock (e.g. a stale claim from a crashed agent) without changing its status.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP, ...ID_PROP }, required: ['id'] },
      run: a => core.releaseTask(proj(a), a.id),
    },
    {
      name: 'reset_task',
      description: 'Move an in-progress task back to pending: releases its claim, removes it from in_progress, keeps its content. Then it can be re-planned or restarted. Pass agent to refuse when someone else holds the claim.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP, ...ID_PROP, agent: { type: 'string' } }, required: ['id'] },
      run: a => core.resetTask(proj(a), a.id, { agent: a.agent || '' }),
    },
    {
      name: 'set_project_verify',
      description: 'Set (or clear, with an empty string) the project-wide verify command stored in PROJECT_STATE.json. It runs on every task completion in addition to the task\'s own Verify, and a failure blocks completion. Omit command to just read it.',
      inputSchema: {
        type: 'object',
        properties: { ...PROJECT_PROP, command: { type: 'string', description: 'Single-line shell command; empty string clears it.' } },
      },
      run: a => {
        if (typeof a.command === 'string') core.setProjectVerify(proj(a), a.command);
        return { projectVerify: core.readState(proj(a)).project_verify || '' };
      },
    },
    {
      name: 'create_worktree',
      description: 'Isolate a task for parallel work: creates a git worktree on branch task/<id>-<slug>, placed beside the repository. Edit and commit code there; keep making state changes (start/complete/block) through these tools, and pass the returned path as workdir to verify_task / complete_task so Verify runs against the branch.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP, ...ID_PROP }, required: ['id'] },
      run: a => core.createWorktree(proj(a), a.id),
    },
    {
      name: 'init_project',
      description: 'Scaffold a new project. name is a new directory inside the served directory, or "." to initialise the served directory itself.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'New directory name, or "." for in-place.' } },
        required: ['name'],
      },
      run: a => {
        const inPlace = a.name === '.';
        const target = inPlace ? base : confine(a.name, 'name');
        const r = core.initProject(target, '', { inPlace, name: inPlace ? '' : a.name });
        return { projectName: r.projectName, path: target };
      },
    },
    {
      name: 'set_brief',
      description: 'Store the source brief (as text) in docs/brief.md. Pass the content itself, never a path or URL.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT_PROP,
          content: { type: 'string', description: 'The brief as markdown.' },
          source: { type: 'string', description: 'Where it came from, e.g. "asana:1204". Single line.' },
          mode: { type: 'string', enum: ['replace', 'append'], description: 'Default replace.' },
        },
        required: ['content'],
      },
      run: a => core.setBrief(proj(a), a.content, { source: a.source || '', mode: a.mode || 'replace' }),
    },
    {
      name: 'plan_project',
      description: 'Dry-run a task plan: validates it and returns resolved ids and parallel waves. Writes nothing. Works before init_project.',
      inputSchema: {
        type: 'object',
        properties: { ...PROJECT_PROP, tasks: { type: 'array', minItems: 1, items: TASK_SPEC } },
        required: ['tasks'],
      },
      run: a => core.resolvePlan(proj(a), a.tasks),
    },
    {
      name: 'add_tasks',
      description: 'Write a validated task plan atomically (all tasks or none). Call plan_project first and get the user\'s approval; verify commands are echoed back.',
      inputSchema: {
        type: 'object',
        properties: { ...PROJECT_PROP, tasks: { type: 'array', minItems: 1, items: TASK_SPEC } },
        required: ['tasks'],
      },
      run: a => core.addTasks(proj(a), a.tasks),
    },
    {
      name: 'update_task',
      description: 'Re-plan: edit a pending, unclaimed task in place (or, with agent = the claimant, an in-progress task goal/context/subtasks/done_criteria/verify/source) (title, goal, context, depends_on as task ids, subtasks, done_criteria, verify, source). Only the given fields change.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROJECT_PROP, ...ID_PROP,
          title:         TASK_SPEC.properties.title,
          goal:          TASK_SPEC.properties.goal,
          context:       TASK_SPEC.properties.context,
          depends_on:    { type: 'array', items: { type: 'string', pattern: '^T-\\d+$' }, description: 'Replaces the dependency list with these task ids.' },
          subtasks:      TASK_SPEC.properties.subtasks,
          done_criteria: TASK_SPEC.properties.done_criteria,
          verify:        TASK_SPEC.properties.verify,
          verify_expect: TASK_SPEC.properties.verify_expect,
          source:        TASK_SPEC.properties.source,
          agent:         { type: 'string', description: 'Required to edit an in-progress task (goal, context, subtasks, done_criteria, verify, source): must be the claimant.' },
        },
        required: ['id'],
      },
      run: a => {
        const { project, id, agent, ...patch } = a;
        return core.updateTask(proj(a), id, patch, { agent: agent || '' });
      },
    },
    {
      name: 'remove_task',
      description: 'Re-plan: delete a pending, unclaimed task that nothing depends on. Its id is retired: ids are never reused or renumbered.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP, ...ID_PROP }, required: ['id'] },
      run: a => core.removeTask(proj(a), a.id),
    },
    {
      name: 'migrate_project',
      description: 'Convert legacy (format v1) task files to format v2: YAML frontmatter, ## sections, files named by id alone. Verified field-by-field before anything is written. Use dry_run to preview.',
      inputSchema: { type: 'object', properties: { ...PROJECT_PROP, dry_run: { type: 'boolean' } } },
      run: a => core.migrateProject(proj(a), { dryRun: !!a.dry_run }),
    },
    {
      name: 'validate',
      description: 'Validate the state file and task graph. Returns { ok, errors, warnings } (warnings flag legacy-format task files).',
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

const SERVER_INSTRUCTIONS = [
  'Git-native task workflow: state lives in the repo; completion is gated on each task\'s Verify command.',
  'Tool loading: if your client defers tool schemas, load every workflow tool in ONE lookup (for example ToolSearch "select:plan_project,add_tasks,start_task,start_tasks,complete_task,complete_tasks,next_tasks,get_state,record_decision") instead of one per call.',
  'Flow: plan_project (dry run, show the user the waves) -> add_tasks -> start_tasks for a whole wave -> do the work -> complete_tasks. Pass a distinct `agent` name per parallel agent.',
  'Write down choices with record_decision (or `decisions` on complete_task). To change a started task, reset_task or update_task as its claimant; park backlog with defer_task.',
].join('\n');

/** Create and connect the MCP server. Returns the connected Server. */
async function runServer(base = '.') {
  const tools = buildTools(base);
  const byName = new Map(tools.map(t => [t.name, t]));

  const server = new Server(
    { name: 'agent-workflow', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
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
