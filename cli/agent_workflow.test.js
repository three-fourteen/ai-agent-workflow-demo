'use strict';

/**
 * Tests for agent_workflow.js — uses Node's built-in test runner (Node 18+).
 * Run: node --test cli/agent_workflow.test.js
 */

const { test }        = require('node:test');
const assert          = require('node:assert/strict');
const { spawnSync }   = require('node:child_process');
const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
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
  assert.match(r.stdout, /plan/);
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
  assert.ok(existsSync(join(aiDir, 'AGENT_PLAN_HERE.md')));
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

test('init without project arg initializes in current directory', () => withTmp(dir => {
  const r = run(['init'], dir);
  assert.equal(r.status, 0);
  assert.ok(existsSync(join(dir, '.ai', 'PROJECT_STATE.json')));
  assert.ok(existsSync(join(dir, 'tasks')));
  const state = JSON.parse(readFileSync(join(dir, '.ai', 'PROJECT_STATE.json'), 'utf8'));
  assert.equal(state.project, require('path').basename(dir));
}));

test('init shows npx hint when AFW_INVOKE_PREFIX is set', () => withTmp(dir => {
  const env = { ...process.env, AFW_INVOKE_PREFIX: 'npx github:three-fourteen/ai-agent-workflow-demo' };
  const r = spawnSync(process.execPath, [CLI, 'init', 'proj'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /npx github:three-fourteen\/ai-agent-workflow-demo task add/);
}));

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

test('task add without project arg works inside project dir', () => withTmp(dir => {
  run(['init'], dir);
  const r = run(['task', 'add', 'Setup project'], dir);
  assert.equal(r.status, 0);
  assert.ok(existsSync(join(dir, 'tasks', 'T-001-setup-project.md')));
}));

test('task add without project arg fails outside project dir', () => withTmp(dir => {
  const r = run(['task', 'add', 'A task'], dir);
  assert.equal(r.status, 1);
}));

// ---------------------------------------------------------------------------
// task transitions (start / complete / block / unblock)
// ---------------------------------------------------------------------------

test('task start then complete drives the state machine', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Setup'], dir);
  run(['task', 'add', 'proj', 'Build', '--after', 'T-001'], dir);

  const start = run(['task', 'start', 'proj', 'T-001'], dir);
  assert.equal(start.status, 0);
  assert.match(start.stdout, /T-001 → in-progress/);

  const done = run(['task', 'complete', 'proj', 'T-001', '--no-verify'], dir);
  assert.equal(done.status, 0);
  assert.match(done.stdout, /T-001 → completed/);
  assert.match(done.stdout, /Next task: T-002/);

  const state = JSON.parse(readFileSync(join(dir, 'proj', '.ai', 'PROJECT_STATE.json'), 'utf8'));
  assert.deepEqual(state.completed_tasks, ['T-001']);
  assert.equal(state.current_task, 'T-002');
}));

test('task complete from pending is rejected as illegal transition', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Setup'], dir);
  const r = run(['task', 'complete', 'proj', 'T-001'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /illegal transition/);
}));

test('task block records reason and sets project blocked', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Setup'], dir);
  const r = run(['task', 'block', 'proj', 'T-001', '--reason', 'need keys'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /T-001 → blocked/);
  const state = JSON.parse(readFileSync(join(dir, 'proj', '.ai', 'PROJECT_STATE.json'), 'utf8'));
  assert.equal(state.blocked, true);
  assert.equal(state.block_reason, 'need keys');
}));

test('task complete is gated on a failing Verify command', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Setup'], dir);
  // set a failing Verify command
  const f = join(dir, 'proj', 'tasks', 'T-001-setup.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^Verify:.*$/m, 'Verify: exit 1'));
  run(['task', 'start', 'proj', 'T-001'], dir);
  const r = run(['task', 'complete', 'proj', 'T-001'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /verification failed/);

  const forced = run(['task', 'complete', 'proj', 'T-001', '--force'], dir);
  assert.equal(forced.status, 0);
  assert.match(forced.stdout, /unverified/);
}));

test('unknown task subcommand exits 1', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  const r = run(['task', 'frob', 'proj', 'T-001'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown task subcommand/);
}));

