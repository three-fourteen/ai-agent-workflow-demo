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
  assert.throws(() => core.startTask(proj, 'T-001'), /already completed/);
}));

// ---------------------------------------------------------------------------
// Verification-gated completion
// ---------------------------------------------------------------------------

/** Create a one-task project whose task has the given Verify command. */
function verifyProject(dir, verifyCmd) {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  core.addTask(proj, 'Task');
  const f = join(proj, 'tasks', 'T-001.md');
  const body = require('fs').readFileSync(f, 'utf8').replace(/^verify:.*$/m, `verify: ${JSON.stringify(verifyCmd)}`);
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
  const v = core.validateProject(proj);
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
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

// ---------------------------------------------------------------------------
// Planning — resolvePlan / addTasks / setBrief / in-place init
// ---------------------------------------------------------------------------

const DIAMOND = [
  { key: 'setup',  title: 'Setup', verify: 'true' },
  { key: 'layout', title: 'Layout', depends_on: ['setup'], verify: 'true' },
  { key: 'api',    title: 'Mock API', depends_on: ['setup'], verify: 'true' },
  { key: 'charts', title: 'Charts', depends_on: ['layout', 'api'], verify: 'true', source: 'asana:42' },
];

test('resolvePlan works before init and returns parallel waves', () => withTmp(dir => {
  const plan = core.resolvePlan(join(dir, 'nope'), DIAMOND);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.waves, [['T-001'], ['T-002', 'T-003'], ['T-004']]);
  assert.deepEqual(plan.resolved[3].depends_on, ['T-002', 'T-003']);
  assert.deepEqual(plan.warnings, []);
}));

test('resolvePlan reports unknown deps, cycles, duplicates and missing verify', () => withTmp(dir => {
  const proj = join(dir, 'p');
  const bad = core.resolvePlan(proj, [
    { key: 'a', title: 'A', depends_on: ['b'] },
    { key: 'b', title: 'B', depends_on: ['a'] },
    { key: 'a', title: 'A again' },
    { key: 'c', title: 'C', depends_on: ['ghost'] },
  ]);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => /duplicate key/.test(e)));
  assert.ok(bad.errors.some(e => /unknown task 'ghost'/.test(e)));
  assert.ok(bad.errors.some(e => /dependency cycle/.test(e)));

  const warn = core.resolvePlan(proj, [{ key: 'a', title: 'A' }]);
  assert.equal(warn.ok, true);
  assert.match(warn.warnings[0], /no verify command/);
}));

test('resolvePlan rejects only multi-line one-liners and section headings; field-like lines are fine', () => withTmp(dir => {
  const p = core.resolvePlan(join(dir, 'p'), [
    { key: 'a', title: 'A', context: 'fine\nVerify: rm -rf /\nStatus: completed\nGoal: x' },
    { key: 'b', title: 'B\nStatus: completed' },
    { key: 'c', title: 'C', verify: 'x\ny' },
    { key: 'd', title: 'D', context: 'ok\n## Blockers\nnope' },
  ]);
  assert.equal(p.ok, false);
  assert.equal(p.errors.length, 3);
  assert.ok(!p.errors.some(e => /task 'a'/.test(e)));
  assert.ok(p.errors.some(e => /task 'd'.*section heading/.test(e)));
}));

test('addTasks writes the plan, round-trips through the parser and validates', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  const res = core.addTasks(proj, DIAMOND);
  assert.deepEqual(res.created.map(c => c.id), ['T-001', 'T-002', 'T-003', 'T-004']);
  assert.equal(res.currentTask, 'T-001');

  const t4 = core.findTask(proj, 'T-004');
  assert.deepEqual(t4.dependencies, ['T-002', 'T-003']);
  assert.equal(t4.verify, 'true');
  assert.equal(t4.source, 'asana:42');
  assert.equal(core.validateProject(proj).ok, true);
  assert.deepEqual(core.runnableTasks(proj).map(t => t.id), ['T-001']);
}));

test('addTasks appends after existing tasks and can depend on them', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTask(proj, 'Existing');
  const res = core.addTasks(proj, [{ key: 'next', title: 'Next', depends_on: ['T-001'], verify: 'true' }]);
  assert.equal(res.created[0].id, 'T-002');
  assert.deepEqual(core.findTask(proj, 'T-002').dependencies, ['T-001']);
}));

test('addTasks writes nothing when the plan is invalid', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  assert.throws(() => core.addTasks(proj, [
    { key: 'ok', title: 'Fine' },
    { key: 'bad', title: 'Broken', depends_on: ['ghost'] },
  ]), core.WorkflowError);
  assert.equal(core.listTasks(proj).length, 0);
}));

test('addTask accepts the extended fields and an array of deps', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTask(proj, 'A');
  core.addTask(proj, 'B');
  core.addTask(proj, 'C', { after: ['T-001', 'T-002'], verify: 'true', subtasks: ['one', 'two'], source: 'x:1' });
  const t = core.findTask(proj, 'T-003');
  assert.deepEqual(t.dependencies, ['T-001', 'T-002']);
  assert.equal(t.verify, 'true');
  assert.match(t.raw, /1\. one\n2\. two/);
}));

test('initProject can initialise an existing directory in place, once', () => withTmp(dir => {
  const r = core.initProject(dir, '', { inPlace: true });
  assert.equal(r.inPlace, true);
  assert.equal(core.readState(dir).project, require('node:path').basename(dir));
  assert.throws(() => core.initProject(dir, '', { inPlace: true }), /already an initialised project/);
}));

test('setBrief stores text with a source, replaces or appends', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.setBrief(proj, '# Brief\nBuild X.', { source: 'asana:42' });
  const file = join(proj, 'docs', 'brief.md');
  const read = () => require('node:fs').readFileSync(file, 'utf8');
  assert.match(read(), /^> Source: asana:42\n\n# Brief/);
  core.setBrief(proj, 'More.', { mode: 'append' });
  assert.match(read(), /Build X\.[\s\S]*---[\s\S]*More\./);
  core.setBrief(proj, 'Fresh.');
  assert.equal(read(), 'Fresh.\n');
  assert.throws(() => core.setBrief(proj, '  '), /empty/);
  assert.throws(() => core.setBrief(proj, 'x', { source: 'a\nb' }), /single line/);
}));

