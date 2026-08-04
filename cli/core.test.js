'use strict';

/**
 * Unit tests for cli/core.js — the workflow engine.
 * Run: node --test cli/core.test.js
 */

const { test }   = require('node:test');
const assert     = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require('node:fs');
const { join }   = require('node:path');
const { tmpdir } = require('node:os');

const core = require('./core');

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'afw-core-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true }); }
}

/** Write a task file into <project>/tasks and return its path. */
function writeTask(project, filename, body) {
  const p = join(project, 'tasks', filename);
  writeFileSync(p, body, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// slugify / parseDependencies / normalizeStatus
// ---------------------------------------------------------------------------

test('slugify strips punctuation and normalizes separators', () => {
  assert.equal(core.slugify('Build Dashboard UI!'), 'build-dashboard-ui');
  assert.equal(core.slugify('  Trim__me  '), 'trim-me');
});

test('parseDependencies handles none, single, and comma lists', () => {
  assert.deepEqual(core.parseDependencies('none'), []);
  assert.deepEqual(core.parseDependencies(''), []);
  assert.deepEqual(core.parseDependencies('T-001'), ['T-001']);
  assert.deepEqual(core.parseDependencies('T-001, T-002'), ['T-001', 'T-002']);
  assert.deepEqual(core.parseDependencies('t-001 t-003'), ['T-001', 'T-003']);
  // slug form is tolerated
  assert.deepEqual(core.parseDependencies('T-001-setup-project'), ['T-001']);
  assert.deepEqual(core.parseDependencies('T-001-setup, T-002-fetch-mockups'), ['T-001', 'T-002']);
});

test('normalizeStatus maps loose spellings to canonical states', () => {
  assert.equal(core.normalizeStatus('pending'), 'pending');
  assert.equal(core.normalizeStatus('in progress'), 'in-progress');
  assert.equal(core.normalizeStatus('in-progress'), 'in-progress');
  assert.equal(core.normalizeStatus('Completed'), 'completed');
  assert.equal(core.normalizeStatus('blocked'), 'blocked');
});

// ---------------------------------------------------------------------------
// parseTaskFile
// ---------------------------------------------------------------------------

test('parseTaskFile reads the demo loose format', () => withTmp(dir => {
  core.initProject(join(dir, 'proj'), '');
  const p = writeTask(join(dir, 'proj'), 'T-001-setup-project.md', [
    'Status: pending',
    '',
    'Goal: setup project',
    '',
    'Dependencies: none',
    '',
    'Verification:',
    'Run the app.',
  ].join('\n'));

  const t = core.parseTaskFile(p);
  assert.equal(t.id, 'T-001');
  assert.equal(t.slug, 'setup-project');
  assert.equal(t.status, 'pending');
  assert.deepEqual(t.dependencies, []);
  assert.equal(t.goal, 'setup project');
}));

test('parseTaskFile parses comma dependencies and verify command', () => withTmp(dir => {
  core.initProject(join(dir, 'proj'), '');
  const p = writeTask(join(dir, 'proj'), 'T-003-charts.md', [
    'Status: in-progress',
    'Goal: add charts',
    'Dependencies: T-001, T-002',
    'Verify: npm test',
  ].join('\n'));

  const t = core.parseTaskFile(p);
  assert.equal(t.id, 'T-003');
  assert.equal(t.status, 'in-progress');
  assert.deepEqual(t.dependencies, ['T-001', 'T-002']);
  assert.equal(t.verify, 'npm test');
}));

test('parseTaskFile defaults missing fields', () => withTmp(dir => {
  core.initProject(join(dir, 'proj'), '');
  const p = writeTask(join(dir, 'proj'), 'T-002-thing.md', 'Goal: just a goal\n');
  const t = core.parseTaskFile(p);
  assert.equal(t.status, 'pending');
  assert.deepEqual(t.dependencies, []);
  assert.equal(t.verify, '');
}));

// ---------------------------------------------------------------------------
// listTasks / findTask
// ---------------------------------------------------------------------------

test('listTasks returns tasks in id order', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTask(proj, 'First');
  core.addTask(proj, 'Second', { after: 'T-001' });

  const tasks = core.listTasks(proj);
  assert.deepEqual(tasks.map(t => t.id), ['T-001', 'T-002']);
  assert.deepEqual(tasks[1].dependencies, ['T-001']);
}));

test('findTask throws WorkflowError for missing id', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  assert.throws(() => core.findTask(proj, 'T-099'), core.WorkflowError);
}));

// ---------------------------------------------------------------------------
// readState error handling
// ---------------------------------------------------------------------------

test('readState throws WorkflowError when not a project', () => withTmp(dir => {
  assert.throws(() => core.readState(dir), core.WorkflowError);
}));

test('readState throws WorkflowError on invalid JSON', () => withTmp(dir => {
  mkdirSync(join(dir, '.ai'), { recursive: true });
  writeFileSync(join(dir, '.ai', 'PROJECT_STATE.json'), '{ not json', 'utf8');
  assert.throws(() => core.readState(dir), core.WorkflowError);
}));