// ---------------------------------------------------------------------------
// next / claim (scheduling)
// ---------------------------------------------------------------------------

test('next --all lists every runnable task after a dependency completes', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Setup'], dir);
  run(['task', 'add', 'proj', 'A', '--after', 'T-001'], dir);
  run(['task', 'add', 'proj', 'B', '--after', 'T-001'], dir);
  run(['task', 'start', 'proj', 'T-001'], dir);
  run(['task', 'complete', 'proj', 'T-001', '--no-verify'], dir);

  const r = run(['next', 'proj', '--all', '--json'], dir);
  assert.equal(r.status, 0);
  const ids = JSON.parse(r.stdout).map(t => t.id);
  assert.deepEqual(ids, ['T-002', 'T-003']);
}));

test('claim then start by another id path is blocked by the lock', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Setup'], dir);
  const c1 = run(['claim', 'proj', 'T-001', '--agent', 'alice'], dir);
  assert.equal(c1.status, 0);
  const c2 = run(['claim', 'proj', 'T-001', '--agent', 'bob'], dir);
  assert.equal(c2.status, 1);
  assert.match(c2.stderr, /already claimed by 'alice'/);
}));

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

test('validate passes for a fresh project and exits 0', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Setup'], dir);
  const r = run(['validate', 'proj'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /valid/);
}));

test('validate exits 1 and lists problems for a broken graph', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Setup', '--after', 'T-099'], dir);
  const r = run(['validate', 'proj'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing task 'T-099'/);
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

test('status inside project dir shows current project', () => withTmp(dir => {
  run(['init'], dir);
  run(['task', 'add', 'First task'], dir);
  const r = run(['status'], dir);
  assert.equal(r.status, 0);
  const name = require('path').basename(dir);
  assert.match(r.stdout, new RegExp(name));
  assert.match(r.stdout, /T-001/);
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
  assert.match(r.stdout, /single-task/);
  assert.match(r.stdout, /phase=prototype/);
  assert.match(r.stdout, /current_task=T-001/);
  assert.match(r.stdout, /blocked=false/);
  assert.match(r.stdout, /Completed: 0\/2/);
}));

test('start --all prints all-tasks mode', () => withTmp(dir => {
  run(['init', 'proj'], dir);
  run(['task', 'add', 'proj', 'Setup'], dir);

  const r = run(['start', 'proj', '--all'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /AGENT_START_HERE\.md/);
  assert.match(r.stdout, /all-tasks/);
}));

test('start fails for unknown project', () => withTmp(dir => {
  const r = run(['start', 'no-such'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found/);
}));

test('start without args works inside project dir', () => withTmp(dir => {
  run(['init'], dir);
  run(['task', 'add', 'Do thing'], dir);
  const r = run(['start'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /AGENT_START_HERE\.md/);
  assert.match(r.stdout, /phase=prototype/);
  assert.match(r.stdout, /current_task=T-001/);
}));

test('start without args fails outside project dir', () => withTmp(dir => {
  const r = run(['start'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not inside a project/);
}));

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

test('plan prints plan prompt with current state', () => withTmp(dir => {
  run(['init', 'proj'], dir);

  const r = run(['plan', 'proj'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /AGENT_PLAN_HERE\.md/);
  assert.match(r.stdout, /plan-only/);
  assert.match(r.stdout, /phase=prototype/);
  assert.match(r.stdout, /current_task=none/);
  assert.match(r.stdout, /blocked=false/);
  assert.match(r.stdout, /Completed: 0\/0/);
}));

test('plan --execute prints plan-and-execute mode', () => withTmp(dir => {
  run(['init', 'proj'], dir);

  const r = run(['plan', 'proj', '--execute'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /AGENT_PLAN_HERE\.md/);
  assert.match(r.stdout, /plan-and-execute/);
}));

test('plan fails for unknown project', () => withTmp(dir => {
  const r = run(['plan', 'no-such'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found/);
}));

test('plan without args works inside project dir', () => withTmp(dir => {
  run(['init'], dir);
  const r = run(['plan'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /AGENT_PLAN_HERE\.md/);
}));

test('plan without args fails outside project dir', () => withTmp(dir => {
  const r = run(['plan'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not inside a project/);
}));