// ---------------------------------------------------------------------------
// Id gaps and re-planning
// ---------------------------------------------------------------------------

test('new task ids skip past gaps instead of colliding', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }, { key: 'c', title: 'C' }]);
  require('node:fs').unlinkSync(join(proj, 'tasks', core.findTask(proj, 'T-002').file)); // hand-deleted: gap in the middle
  assert.equal(core.nextTaskId(proj), 4);
  assert.equal(core.addTask(proj, 'D').taskId, 'T-004');
  assert.equal(core.resolvePlan(proj, [{ key: 'e', title: 'E' }]).resolved[0].id, 'T-005');
}));

test('a removed task id is retired, even the newest one', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }]);
  core.removeTask(proj, 'T-002');
  assert.equal(core.readState(proj).max_task_id, 2);
  assert.equal(core.nextTaskId(proj), 3);
  assert.equal(core.addTask(proj, 'C').taskId, 'T-003');
  assert.equal(core.addTasks(proj, [{ key: 'd', title: 'D' }]).created[0].id, 'T-004');
  assert.equal(core.validateProject(proj).ok, true);
}));

test('removing the newest task retires its id on projects without max_task_id', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }]);
  const state = core.readState(proj);
  delete state.max_task_id; // simulate a project created before the field existed
  core.writeState(proj, state);
  core.removeTask(proj, 'T-002');
  assert.equal(core.addTask(proj, 'C').taskId, 'T-003');
}));

test('starting a completed task explains it and points to next', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'A', verify: 'true' }]);
  core.startTask(proj, 'T-001');
  core.completeTask(proj, 'T-001');
  assert.throws(() => core.startTask(proj, 'T-001'), /already completed.*next/);
}));

test('updateTask edits fields in place and keeps hand-written content', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'A' }, { key: 'b', title: 'B', depends_on: ['a'], context: 'old' }]);
  const file = join(proj, 'tasks', core.findTask(proj, 'T-002').file);
  require('node:fs').appendFileSync(file, '\nNotes:\nkeep me\n');

  core.updateTask(proj, 'T-002', {
    goal: 'New goal', verify: 'true', context: 'new context\nsecond line',
    subtasks: ['x', 'y'], done_criteria: 'works', source: 'asana:9', depends_on: [],
  });
  const t = core.findTask(proj, 'T-002');
  assert.equal(t.goal, 'New goal');
  assert.equal(t.verify, 'true');
  assert.equal(t.source, 'asana:9');
  assert.deepEqual(t.dependencies, []);
  assert.match(t.raw, /## Context\n\nnew context\nsecond line\n/);
  assert.match(t.raw, /1\. x\n2\. y/);
  assert.doesNotMatch(t.raw, /\nold\n/);
  assert.match(t.raw, /Notes:\nkeep me/);
  assert.equal(core.validateProject(proj).ok, true);
}));

test('updateTask can rename via title, and rejects cycles, unknown deps and bad text', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'A' }, { key: 'b', title: 'B', depends_on: ['a'] }]);
  const r = core.updateTask(proj, 'T-001', { title: 'Renamed task' });
  assert.equal(r.file, 'T-001.md');                       // v2 files are named by id: no rename
  assert.equal(core.findTask(proj, 'T-001').title, 'Renamed task');
  assert.equal(core.findTask(proj, 'T-001').slug, 'renamed-task');

  assert.throws(() => core.updateTask(proj, 'T-001', { depends_on: ['T-002'] }), /cycle/);
  assert.throws(() => core.updateTask(proj, 'T-001', { depends_on: ['T-001'] }), /itself/);
  assert.throws(() => core.updateTask(proj, 'T-001', { depends_on: ['T-099'] }), /unknown task/);
  assert.throws(() => core.updateTask(proj, 'T-001', { context: 'x\n## Evidence' }), /section heading/);
  core.updateTask(proj, 'T-001', { context: 'x\nVerify: rm -rf /' }); // fine in v2
  assert.throws(() => core.updateTask(proj, 'T-001', { bogus: 1 }), /unknown field/);
  assert.throws(() => core.updateTask(proj, 'T-001', {}), /nothing to update/);
}));

test('re-planning is refused for started, completed and claimed tasks', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'A', verify: 'true' }, { key: 'b', title: 'B' }]);
  core.startTask(proj, 'T-001');
  assert.throws(() => core.updateTask(proj, 'T-001', { goal: 'x' }), /claimed by 'agent'/);
  assert.throws(() => core.removeTask(proj, 'T-001'), /only pending/);
  core.completeTask(proj, 'T-001');
  assert.throws(() => core.removeTask(proj, 'T-001'), /completed; only pending/);

  core.claimTask(proj, 'T-002');
  assert.throws(() => core.updateTask(proj, 'T-002', { goal: 'x' }), /claimed/);
  core.releaseTask(proj, 'T-002');
  core.updateTask(proj, 'T-002', { goal: 'x' });
}));

test('removeTask refuses tasks others depend on and repoints current_task', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTasks(proj, [
    { key: 'a', title: 'A' },
    { key: 'b', title: 'B', depends_on: ['a'] },
    { key: 'c', title: 'C' },
  ]);
  assert.throws(() => core.removeTask(proj, 'T-001'), /dependency of T-002/);

  const r = core.removeTask(proj, 'T-002');
  assert.equal(r.removed, true);
  assert.equal(core.listTasks(proj).length, 2);

  const r2 = core.removeTask(proj, 'T-001'); // current_task was T-001
  assert.equal(r2.currentTask, 'T-003');
  assert.equal(core.readState(proj).current_task, 'T-003');
  assert.equal(core.validateProject(proj).ok, true);
}));