// ---------------------------------------------------------------------------
// State machine — guarded transitions
// ---------------------------------------------------------------------------

/** Build a project with two tasks (T-002 depends on T-001). */
function twoTaskProject(dir) {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTask(proj, 'First');
  core.addTask(proj, 'Second', { after: 'T-001' });
  return proj;
}

test('startTask moves pending → in-progress and records in_progress', () => withTmp(dir => {
  const proj = twoTaskProject(dir);
  core.startTask(proj, 'T-001');
  assert.equal(core.findTask(proj, 'T-001').status, 'in-progress');
  assert.deepEqual(core.readState(proj).in_progress, ['T-001']);
}));

test('completeTask requires in-progress (illegal from pending)', () => withTmp(dir => {
  const proj = twoTaskProject(dir);
  assert.throws(() => core.completeTask(proj, 'T-001'), /illegal transition pending → completed/);
}));

test('completeTask advances current_task to next runnable task', () => withTmp(dir => {
  const proj = twoTaskProject(dir);
  core.startTask(proj, 'T-001');
  const r = core.completeTask(proj, 'T-001', { noVerify: true });
  assert.equal(r.nextTask, 'T-002');
  const state = core.readState(proj);
  assert.deepEqual(state.completed_tasks, ['T-001']);
  assert.equal(state.current_task, 'T-002');
  assert.deepEqual(state.in_progress, []);
}));

test('completeTask leaves current_task null when nothing else is runnable', () => withTmp(dir => {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  core.addTask(proj, 'Only');
  core.startTask(proj, 'T-001');
  const r = core.completeTask(proj, 'T-001', { noVerify: true });
  assert.equal(r.nextTask, null);
  assert.equal(core.readState(proj).current_task, null);
}));

test('blockTask sets flag + reason; unblockTask clears it', () => withTmp(dir => {
  const proj = twoTaskProject(dir);
  core.blockTask(proj, 'T-001', { reason: 'need keys', strategy: 'ask user' });
  let state = core.readState(proj);
  assert.equal(core.findTask(proj, 'T-001').status, 'blocked');
  assert.equal(state.blocked, true);
  assert.equal(state.block_reason, 'need keys');

  core.unblockTask(proj, 'T-001');
  state = core.readState(proj);
  assert.equal(core.findTask(proj, 'T-001').status, 'pending');
  assert.equal(state.blocked, false);
  assert.equal('block_reason' in state, false);
}));

test('completed is terminal — cannot restart', () => withTmp(dir => {
  const proj = twoTaskProject(dir);
  core.startTask(proj, 'T-001');
  core.completeTask(proj, 'T-001', { noVerify: true });
  assert.throws(() => core.startTask(proj, 'T-001'), /illegal transition completed/);
}));

// ---------------------------------------------------------------------------
// Verification-gated completion
// ---------------------------------------------------------------------------

/** Create a one-task project whose task has the given Verify command. */
function verifyProject(dir, verifyCmd) {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  core.addTask(proj, 'Task');
  const f = join(proj, 'tasks', 'T-001-task.md');
  const body = require('fs').readFileSync(f, 'utf8').replace(/^Verify:.*$/m, `Verify: ${verifyCmd}`);
  writeFileSync(f, body, 'utf8');
  core.startTask(proj, 'T-001');
  return proj;
}

test('verifyTask reports pass for exit 0', () => withTmp(dir => {
  const proj = verifyProject(dir, 'exit 0');
  const v = core.verifyTask(proj, 'T-001');
  assert.equal(v.ran, true);
  assert.equal(v.ok, true);
  assert.equal(v.code, 0);
}));

test('verifyTask reports fail for exit 1', () => withTmp(dir => {
  const proj = verifyProject(dir, 'exit 1');
  const v = core.verifyTask(proj, 'T-001');
  assert.equal(v.ok, false);
  assert.equal(v.code, 1);
}));

test('verifyTask reports not-run when no Verify command', () => withTmp(dir => {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  core.addTask(proj, 'Task');
  assert.equal(core.verifyTask(proj, 'T-001').ran, false);
}));

test('completeTask passes when Verify succeeds', () => withTmp(dir => {
  const proj = verifyProject(dir, 'exit 0');
  const r = core.completeTask(proj, 'T-001');
  assert.equal(r.verified, true);
  assert.deepEqual(core.readState(proj).completed_tasks, ['T-001']);
}));

test('completeTask refuses when Verify fails', () => withTmp(dir => {
  const proj = verifyProject(dir, 'exit 1');
  assert.throws(() => core.completeTask(proj, 'T-001'), /verification failed/);
  // still in-progress, not completed
  assert.equal(core.findTask(proj, 'T-001').status, 'in-progress');
}));

