'use strict';

/**
 * Tests for agent_workflow.js — uses Node's built-in test runner (Node 18+).
 * Run: node --test cli/agent_workflow.test.js
 */

const { test }        = require('node:test');
const assert          = require('node:assert/strict');
const { spawnSync }   = require('node:child_process');
const { mkdtempSync, rmSync, existsSync, readFileSync } = require('node:fs');
const { join }        = require('node:path');
const { tmpdir }      = require('node:os');

const CLI = join(__dirname, 'agent_workflow.js');

/** Invoke the CLI with the given args in the given cwd. */
function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

/** Create a temp dir, run fn(dir), then clean up regardless of outcome. */
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'afw-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// CLI meta
// ---------------------------------------------------------------------------

test('--help exits 0 and shows usage', () => {
  const r = run(['--help'], process.cwd());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /agent-workflow init/);
  assert.match(r.stdout, /task add/);
  assert.match(r.stdout, /status/);
  assert.match(r.stdout, /start/);
});

test('no args exits 1', () => {
  const r = run([], process.cwd());
  assert.equal(r.status, 1);
});

test('unknown command exits 1 with error message', () => {
  const r = run(['frobnicate'], process.cwd());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command/);
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

test('init creates full project structure', () => withTmp(dir => {
  const r = run(['init', 'my-proj', '-d', 'Test project'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Initialized project 'my-proj'/);

  const aiDir = join(dir, 'my-proj', '.ai');
  assert.ok(existsSync(join(aiDir, 'AGENT_START_HERE.md')));
  assert.ok(existsSync(join(aiDir, 'WORKING_RULES.md')));
  assert.ok(existsSync(join(aiDir, 'TASK_TEMPLATE.md')));
  assert.ok(existsSync(join(aiDir, 'TASK_INDEX.json')));
  assert.ok(existsSync(join(aiDir, 'PROJECT_STATE.json')));
  assert.ok(existsSync(join(dir, 'my-proj', 'tasks')));

  const state = JSON.parse(readFileSync(join(aiDir, 'PROJECT_STATE.json'), 'utf8'));
  assert.equal(state.project, 'my-proj');
  assert.equal(state.description, 'Test project');
  assert.equal(state.phase, 'prototype');
  assert.equal(state.current_task, null);
  assert.equal(state.blocked, false);
  assert.deepEqual(state.completed_tasks, []);
}));

test('init without --description omits description key', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  const state = JSON.parse(
    readFileSync(join(dir, 'proj', '.ai', 'PROJECT_STATE.json'), 'utf8')
  );
  assert.equal('description' in state, false);
}));

test('init fails if project directory already exists', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  const r = run(['init', 'proj'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists/);
}));

test('init fails with missing project argument', () => {
  const r = run(['init'], process.cwd());
  assert.equal(r.status, 1);
});

// ---------------------------------------------------------------------------
// task add
// ---------------------------------------------------------------------------

test('task add creates T-001 and sets current_task', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  const r = run(['task', 'add', 'proj', 'Setup project'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /T-001-setup-project\.md/);
  assert.match(r.stdout, /set as current_task/);

  assert.ok(existsSync(join(dir, 'proj', 'tasks', 'T-001-setup-project.md')));

  const state = JSON.parse(
    readFileSync(join(dir, 'proj', '.ai', 'PROJECT_STATE.json'), 'utf8')
  );
  assert.equal(state.current_task, 'T-001');
}));

test('task add second task does not overwrite current_task', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'First task'], dir);
  const r = run(['task', 'add', 'proj', 'Second task', '--after', 'T-001'], dir);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /set as current_task/);

  const content = readFileSync(
    join(dir, 'proj', 'tasks', 'T-002-second-task.md'), 'utf8'
  );
  assert.match(content, /Dependencies: T-001/);

  const state = JSON.parse(
    readFileSync(join(dir, 'proj', '.ai', 'PROJECT_STATE.json'), 'utf8')
  );
  assert.equal(state.current_task, 'T-001');
}));

test('task add slugifies title (punctuation, mixed case)', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Build Dashboard UI!'], dir);
  assert.ok(existsSync(join(dir, 'proj', 'tasks', 'T-001-build-dashboard-ui.md')));
}));

test('task add with --description uses it as goal', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Setup', '-d', 'Custom goal text'], dir);
  const content = readFileSync(
    join(dir, 'proj', 'tasks', 'T-001-setup.md'), 'utf8'
  );
  assert.match(content, /Goal: Custom goal text/);
}));

test('task add fails for unknown project', () => withTmp(dir => {
  const r = run(['task', 'add', 'no-such', 'A task'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found/);
}));

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test('status prints table for all projects', () => withTmp(dir => {
  run(['init', 'alpha'], dir);
  run(['init', 'beta'],  dir);
  run(['task', 'add', 'alpha', 'First task'], dir);

  const r = run(['status'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /alpha/);
  assert.match(r.stdout, /beta/);
  assert.match(r.stdout, /T-001/);
}));

test('status with project name filters output', () => withTmp(dir => {
  run(['init', 'alpha'], dir);
  run(['init', 'beta'],  dir);

  const r = run(['status', 'alpha'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /alpha/);
  assert.doesNotMatch(r.stdout, /beta/);
}));

test('status with no projects prints helpful message', () => withTmp(dir => {
  const r = run(['status'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No projects found/);
}));

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

test('start prints agent prompt with current state', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Setup'], dir);
  run(['task', 'add', 'proj', 'Build'], dir);

  const r = run(['start', 'proj'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /AGENT_START_HERE\.md/);
  assert.match(r.stdout, /phase=prototype/);
  assert.match(r.stdout, /current_task=T-001/);
  assert.match(r.stdout, /blocked=false/);
  assert.match(r.stdout, /Completed: 0\/2/);
}));

test('start fails for unknown project', () => withTmp(dir => {
  const r = run(['start', 'no-such'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found/);
}));