test('starting a task another agent already holds names the holder', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTask(proj, 'Only');
  core.startTask(proj, 'T-001', { agent: 'agent-a' });
  assert.throws(() => core.startTask(proj, 'T-001', { agent: 'agent-b' }), /claimed by 'agent-a'/);
}));

// ---------------------------------------------------------------------------
// Worktrees — verify against the task branch
// ---------------------------------------------------------------------------

const { spawnSync } = require('node:child_process');

/** A git repo whose project lives in the `app/` subdirectory, committed on main. */
function gitProject(dir) {
  const repo = join(dir, 'repo');
  const proj = join(repo, 'app');
  mkdirSync(repo, { recursive: true });
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'Feature A', verify: 'test -f marker.txt' }]);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { repo, proj };
}

test('verify with workdir runs in the matching directory of a registered worktree', () => withTmp(dir => {
  const { proj } = gitProject(dir);
  core.startTask(proj, 'T-001');
  const wt = core.createWorktree(proj, 'T-001');
  assert.equal(wt.branch, 'task/T-001-feature-a');

  writeFileSync(join(wt.path, 'app', 'marker.txt'), 'x'); // the "work", only on the branch
  assert.equal(core.verifyTask(proj, 'T-001').ok, false);                       // main checkout: missing
  assert.equal(core.verifyTask(proj, 'T-001', { workdir: wt.path }).ok, true);  // worktree: present

  const done = core.completeTask(proj, 'T-001', { workdir: wt.path });
  assert.equal(done.verified, true);
  assert.equal(core.findTask(proj, 'T-001').status, 'completed');
}));

test('workdir must be a registered worktree of the same repo', () => withTmp(dir => {
  const { proj } = gitProject(dir);
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(join(elsewhere, 'app'), { recursive: true });
  writeFileSync(join(elsewhere, 'app', 'marker.txt'), 'x');
  assert.throws(() => core.verifyTask(proj, 'T-001', { workdir: elsewhere }), /not a registered git worktree/);
  assert.throws(() => core.verifyTask(proj, 'T-001', { workdir: '/' }), /not a registered git worktree/);
}));

test('createWorktree refuses a completed task', () => withTmp(dir => {
  const { proj } = gitProject(dir);
  core.startTask(proj, 'T-001');
  core.completeTask(proj, 'T-001', { noVerify: true });
  assert.throws(() => core.createWorktree(proj, 'T-001'), /already completed/);
}));

// ---------------------------------------------------------------------------
// State file — atomic writes and the cross-process lock
// ---------------------------------------------------------------------------

const { spawn } = require('node:child_process');
const { readdirSync, existsSync, utimesSync } = require('node:fs');

/** Run `script` in a fresh node process; resolves with its exit code. */
function runNode(script) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    child.on('close', resolve);
  });
}

test('parallel processes starting and completing tasks never lose a state update', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afw-core-'));
  try {
    const N = 8;
    core.initProject(dir, '', { inPlace: true });
    core.addTasks(dir, Array.from({ length: N }, (_, i) => ({ key: `t${i}`, title: `Task ${i}` })));

    const coreJs = JSON.stringify(join(__dirname, 'core.js'));
    const codes = await Promise.all(Array.from({ length: N }, (_, i) => runNode(`
      const core = require(${coreJs});
      const id = 'T-00${i + 1}';
      core.startTask(${JSON.stringify(dir)}, id, { agent: 'a${i}' });
      core.completeTask(${JSON.stringify(dir)}, id, { noVerify: true });
    `)));
    assert.deepEqual(codes, Array(N).fill(0));

    const state = core.readState(dir);
    assert.equal(state.completed_tasks.length, N, `lost updates: ${JSON.stringify(state.completed_tasks)}`);
    assert.deepEqual(state.in_progress, []);
    assert.equal(state.unverified.length, N);
    assert.equal(core.validateProject(dir).ok, true);

    const leftovers = readdirSync(join(dir, '.ai')).filter(f => f.endsWith('.tmp') || f === 'state.lock');
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('withStateLock is re-entrant and releases the lock afterwards', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  const lock = join(dir, '.ai', 'state.lock');
  const out = core.withStateLock(dir, () => {
    assert.ok(existsSync(lock));
    return core.withStateLock(dir, () => { assert.ok(existsSync(lock)); return 'inner'; });
  });
  assert.equal(out, 'inner');
  assert.ok(!existsSync(lock));
  assert.throws(() => core.withStateLock(dir, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!existsSync(lock), 'lock is released when fn throws');
}));

test('a stale state lock left by a dead process is reclaimed', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  const lock = join(dir, '.ai', 'state.lock');
  writeFileSync(lock, '{"pid":1}');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(core.withStateLock(dir, () => 'ok'), 'ok');
  assert.ok(!existsSync(lock));
}));

test('writeState replaces the file atomically and leaves no temp files', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  const state = core.readState(dir);
  state.phase = 'review';
  core.writeState(dir, state);
  assert.equal(core.readState(dir).phase, 'review');
  assert.deepEqual(readdirSync(join(dir, '.ai')).filter(f => f.endsWith('.tmp')), []);
}));

// ---------------------------------------------------------------------------
// T-002: current_task / nextTask derive from the dependency graph
// ---------------------------------------------------------------------------

test('parallel in-progress: completing one leaves current_task on the other', () => withTmp(dir => {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  core.addTask(proj, 'A');
  core.addTask(proj, 'B');
  core.addTask(proj, 'C', { after: 'T-001' });
  core.startTask(proj, 'T-001');
  core.startTask(proj, 'T-002');
  core.completeTask(proj, 'T-001', { noVerify: true });
  assert.equal(core.readState(proj).current_task, 'T-002');
  assert.equal(core.stateSummary(proj).current, 'T-002');
}));