test('completeTask with force skips Verify and records unverified', () => withTmp(dir => {
  const proj = verifyProject(dir, 'exit 1');
  const r = core.completeTask(proj, 'T-001', { force: true });
  assert.equal(r.verified, false);
  assert.deepEqual(core.readState(proj).unverified, ['T-001']);
}));

test('completeTask errors when no Verify command and not forced', () => withTmp(dir => {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  core.addTask(proj, 'Task');            // template Verify: is empty
  core.startTask(proj, 'T-001');
  assert.throws(() => core.completeTask(proj, 'T-001'), /no Verify command/);
}));

test('completeTask with noVerify accepts a task without a Verify command', () => withTmp(dir => {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  core.addTask(proj, 'Task');
  core.startTask(proj, 'T-001');
  const r = core.completeTask(proj, 'T-001', { noVerify: true });
  assert.equal(r.verified, false);
  assert.equal(core.findTask(proj, 'T-001').status, 'completed');
}));

// ---------------------------------------------------------------------------
// Scheduler & locks
// ---------------------------------------------------------------------------

/** setup → (A after setup), (B after setup), (integrate after A). */
function diamondProject(dir) {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTask(proj, 'Setup');
  core.addTask(proj, 'Feature A', { after: 'T-001' });
  core.addTask(proj, 'Feature B', { after: 'T-001' });
  core.addTask(proj, 'Integrate', { after: 'T-002' });
  return proj;
}

test('runnableTasks respects dependencies', () => withTmp(dir => {
  const proj = diamondProject(dir);
  assert.deepEqual(core.runnableTasks(proj).map(t => t.id), ['T-001']);

  core.startTask(proj, 'T-001');
  core.completeTask(proj, 'T-001', { noVerify: true });
  // T-002 and T-003 unblock; T-004 still waits on T-002
  assert.deepEqual(core.runnableTasks(proj).map(t => t.id), ['T-002', 'T-003']);
}));

test('acquireLock is exclusive; release frees it', () => withTmp(dir => {
  const proj = diamondProject(dir);
  core.claimTask(proj, 'T-001', { agent: 'alice' });
  assert.throws(() => core.claimTask(proj, 'T-001', { agent: 'bob' }), /already claimed by 'alice'/);
  assert.deepEqual(core.listLocks(proj), ['T-001']);

  core.releaseTask(proj, 'T-001');
  assert.deepEqual(core.listLocks(proj), []);
  assert.doesNotThrow(() => core.claimTask(proj, 'T-001', { agent: 'bob' }));
}));

test('a claimed task is excluded from the runnable set', () => withTmp(dir => {
  const proj = diamondProject(dir);
  core.startTask(proj, 'T-001');
  core.completeTask(proj, 'T-001', { noVerify: true });
  core.claimTask(proj, 'T-002', { agent: 'alice' });
  assert.deepEqual(core.runnableTasks(proj).map(t => t.id), ['T-003']);
}));

test('starting a task claims it; completing releases the claim', () => withTmp(dir => {
  const proj = diamondProject(dir);
  core.startTask(proj, 'T-001', { agent: 'alice' });
  assert.deepEqual(core.listLocks(proj), ['T-001']);
  assert.equal(core.readLock(proj, 'T-001').agent, 'alice');
  core.completeTask(proj, 'T-001', { noVerify: true });
  assert.deepEqual(core.listLocks(proj), []);
}));

test('worktreePlan derives a branch and dir name from the task', () => {
  const plan = core.worktreePlan({ id: 'T-002', slug: 'feature-a' });
  assert.equal(plan.branch, 'task/T-002-feature-a');
  assert.equal(plan.dirName, 't-002-feature-a');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validateProject passes for a fresh project', () => withTmp(dir => {
  const proj = twoTaskProject(dir);
  assert.deepEqual(core.validateProject(proj), { ok: true, errors: [] });
}));

test('validateProject flags a missing dependency', () => withTmp(dir => {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  writeTask(proj, 'T-001-a.md', 'Status: pending\nDependencies: T-099\n');
  const { ok, errors } = core.validateProject(proj);
  assert.equal(ok, false);
  assert.ok(errors.some(e => /missing task 'T-099'/.test(e)));
}));

test('validateProject detects a dependency cycle', () => withTmp(dir => {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  writeTask(proj, 'T-001-a.md', 'Status: pending\nDependencies: T-002\n');
  writeTask(proj, 'T-002-b.md', 'Status: pending\nDependencies: T-001\n');
  const { ok, errors } = core.validateProject(proj);
  assert.equal(ok, false);
  assert.ok(errors.some(e => /cycle/.test(e)));
}));

test('validateProject flags status/completed_tasks inconsistency', () => withTmp(dir => {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  writeTask(proj, 'T-001-a.md', 'Status: completed\nDependencies: none\n');
  // T-001 is completed on disk but not recorded in completed_tasks.
  const { ok, errors } = core.validateProject(proj);
  assert.equal(ok, false);
  assert.ok(errors.some(e => /not in completed_tasks/.test(e)));
}));
