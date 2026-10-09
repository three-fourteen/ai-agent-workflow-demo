'use strict';

/**
 * Integration tests for cli/mcp_server.js — spawn the server over stdio with the
 * official MCP client and confirm tools drive the same state as the CLI.
 * Run: node --test cli/mcp_server.test.js
 */

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { join }   = require('node:path');
const { tmpdir } = require('node:os');

const core = require('./core');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const SERVER = join(__dirname, 'mcp_server.js');

/** Parse the JSON text payload out of a tool result. */
function payload(res) {
  return JSON.parse(res.content[0].text);
}

/** Spin up a temp project + connected MCP client; tear both down after fn. */
async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'afw-mcp-'));
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTask(proj, 'Setup');
  core.addTask(proj, 'Feature', { after: 'T-001' });

  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, proj] });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  try {
    await fn({ client, proj });
  } finally {
    await client.close();
    rmSync(dir, { recursive: true });
  }
}

test('tools/list advertises the workflow tools', async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    for (const n of ['get_state', 'list_tasks', 'next_tasks', 'start_task', 'complete_task', 'validate']) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
  });
});

test('next_tasks returns only the runnable task', async () => {
  await withServer(async ({ client }) => {
    const res = await client.callTool({ name: 'next_tasks', arguments: {} });
    const runnable = payload(res).map(t => t.id);
    assert.deepEqual(runnable, ['T-001']); // T-002 waits on T-001
  });
});

test('start_task + complete_task mutate state like the CLI', async () => {
  await withServer(async ({ client, proj }) => {
    await client.callTool({ name: 'start_task', arguments: { id: 'T-001' } });
    const done = await client.callTool({ name: 'complete_task', arguments: { id: 'T-001', no_verify: true } });
    assert.equal(payload(done).status, 'completed');

    const state = JSON.parse(readFileSync(join(proj, '.ai', 'PROJECT_STATE.json'), 'utf8'));
    assert.deepEqual(state.completed_tasks, ['T-001']);
    assert.equal(state.current_task, 'T-002');
  });
});

test('an illegal transition surfaces as an MCP tool error', async () => {
  await withServer(async ({ client }) => {
    // completing a pending (not started) task is illegal
    const res = await client.callTool({ name: 'complete_task', arguments: { id: 'T-001', no_verify: true } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /illegal transition/);
  });
});

test('validate reports ok for a fresh project', async () => {
  await withServer(async ({ client }) => {
    const res = await client.callTool({ name: 'validate', arguments: {} });
    assert.deepEqual(payload(res), { ok: true, errors: [] });
  });
});

test('complete_task ignores force over MCP', async () => {
  await withServer(async ({ client, proj }) => {
    await client.callTool({ name: 'start_task', arguments: { id: 'T-001' } });
    const res = await client.callTool({ name: 'complete_task', arguments: { id: 'T-001', force: true } });
    assert.equal(res.isError, true); // task has no Verify command; force is not honored
    assert.equal(core.findTask(proj, 'T-001').status, 'in-progress');
  });
});

test('project outside the served directory is rejected', async () => {
  await withServer(async ({ client }) => {
    const res = await client.callTool({ name: 'get_state', arguments: { project: '../..' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /outside the served directory/);
  });
});

test('release_task clears a stale claim', async () => {
  await withServer(async ({ client, proj }) => {
    await client.callTool({ name: 'start_task', arguments: { id: 'T-001' } });
    assert.deepEqual(core.listLocks(proj), ['T-001']);
    const res = await client.callTool({ name: 'release_task', arguments: { id: 'T-001' } });
    assert.notEqual(res.isError, true);
    assert.deepEqual(core.listLocks(proj), []);
  });
});

const PLAN = [
  { key: 'setup', title: 'Setup', verify: 'true' },
  { key: 'feature', title: 'Feature', depends_on: ['setup'], verify: 'true' },
];

test('init → set_brief → plan_project → add_tasks, in place, then drive the loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afw-mcp-init-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, dir] });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const init = payload(await client.callTool({ name: 'init_project', arguments: { name: '.' } }));
    assert.equal(init.path, dir);

    await client.callTool({ name: 'set_brief', arguments: { content: '# Brief', source: 'asana:1' } });
    assert.match(readFileSync(join(dir, 'docs', 'brief.md'), 'utf8'), /Source: asana:1/);

    const plan = payload(await client.callTool({ name: 'plan_project', arguments: { tasks: PLAN } }));
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.waves, [['T-001'], ['T-002']]);
    assert.equal(core.listTasks(dir).length, 0); // dry run wrote nothing

    const added = payload(await client.callTool({ name: 'add_tasks', arguments: { tasks: PLAN } }));
    assert.deepEqual(added.created.map(c => c.id), ['T-001', 'T-002']);
    assert.equal(added.created[0].verify, 'true'); // echoed for approval

    const next = payload(await client.callTool({ name: 'next_tasks', arguments: {} }));
    assert.deepEqual(next.map(t => t.id), ['T-001']);
    assert.equal(payload(await client.callTool({ name: 'validate', arguments: {} })).ok, true);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true });
  }
});