test('completing a task reports a newly unblocked dependent, not the next in line', () => withTmp(dir => {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  core.addTask(proj, 'A');
  core.addTask(proj, 'B', { after: 'T-001' });
  core.addTask(proj, 'C');
  core.addTask(proj, 'D', { after: ['T-003'] });
  core.startTask(proj, 'T-003');
  const r = core.completeTask(proj, 'T-003', { noVerify: true });
  assert.equal(r.nextTask, 'T-004');
  assert.equal(core.readState(proj).current_task, 'T-001');
}));

test('current_task is never stale: a stale value is re-derived on status/start', () => withTmp(dir => {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  core.addTask(proj, 'A');
  core.addTask(proj, 'B');
  core.startTask(proj, 'T-001');
  core.completeTask(proj, 'T-001', { noVerify: true });
  const st = core.readState(proj); st.current_task = 'T-001'; core.writeState(proj, st);
  assert.equal(core.stateSummary(proj).current, 'T-002');
  core.startTask(proj, 'T-002');
  assert.equal(core.readState(proj).current_task, 'T-002');
  core.completeTask(proj, 'T-002', { noVerify: true });
  assert.equal(core.readState(proj).current_task, null);
}));

test('task files carry no hard-coded "Proceed to" next step', () => withTmp(dir => {
  const proj = join(dir, 'p');
  core.initProject(proj, '');
  core.addTask(proj, 'A');
  core.addTasks(proj, [{ key: 'x', title: 'X' }, { key: 'y', title: 'Y', depends_on: ['x'] }]);
  for (const t of core.listTasks(proj)) assert.doesNotMatch(t.raw, /Proceed to/);
  assert.match(core.findTask(proj, 'T-002').raw, /Unblocks T-003/);
}));

// ---------------------------------------------------------------------------
// T-003: task reset + in-progress update_task (claimant only)
// ---------------------------------------------------------------------------

test('resetTask returns an in-progress task to pending and fixes state', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'A', verify: 'true' }, { key: 'b', title: 'B' }]);
  core.startTask(proj, 'T-001', { agent: 'alice' });
  assert.throws(() => core.resetTask(proj, 'T-001', { agent: 'bob' }), /claimed by 'alice'/);
  const r = core.resetTask(proj, 'T-001', { agent: 'alice' });
  assert.equal(r.status, 'pending');
  assert.equal(core.findTask(proj, 'T-001').status, 'pending');
  assert.equal(core.readLock(proj, 'T-001'), null);
  const st = core.readState(proj);
  assert.deepEqual(st.in_progress, []);
  assert.equal(st.current_task, 'T-001'); // next runnable
  assert.equal(core.findTask(proj, 'T-001').verify, 'true');
  assert.throws(() => core.resetTask(proj, 'T-001'), /illegal transition/);
  core.startTask(proj, 'T-001'); // restartable
}));

test('updateTask edits an in-progress task only for its claimant', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'A', verify: 'true' }]);
  core.startTask(proj, 'T-001', { agent: 'alice' });
  assert.throws(() => core.updateTask(proj, 'T-001', { verify: 'false' }), /claimed by 'alice'/);
  assert.throws(() => core.updateTask(proj, 'T-001', { verify: 'false' }, { agent: 'bob' }), /claimed by 'alice'/);
  assert.throws(() => core.updateTask(proj, 'T-001', { title: 'New' }, { agent: 'alice' }), /can only change while pending/);
  core.updateTask(proj, 'T-001', { verify: 'echo ok', goal: 'New goal' }, { agent: 'alice' });
  const t = core.findTask(proj, 'T-001');
  assert.equal(t.verify, 'echo ok');
  assert.equal(t.goal, 'New goal');
  assert.equal(t.status, 'in-progress');
  core.completeTask(proj, 'T-001');
  assert.throws(() => core.updateTask(proj, 'T-001', { goal: 'x' }, { agent: 'alice' }), /completed; only pending/);
}));

// ---------------------------------------------------------------------------
// T-004: deferred status
// ---------------------------------------------------------------------------

test('deferred: normalizeStatus, state machine and defer/reopen round trip', () => withTmp(dir => {
  assert.equal(core.normalizeStatus('Deferred (backlog)'), 'deferred');
  assert.ok(core.STATUSES.includes('deferred'));
  core.initProject(dir, '', { inPlace: true });
  core.addTask(dir, 'One');
  core.addTask(dir, 'Two');
  core.deferTask(dir, 'T-002', { reason: 'backlog item' });
  const t = core.findTask(dir, 'T-002');
  assert.equal(t.status, 'deferred');
  assert.match(t.raw, /^Deferred: backlog item$/m);
  assert.deepEqual(core.runnableTasks(dir).map(x => x.id), ['T-001']);
  assert.throws(() => core.startTask(dir, 'T-002'), /illegal transition deferred/);
  assert.throws(() => core.deferTask(dir, 'T-002'), /illegal transition/);
  assert.ok(core.validateProject(dir).ok);
  core.reopenTask(dir, 'T-002');
  const r = core.findTask(dir, 'T-002');
  assert.equal(r.status, 'pending');
  assert.doesNotMatch(r.raw, /Deferred:/);
  assert.deepEqual(core.runnableTasks(dir).map(x => x.id), ['T-001', 'T-002']);
  assert.throws(() => core.reopenTask(dir, 'T-002'), /illegal transition/);
}));

test('deferred: a blocked task can be deferred and clears the project block flag', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTask(dir, 'One');
  core.blockTask(dir, 'T-001', { reason: 'x' });
  assert.equal(core.readState(dir).blocked, true);
  core.deferTask(dir, 'T-001', { reason: 'really backlog' });
  assert.equal(core.readState(dir).blocked, false);
  assert.equal(core.readState(dir).current_task, null);
  assert.ok(core.validateProject(dir).ok);
}));

