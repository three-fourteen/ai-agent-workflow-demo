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