test('plan_project reports errors without throwing; add_tasks refuses an invalid plan', async () => {
  await withServer(async ({ client, proj }) => {
    const bad = [{ key: 'a', title: 'A', depends_on: ['ghost'] }];
    const plan = payload(await client.callTool({ name: 'plan_project', arguments: { tasks: bad } }));
    assert.equal(plan.ok, false);
    const res = await client.callTool({ name: 'add_tasks', arguments: { tasks: bad } });
    assert.equal(res.isError, true);
    assert.equal(core.listTasks(proj).length, 2); // fixture tasks only
  });
});

test('init_project creates a subdirectory but refuses to escape the served dir', async () => {
  await withServer(async ({ client, proj }) => {
    const parent = join(proj, '..');
    const ok = await client.callTool({ name: 'init_project', arguments: { name: 'child' } });
    assert.notEqual(ok.isError, true);
    assert.ok(core.isProjectDir(join(proj, 'child')));

    for (const name of ['../escape', '/tmp/afw-escape']) {
      const res = await client.callTool({ name: 'init_project', arguments: { name } });
      assert.equal(res.isError, true, name);
    }
    assert.equal(core.isProjectDir(join(parent, 'escape')), false);
  });
});

test('update_task and remove_task re-plan over MCP, and refuse started tasks', async () => {
  await withServer(async ({ client, proj }) => {
    const upd = await client.callTool({ name: 'update_task', arguments: { id: 'T-002', verify: 'true', goal: 'Sharper goal' } });
    assert.notEqual(upd.isError, true);
    assert.equal(core.findTask(proj, 'T-002').goal, 'Sharper goal');

    await client.callTool({ name: 'start_task', arguments: { id: 'T-001' } });
    const blocked = await client.callTool({ name: 'update_task', arguments: { id: 'T-001', goal: 'x' } });
    assert.equal(blocked.isError, true);

    const dep = await client.callTool({ name: 'remove_task', arguments: { id: 'T-001' } });
    assert.equal(dep.isError, true);

    const rm = await client.callTool({ name: 'remove_task', arguments: { id: 'T-002' } });
    assert.equal(payload(rm).removed, true);
    assert.equal(core.listTasks(proj).length, 1);
  });
});

test('removed task ids stay retired over MCP', async () => {
  await withServer(async ({ client, proj }) => {
    await client.callTool({ name: 'remove_task', arguments: { id: 'T-002' } });
    const added = payload(await client.callTool({
      name: 'add_tasks', arguments: { tasks: [{ key: 'again', title: 'Again', verify: 'true' }] },
    }));
    assert.equal(added.created[0].id, 'T-003'); // T-002 stays retired
    assert.equal(core.readState(proj).max_task_id, 3);
  });
});