test('deferred: finalize succeeds with deferred tasks but not with blocked ones', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTask(dir, 'One');
  core.addTask(dir, 'Two');
  core.blockTask(dir, 'T-002', { reason: 'x' });
  assert.throws(() => core.finalize(dir), /blocked task\(s\) T-002/);
  core.deferTask(dir, 'T-002', { reason: 'backlog' });
  const r = core.finalize(dir);
  assert.equal(r.phase, 'completed');
  assert.deepEqual(r.deferred, ['T-002']);
}));

test('deferred: dependents are not runnable and validate reports them', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTask(dir, 'One');
  core.addTask(dir, 'Two', { after: 'T-001' });
  core.deferTask(dir, 'T-001', { reason: 'later' });
  assert.deepEqual(core.runnableTasks(dir), []);
  assert.deepEqual(core.tasksWaitingOnDeferred(dir), [{ id: 'T-002', deferred: ['T-001'] }]);
  const v = core.validateProject(dir);
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /T-002 depends on deferred task T-001/);
}));

// ---------------------------------------------------------------------------
// T-005: project-wide verify, Verify-Expect, completion evidence, red-first
// ---------------------------------------------------------------------------

function evidenceProject(dir, taskVerify, { expect = '', projectVerify = '' } = {}) {
  const proj = join(dir, 'ev');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'Alpha', verify: taskVerify, verify_expect: expect }]);
  if (projectVerify) core.setProjectVerify(proj, projectVerify);
  core.startTask(proj, 'T-001', { redFirst: false });
  return { proj, file: join(proj, 'tasks', 'T-001.md') };
}

test('project_verify failure blocks completion even when the task check passes', () => withTmp(dir => {
  const { proj } = evidenceProject(dir, 'exit 0', { projectVerify: 'echo broken; exit 3' });
  assert.throws(() => core.completeTask(proj, 'T-001'), /project verification failed for T-001 \(exit 3\)/);
  assert.equal(core.findTask(proj, 'T-001').status, 'in-progress');
  core.setProjectVerify(proj, '');
  assert.equal(core.completeTask(proj, 'T-001').status, 'completed');
  assert.equal(core.readState(proj).project_verify, undefined);
}));

test('noVerify skips the task check but never the project check; force skips both', () => withTmp(dir => {
  const { proj } = evidenceProject(dir, '', { projectVerify: 'exit 1' });
  assert.throws(() => core.completeTask(proj, 'T-001', { noVerify: true }), /project verification failed/);
  const r = core.completeTask(proj, 'T-001', { force: true });
  assert.equal(r.verified, false);
  assert.deepEqual(core.readState(proj).unverified, ['T-001']);
}));

test('setProjectVerify validates, persists and is checked by validateProject', () => withTmp(dir => {
  const { proj } = evidenceProject(dir, 'exit 0');
  assert.throws(() => core.setProjectVerify(proj, 'a\nb'), /single-line/);
  core.setProjectVerify(proj, ' npm test ');
  assert.equal(core.readState(proj).project_verify, 'npm test');
  assert.equal(core.validateProject(proj).ok, true);
  const s = core.readState(proj);
  s.project_verify = 5;
  core.writeState(proj, s);
  assert.match(core.validateProject(proj).errors.join('\n'), /project_verify must be a string/);
}));

test('completion records an Evidence section the parser tolerates', () => withTmp(dir => {
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const { proj, file } = evidenceProject(dir, 'echo "Status: tricky"; echo done-line', { projectVerify: 'echo project-ok' });
  execFileSync('git', ['init', '-q'], { cwd: proj });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: proj });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: proj, encoding: 'utf8' }).trim();

  const r = core.completeTask(proj, 'T-001');
  assert.equal(r.evidence, true);
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /^## Evidence$/m);
  assert.match(raw, /- recorded: \d{4}-\d\d-\d\dT/);
  assert.ok(raw.includes(`- commit: ${sha}`));
  assert.match(raw, /- task verify: `echo "Status: tricky"; echo done-line` exit 0/);
  assert.match(raw, /\| done-line/);
  assert.match(raw, /- project verify: `echo project-ok` exit 0/);
  // output that looks like a reserved field must not change the parsed task
  const t = core.findTask(proj, 'T-001');
  assert.equal(t.status, 'completed');
  assert.equal(t.verify, 'echo "Status: tricky"; echo done-line');
  assert.equal(core.validateProject(proj).ok, true);
}));

test('evidence output tail is bounded', () => withTmp(dir => {
  const { proj, file } = evidenceProject(dir, 'node -e "for(let i=0;i<500;i++)console.log(\'line\'+i)"');
  core.completeTask(proj, 'T-001');
  const raw = require('fs').readFileSync(file, 'utf8');
  assert.match(raw, /\| line499/);
  assert.doesNotMatch(raw, /\| line100\b/);
  assert.ok(raw.split('\n').length < 100);
}));

test('forced completion records no evidence', () => withTmp(dir => {
  const { proj, file } = evidenceProject(dir, 'exit 0');
  core.completeTask(proj, 'T-001', { force: true });
  assert.doesNotMatch(require('fs').readFileSync(file, 'utf8'), /^## Evidence/m);
}));

test('verify_expect: a passing but vacuous verify fails completion', () => withTmp(dir => {
  const { proj } = evidenceProject(dir, 'echo "# pass 0"', { expect: '# pass [1-9]' });
  assert.equal(core.findTask(proj, 'T-001').verifyExpect, '# pass [1-9]');
  const v = core.verifyTask(proj, 'T-001');
  assert.equal(v.ok, false);
  assert.equal(v.code, 0);
  assert.equal(v.expectMatched, false);
  assert.throws(() => core.completeTask(proj, 'T-001'), /did not match Verify-Expect/);
  assert.equal(core.findTask(proj, 'T-001').status, 'in-progress');
}));

test('verify_expect completes when output matches, and is validated in plans and updates', () => withTmp(dir => {
  const { proj } = evidenceProject(dir, 'echo "# pass 7"', { expect: '# pass [1-9]' });
  assert.equal(core.completeTask(proj, 'T-001').verified, true);

  const bad = core.resolvePlan(dir, [{ key: 'a', title: 'A', verify: 'x', verify_expect: '([' }]);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /valid regular expression/);
  const multi = core.resolvePlan(dir, [{ key: 'a', title: 'A', verify: 'x', verify_expect: 'a\nb' }]);
  assert.equal(multi.ok, false);

  core.addTasks(proj, [{ key: 'b', title: 'Beta', verify: 'true' }]);
  core.updateTask(proj, 'T-002', { verify_expect: 'ok' });
  assert.equal(core.findTask(proj, 'T-002').verifyExpect, 'ok');
  assert.throws(() => core.updateTask(proj, 'T-002', { verify_expect: '(' }), /valid regular expression/);
  core.updateTask(proj, 'T-002', { verify_expect: '' });
  assert.equal(core.findTask(proj, 'T-002').verifyExpect, '');
}));

