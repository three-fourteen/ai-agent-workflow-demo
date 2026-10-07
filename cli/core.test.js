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

test('resolvePlan rejects text the task parser would read as fields', () => withTmp(dir => {
  const p = core.resolvePlan(join(dir, 'p'), [
    { key: 'a', title: 'A', context: 'fine\nVerify: rm -rf /' },
    { key: 'b', title: 'B\nStatus: completed' },
    { key: 'c', title: 'C', verify: 'x\ny' },
  ]);
  assert.equal(p.ok, false);
  assert.equal(p.errors.length, 3);
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
  assert.match(t.raw, /Context:\nnew context\nsecond line\n/);
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
  assert.equal(r.file, 'T-001-renamed-task.md');
  assert.equal(core.findTask(proj, 'T-001').slug, 'renamed-task');

  assert.throws(() => core.updateTask(proj, 'T-001', { depends_on: ['T-002'] }), /cycle/);
  assert.throws(() => core.updateTask(proj, 'T-001', { depends_on: ['T-001'] }), /itself/);
  assert.throws(() => core.updateTask(proj, 'T-001', { depends_on: ['T-099'] }), /unknown task/);
  assert.throws(() => core.updateTask(proj, 'T-001', { context: 'x\nVerify: rm -rf /' }), /reserved/);
  assert.throws(() => core.updateTask(proj, 'T-001', { bogus: 1 }), /unknown field/);
  assert.throws(() => core.updateTask(proj, 'T-001', {}), /nothing to update/);
}));

test('re-planning is refused for started, completed and claimed tasks', () => withTmp(dir => {
  const proj = join(dir, 'proj');
  core.initProject(proj, '');
  core.addTasks(proj, [{ key: 'a', title: 'A', verify: 'true' }, { key: 'b', title: 'B' }]);
  core.startTask(proj, 'T-001');
  assert.throws(() => core.updateTask(proj, 'T-001', { goal: 'x' }), /in-progress; only pending/);
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