test('start_task on a completed task says so', async () => {
  await withServer(async ({ client }) => {
    await client.callTool({ name: 'start_task', arguments: { id: 'T-001' } });
    await client.callTool({ name: 'complete_task', arguments: { id: 'T-001', no_verify: true } });
    const res = await client.callTool({ name: 'start_task', arguments: { id: 'T-001' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /already completed/);
  });
});

test('create_worktree + workdir: verify runs against the task branch', async () => {
  const { spawnSync } = require('node:child_process');
  const { mkdirSync, writeFileSync } = require('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'afw-mcp-wt-'));
  const repo = join(dir, 'repo');
  const proj = join(repo, 'app');
  mkdirSync(repo, { recursive: true });
  const git = (...a) => assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo }).status, 0);
  git('init', '-q', '-b', 'main');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'Feature A', verify: 'test -f marker.txt' }]);
  git('add', '-A'); git('commit', '-q', '-m', 'init');

  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, proj] }));
  try {
    await client.callTool({ name: 'start_task', arguments: { id: 'T-001', agent: 'codex' } });
    const wt = payload(await client.callTool({ name: 'create_worktree', arguments: { id: 'T-001' } }));
    assert.equal(wt.branch, 'task/T-001-feature-a');
    writeFileSync(join(wt.path, 'app', 'marker.txt'), 'x');

    const wrong = payload(await client.callTool({ name: 'verify_task', arguments: { id: 'T-001' } }));
    assert.equal(wrong.ok, false);
    const bad = await client.callTool({ name: 'complete_task', arguments: { id: 'T-001', workdir: dir } });
    assert.equal(bad.isError, true);
    const done = payload(await client.callTool({ name: 'complete_task', arguments: { id: 'T-001', workdir: wt.path } }));
    assert.equal(done.verified, true);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// T-003: reset_task and in-progress update_task
// ---------------------------------------------------------------------------

test('update_task edits in-progress tasks for the claimant; reset_task returns them to pending', async () => {
  await withServer(async ({ client, proj }) => {
    await client.callTool({ name: 'start_task', arguments: { id: 'T-001', agent: 'alice' } });
    const other = await client.callTool({ name: 'update_task', arguments: { id: 'T-001', verify: 'true', agent: 'bob' } });
    assert.equal(other.isError, true);
    assert.match(other.content[0].text, /claimed by 'alice'/);
    const ok = await client.callTool({ name: 'update_task', arguments: { id: 'T-001', verify: 'true', agent: 'alice' } });
    assert.notEqual(ok.isError, true);
    assert.equal(core.findTask(proj, 'T-001').verify, 'true');

    const reset = await client.callTool({ name: 'reset_task', arguments: { id: 'T-001' } });
    assert.equal(payload(reset).status, 'pending');
    assert.equal(core.findTask(proj, 'T-001').status, 'pending');
    assert.deepEqual(core.readState(proj).in_progress, []);
  });
});

// ---------------------------------------------------------------------------
// T-004: deferred status
// ---------------------------------------------------------------------------

test('defer_task and reopen_task drive the deferred status', async () => {
  await withServer(async ({ client, proj }) => {
    const { tools } = await client.listTools();
    assert.ok(tools.some(t => t.name === 'defer_task') && tools.some(t => t.name === 'reopen_task'));
    const d = payload(await client.callTool({ name: 'defer_task', arguments: { id: 'T-002', reason: 'backlog' } }));
    assert.equal(d.status, 'deferred');
    assert.equal(core.findTask(proj, 'T-002').status, 'deferred');
    const bad = await client.callTool({ name: 'defer_task', arguments: { id: 'T-002' } });
    assert.equal(bad.isError, true);
    const o = payload(await client.callTool({ name: 'reopen_task', arguments: { id: 'T-002' } }));
    assert.equal(o.status, 'pending');
  });
});

// ---------------------------------------------------------------------------
// T-005: project-wide verify, verify_expect, evidence, red-first (MCP)
// ---------------------------------------------------------------------------

test('MCP schemas expose verify_expect, red_first and set_project_verify', async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map(t => [t.name, t]));
    assert.ok(by.add_tasks.inputSchema.properties.tasks.items.properties.verify_expect);
    assert.ok(by.plan_project.inputSchema.properties.tasks.items.properties.verify_expect);
    assert.ok(by.update_task.inputSchema.properties.verify_expect);
    assert.ok(by.start_task.inputSchema.properties.red_first);
    assert.ok(by.set_project_verify.inputSchema.properties.command);
  });
});

test('set_project_verify blocks complete_task; evidence and red-first warning via MCP', async () => {
  await withServer(async ({ client, proj }) => {
    const set = payload(await client.callTool({ name: 'set_project_verify', arguments: { command: 'exit 4' } }));
    assert.equal(set.projectVerify, 'exit 4');
    await client.callTool({ name: 'update_task', arguments: { id: 'T-001', verify: 'echo "# pass 3"', verify_expect: '# pass [1-9]' } });

    const started = payload(await client.callTool({ name: 'start_task', arguments: { id: 'T-001' } }));
    assert.match(started.warning, /already passes/);

    const blocked = await client.callTool({ name: 'complete_task', arguments: { id: 'T-001' } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /project verification failed/);

    assert.equal(payload(await client.callTool({ name: 'set_project_verify', arguments: { command: '' } })).projectVerify, '');
    const done = payload(await client.callTool({ name: 'complete_task', arguments: { id: 'T-001' } }));
    assert.equal(done.verified, true);
    const file = core.findTask(proj, 'T-001').file;
    const raw = readFileSync(join(proj, 'tasks', file), 'utf8');
    assert.match(raw, /^Evidence:$/m);
    assert.match(raw, /task verify: `echo "# pass 3"` exit 0, matched/);
  });
});