test('startTask warns when Verify already passes (red first), never blocks', () => withTmp(dir => {
  const proj = join(dir, 'rf');
  core.initProject(proj, '');
  core.addTasks(proj, [
    { key: 'a', title: 'Vacuous', verify: 'exit 0' },
    { key: 'b', title: 'Red', verify: 'exit 1' },
    { key: 'c', title: 'None' },
    { key: 'd', title: 'Skipped', verify: 'exit 0' },
  ]);
  const a = core.startTask(proj, 'T-001');
  assert.equal(a.status, 'in-progress');
  assert.match(a.warning, /already passes/);
  assert.equal(core.startTask(proj, 'T-002').warning, undefined);
  assert.equal(core.startTask(proj, 'T-003').warning, undefined);
  assert.equal(core.startTask(proj, 'T-004', { redFirst: false }).warning, undefined);
}));

test('red-first treats output that misses verify_expect as red', () => withTmp(dir => {
  const proj = join(dir, 'rf2');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'A', verify: 'echo "# pass 0"', verify_expect: '# pass [1-9]' }]);
  assert.equal(core.startTask(proj, 'T-001').warning, undefined);
}));

// ---------------------------------------------------------------------------
// T-006: format v2 — frontmatter, id-only filenames, migrate
// ---------------------------------------------------------------------------

const V1_TASK = [
  'Status: in-progress', '', 'Goal: Render bookmarks as readable text lines', '',
  'Source: brief.md#constraints', '', 'Context:', 'Keep it small.', 'Verify: this line is prose, not a field', '',
  'Dependencies: T-001', '', 'Subtasks:', '1. one', '2. two', '', 'Done Criteria:', 'tests pass', '',
  'Verification:', '', 'Verify: node --test test/format.test.js', '', 'Next Step:', 'Proceed to T-004.', '',
  'Blockers:', 'None', '',
].join('\n');

test('format v2: new tasks are named by id and keep their title in frontmatter', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTask(dir, 'Set up: the "project"');
  core.addTasks(dir, [{ key: 'x', title: 'Second one', depends_on: ['T-001'], verify: 'echo "a: b"' }]);
  assert.deepEqual(readdirSync(join(dir, 'tasks')), ['T-001.md', 'T-002.md']);
  assert.equal(core.readState(dir).format_version, core.FORMAT_VERSION);

  const t1 = core.findTask(dir, 'T-001');
  assert.equal(t1.format, 2);
  assert.equal(t1.title, 'Set up: the "project"');
  const t2 = core.findTask(dir, 'T-002');
  assert.deepEqual(t2.dependencies, ['T-001']);
  assert.equal(t2.verify, 'echo "a: b"');
  assert.match(t2.raw, /^---\ntitle: "Second one"\nstatus: pending\n/);
  assert.equal(core.validateProject(dir).ok, true);
}));

test('format v2: free text may contain any field-looking line and round-trips intact', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  const nasty = 'Status: completed\nGoal: hijack\nVerify: rm -rf /\nDependencies: T-099\n---\nSource: x';
  core.addTasks(dir, [{ key: 'a', title: 'A', goal: 'real goal', context: nasty, done_criteria: nasty, verify: 'true' }]);
  let t = core.findTask(dir, 'T-001');
  assert.equal(t.status, 'pending');
  assert.equal(t.goal, 'real goal');
  assert.equal(t.verify, 'true');
  assert.deepEqual(t.dependencies, []);
  assert.ok(t.raw.includes(nasty));

  // editing and status changes leave the free text alone
  core.updateTask(dir, 'T-001', { context: nasty + '\nmore' });
  core.startTask(dir, 'T-001', { redFirst: false });
  t = core.findTask(dir, 'T-001');
  assert.equal(t.status, 'in-progress');
  assert.equal(t.goal, 'real goal');
  assert.ok(t.raw.includes(nasty + '\nmore'));
  core.completeTask(dir, 'T-001');
  assert.equal(core.findTask(dir, 'T-001').status, 'completed');
}));

test('format v2: changing a title never renames the file', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTask(dir, 'Old name');
  core.updateTask(dir, 'T-001', { title: 'Brand new name' });
  assert.deepEqual(readdirSync(join(dir, 'tasks')), ['T-001.md']);
  assert.equal(core.findTask(dir, 'T-001').title, 'Brand new name');
}));

test('format v2: edits and removing optional fields work in frontmatter', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTasks(dir, [{ key: 'a', title: 'A', source: 'asana:1', verify_expect: 'ok' }]);
  core.updateTask(dir, 'T-001', { source: '', verify_expect: '', verify: 'echo hi' });
  const t = core.findTask(dir, 'T-001');
  assert.equal(t.source, '');
  assert.equal(t.verifyExpect, '');
  assert.equal(t.verify, 'echo hi');
  assert.doesNotMatch(t.raw, /^source:|^verify_expect:/m);
}));

test('format v2: legacy files are still read and edited in place, and validate warns', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  writeTask(dir, 'T-001-old-task.md', V1_TASK.replace('Dependencies: T-001', 'Dependencies: none'));
  const t = core.findTask(dir, 'T-001');
  assert.equal(t.format, 1);
  assert.equal(t.title, 'Old task');
  assert.equal(t.goal, 'Render bookmarks as readable text lines');
  core.updateTask(dir, 'T-001', { goal: 'new goal' });   // v1 edit path still works...
  assert.equal(core.findTask(dir, 'T-001').format, 1);   // ...and stays v1
  assert.throws(() => core.updateTask(dir, 'T-001', { context: 'x\nVerify: nope' }), /legacy format/);
  const v = core.validateProject(dir);
  assert.match(v.warnings.join('\n'), /legacy format \(T-001\); run `agent-workflow migrate`/);
}));

test('migrateProject converts v1 files losslessly and is idempotent', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTask(dir, 'Base task');                           // already v2
  writeTask(dir, 'T-002-text-formatter.md', V1_TASK);
  const before = core.findTask(dir, 'T-002');

  const dry = core.migrateProject(dir, { dryRun: true });
  assert.deepEqual(dry.migrated, [{ id: 'T-002', from: 'T-002-text-formatter.md', to: 'T-002.md' }]);
  assert.deepEqual(dry.skipped, ['T-001']);
  assert.ok(existsSync(join(dir, 'tasks', 'T-002-text-formatter.md')), 'dry run writes nothing');

  const r = core.migrateProject(dir);
  assert.equal(r.migrated.length, 1);
  assert.deepEqual(readdirSync(join(dir, 'tasks')), ['T-001.md', 'T-002.md']);
  const after = core.findTask(dir, 'T-002');
  assert.equal(after.format, 2);
  for (const f of ['status', 'goal', 'verify', 'source']) assert.equal(after[f], before[f], f);
  assert.deepEqual(after.dependencies, before.dependencies);
  assert.equal(after.title, 'Text formatter');
  // section bodies survive, including the prose line that looked like a field
  assert.match(after.raw, /## Context\n\nKeep it small\.\n\n## Subtasks/);
  assert.match(after.raw, /## Notes\n\nVerify: this line is prose, not a field\n/);   // nothing is dropped
  assert.match(after.raw, /## Subtasks\n\n1\. one\n2\. two\n/);
  assert.match(after.raw, /## Done Criteria\n\ntests pass\n/);
  assert.match(after.raw, /## Next Step\n\nProceed to T-004\.\n/);

  assert.equal(core.migrateProject(dir).migrated.length, 0);   // idempotent
  assert.equal(core.validateProject(dir).warnings.length, 0);
}));

test('migrateProject keeps stray lines in a Notes section and refreshes the template', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  writeFileSync(join(dir, '.ai', 'TASK_TEMPLATE.md'), 'Status: old template\n');
  writeTask(dir, 'T-001-odd.md', 'Some preamble\nStatus: pending\nGoal: g\nan extra line under goal\n\nDependencies: none\n');
  core.migrateProject(dir);
  const t = core.findTask(dir, 'T-001');
  assert.match(t.raw, /## Notes\n\nSome preamble\nan extra line under goal\n/);
  assert.match(require('fs').readFileSync(join(dir, '.ai', 'TASK_TEMPLATE.md'), 'utf8'), /^---\ntitle:/);
}));

test('migrated tasks keep working through the state machine and the scheduler', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  writeTask(dir, 'T-001-a.md', 'Status: pending\nGoal: a\nDependencies: none\nVerify: true\n');
  writeTask(dir, 'T-002-b.md', 'Status: pending\nGoal: b\nDependencies: T-001\nVerify: true\n');
  core.migrateProject(dir);
  assert.deepEqual(core.runnableTasks(dir).map(t => t.id), ['T-001']);
  core.startTask(dir, 'T-001', { redFirst: false });
  core.completeTask(dir, 'T-001');
  assert.deepEqual(core.runnableTasks(dir).map(t => t.id), ['T-002']);
}));

// ---------------------------------------------------------------------------
// T-007: decisions
// ---------------------------------------------------------------------------

test('decisions: recordDecisions stores bullets on the task, in order, skipping duplicates', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTasks(dir, [{ key: 'a', title: 'Alpha' }, { key: 'b', title: 'Beta' }]);
  const r = core.recordDecisions(dir, 'T-001', ['file lives at ~/.bookmarks.json', '  output is one line per item ']);
  assert.deepEqual(r.decisions, ['file lives at ~/.bookmarks.json', 'output is one line per item']);
  core.recordDecisions(dir, 'T-001', 'file lives at ~/.bookmarks.json');            // duplicate: ignored
  core.recordDecisions(dir, 'T-001', 'tags are lower-cased');
  assert.deepEqual(core.findTask(dir, 'T-001').decisions,
    ['file lives at ~/.bookmarks.json', 'output is one line per item', 'tags are lower-cased']);
  assert.match(core.findTask(dir, 'T-001').raw, /## Decisions\n\n- file lives at ~\/\.bookmarks\.json\n- output is one line per item\n- tags are lower-cased\n/);
  assert.deepEqual(core.findTask(dir, 'T-002').decisions, []);
}));

test('decisions: invalid input is rejected and nothing is written', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTask(dir, 'Alpha');
  const before = core.findTask(dir, 'T-001').raw;
  assert.throws(() => core.recordDecisions(dir, 'T-001', []), /no decision/);
  assert.throws(() => core.recordDecisions(dir, 'T-001', ['ok', '   ']), /non-empty/);
  assert.throws(() => core.recordDecisions(dir, 'T-001', ['two\nlines']), /single line/);
  assert.throws(() => core.recordDecisions(dir, 'T-001', ['x'.repeat(501)]), /longer than 500/);
  assert.throws(() => core.recordDecisions(dir, 'T-001', Array(21).fill('x')), /at most 20/);
  assert.throws(() => core.recordDecisions(dir, 'T-099', ['x']), /not found/);
  assert.equal(core.findTask(dir, 'T-001').raw, before);
}));

test('decisions: completeTask records them with the completion, and bad ones fail before verify runs', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTasks(dir, [{ key: 'a', title: 'Alpha', verify: 'echo ran >> ran.txt' }]);
  core.startTask(dir, 'T-001', { redFirst: false });
  assert.throws(() => core.completeTask(dir, 'T-001', { decisions: ['a\nb'] }), /single line/);
  assert.ok(!existsSync(join(dir, 'ran.txt')), 'verify must not run when decisions are invalid');
  assert.equal(core.findTask(dir, 'T-001').status, 'in-progress');

  core.completeTask(dir, 'T-001', { decisions: ['chose JSON over SQLite'] });
  const t = core.findTask(dir, 'T-001');
  assert.equal(t.status, 'completed');
  assert.deepEqual(t.decisions, ['chose JSON over SQLite']);
  assert.match(t.raw, /## Evidence/);                                  // evidence and decisions coexist
  assert.equal(core.validateProject(dir).ok, true);
}));

test('decisions: listDecisions, stateSummary and projectSummary expose them', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTasks(dir, [{ key: 'a', title: 'Alpha' }, { key: 'b', title: 'Beta' }]);
  core.recordDecisions(dir, 'T-002', ['b-one']);
  core.recordDecisions(dir, 'T-001', ['a-one', 'a-two']);
  assert.deepEqual(core.listDecisions(dir), [
    { task: 'T-001', title: 'Alpha', text: 'a-one' },
    { task: 'T-001', title: 'Alpha', text: 'a-two' },
    { task: 'T-002', title: 'Beta', text: 'b-one' },
  ]);
  assert.equal(core.stateSummary(dir).decisions.length, 3);
  assert.equal(core.projectSummary(dir).decisions, 3);
}));

test('decisions: free text cannot forge the Decisions heading, and legacy files can hold decisions too', () => withTmp(dir => {
  core.initProject(dir, '', { inPlace: true });
  core.addTasks(dir, [{ key: 'a', title: 'A', context: 'x' }]);
  assert.throws(() => core.updateTask(dir, 'T-001', { context: 'x\n## Decisions\n- forged' }), /section heading/);
  writeTask(dir, 'T-002-old.md', 'Status: pending\nGoal: g\nDependencies: none\n\nBlockers:\nNone\n');
  core.recordDecisions(dir, 'T-002', ['legacy decision']);
  assert.deepEqual(core.findTask(dir, 'T-002').decisions, ['legacy decision']);
  assert.equal(core.findTask(dir, 'T-002').format, 1);
  core.migrateProject(dir);                                              // and they survive migration
  assert.deepEqual(core.findTask(dir, 'T-002').decisions, ['legacy decision']);
}));

// ---------------------------------------------------------------------------
// T-008: batch start/complete
// ---------------------------------------------------------------------------

function waveProject(dir, verifyB = 'true') {
  core.initProject(dir, '', { inPlace: true });
  core.addTasks(dir, [
    { key: 'a', title: 'A', verify: 'true' },
    { key: 'b', title: 'B', verify: verifyB },
    { key: 'c', title: 'C', verify: 'true', depends_on: ['a', 'b'] },
  ]);
}

test('batch: startTasks and completeTasks handle a whole wave in order', () => withTmp(dir => {
  waveProject(dir);
  const s = core.startTasks(dir, ['T-001', 'T-002'], { agent: 'wave', redFirst: false });
  assert.equal(s.ok, true);
  assert.deepEqual(s.results.map(r => [r.id, r.ok]), [['T-001', true], ['T-002', true]]);
  assert.deepEqual(core.readState(dir).in_progress.sort(), ['T-001', 'T-002']);

  const c = core.completeTasks(dir, ['t-001', 'T-002']);                 // ids are case-insensitive
  assert.equal(c.ok, true);
  assert.ok(c.results.every(r => r.verified === true));
  assert.deepEqual(c.skipped, []);
  assert.deepEqual(core.readState(dir).completed_tasks.sort(), ['T-001', 'T-002']);
  assert.deepEqual(core.runnableTasks(dir).map(t => t.id), ['T-003']);
}));

test('batch: completeTasks stops at the first failure and leaves later tasks untouched', () => withTmp(dir => {
  waveProject(dir, 'exit 1');
  core.startTasks(dir, ['T-001', 'T-002'], { redFirst: false });
  const c = core.completeTasks(dir, ['T-001', 'T-002']);
  assert.equal(c.ok, false);
  assert.equal(c.failed.id, 'T-002');
  assert.match(c.failed.error, /verification failed for T-002/);
  assert.deepEqual(c.results.map(r => [r.id, r.ok]), [['T-001', true], ['T-002', false]]);
  assert.equal(core.findTask(dir, 'T-001').status, 'completed');
  assert.equal(core.findTask(dir, 'T-002').status, 'in-progress');

  core.startTasks(dir, ['T-003'], { redFirst: false });
  const again = core.completeTasks(dir, ['T-002', 'T-003']);      // T-002 still fails: T-003 is skipped, not attempted
  assert.equal(again.ok, false);
  assert.deepEqual(again.skipped, ['T-003']);
  assert.equal(core.findTask(dir, 'T-003').status, 'in-progress');
}));

test('batch: input is validated', () => withTmp(dir => {
  waveProject(dir);
  assert.throws(() => core.startTasks(dir, []), /non-empty array/);
  assert.throws(() => core.startTasks(dir, 'T-001'), /non-empty array/);
  assert.throws(() => core.startTasks(dir, ['T-001', 't-001']), /must not repeat/);
  assert.throws(() => core.startTasks(dir, Array.from({ length: 26 }, (_, i) => `T-${i + 1}`)), /at most 25/);
  assert.throws(() => core.completeTasks(dir, ['T-001'], { decisions: ['x'] }), /per task/);
}));
