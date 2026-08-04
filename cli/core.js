'use strict';

/**
 * core.js — the git-native workflow engine.
 *
 * Pure-ish functions that read and mutate on-disk project state. They throw
 * WorkflowError (never call process.exit / console.log) so the same logic can
 * back the CLI, the MCP server, and unit tests.
 */

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const templates = require('./templates');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An expected, user-facing failure. `code` becomes the process exit code. */
class WorkflowError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Paths & basic helpers
// ---------------------------------------------------------------------------

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function statePath(projectDir)  { return path.join(projectDir, '.ai', 'PROJECT_STATE.json'); }
function tasksDir(projectDir)   { return path.join(projectDir, 'tasks'); }

function isProjectDir(dir) {
  return fs.existsSync(statePath(dir));
}

function readState(projectDir) {
  const p = statePath(projectDir);
  if (!fs.existsSync(p)) {
    throw new WorkflowError(`${p} not found. Is '${projectDir}' a valid project?`);
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new WorkflowError(`${p} is not valid JSON: ${err.message}`);
  }
}

function writeState(projectDir, state) {
  fs.writeFileSync(statePath(projectDir), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** Sorted list of task filenames (T-xxx-*.md) for a project. */
function listTaskFiles(projectDir) {
  try {
    return fs.readdirSync(tasksDir(projectDir))
      .filter(f => /^T-.*\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

function countTasks(projectDir) {
  return listTaskFiles(projectDir).length;
}

function nextTaskId(projectDir) {
  return countTasks(projectDir) + 1;
}

function taskIdFromFilename(filename) {
  const m = /^(T-\d+)/.exec(filename);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Task file parsing
// ---------------------------------------------------------------------------

/** Normalize a Status: value to one of the canonical states. */
function normalizeStatus(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (s.startsWith('in-progress') || s === 'inprogress') return 'in-progress';
  if (s.startsWith('completed') || s === 'done')          return 'completed';
  if (s.startsWith('blocked'))                            return 'blocked';
  if (s.startsWith('pending') || s === 'todo')            return 'pending';
  return s || 'pending';
}

/**
 * Split a `Dependencies:` value into task ids. "none" / empty → [].
 * Tolerant of the slug form: `T-001-setup-project` is read as `T-001`.
 */
function parseDependencies(raw) {
  const v = String(raw || '').trim();
  if (!v || /^none$/i.test(v)) return [];
  return v
    .split(/[,\s]+/)
    .map(s => {
      const m = /^(T-\d+)/i.exec(s.trim());
      return m ? m[1].toUpperCase() : null;
    })
    .filter(Boolean);
}

/**
 * Parse a task markdown file into structured fields. Line-based and tolerant of
 * the loose `Key: value` format used by the demo projects.
 *
 * Returns { id, file, slug, status, dependencies, goal, verify, raw }.
 */
function parseTaskFile(fullPath) {
  const raw = fs.readFileSync(fullPath, 'utf8');
  const filename = path.basename(fullPath);
  const fields = { status: 'pending', dependencies: [], goal: '', verify: '' };

  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (key === 'status')            fields.status = normalizeStatus(val);
    else if (key === 'dependencies') fields.dependencies = parseDependencies(val);
    else if (key === 'goal')         fields.goal = val;
    else if (key === 'verify')       fields.verify = val;
  }

  const slugMatch = /^T-\d+-(.*)\.md$/.exec(filename);
  return {
    id: taskIdFromFilename(filename),
    file: filename,
    slug: slugMatch ? slugMatch[1] : '',
    status: fields.status,
    dependencies: fields.dependencies,
    goal: fields.goal,
    verify: fields.verify,
    raw,
  };
}

/** Parse every task file in a project, in id order. */
function listTasks(projectDir) {
  return listTaskFiles(projectDir).map(f => parseTaskFile(path.join(tasksDir(projectDir), f)));
}

/** Find a single task by id (e.g. "T-001"); throws if not found. */
function findTask(projectDir, taskId) {
  const id = String(taskId).toUpperCase();
  const file = listTaskFiles(projectDir).find(f => taskIdFromFilename(f) === id);
  if (!file) throw new WorkflowError(`Task '${taskId}' not found in ${tasksDir(projectDir)}.`);
  return parseTaskFile(path.join(tasksDir(projectDir), file));
}

// ---------------------------------------------------------------------------
// Operations (data in, data out — CLI/MCP handle presentation)
// ---------------------------------------------------------------------------

/** Scaffold a new project. Returns { projectName, aiDir, tasksDir, inPlace }. */
function initProject(project, description) {
  const inPlace = project === '.';
  if (!inPlace && fs.existsSync(project)) {
    throw new WorkflowError(`'${project}' already exists.`);
  }

  const aiDir  = path.join(project, '.ai');
  const tDir   = tasksDir(project);
  fs.mkdirSync(aiDir, { recursive: true });
  fs.mkdirSync(tDir,  { recursive: true });

  fs.writeFileSync(path.join(aiDir, 'AGENT_PLAN_HERE.md'),  templates.AGENT_PLAN_HERE,  'utf8');
  fs.writeFileSync(path.join(aiDir, 'AGENT_START_HERE.md'), templates.AGENT_START_HERE, 'utf8');
  fs.writeFileSync(path.join(aiDir, 'WORKING_RULES.md'),    templates.WORKING_RULES,    'utf8');
  fs.writeFileSync(path.join(aiDir, 'TASK_TEMPLATE.md'),    templates.TASK_TEMPLATE,    'utf8');
  fs.writeFileSync(path.join(aiDir, 'TASK_INDEX.json'),     templates.TASK_INDEX + '\n','utf8');
  fs.writeFileSync(path.join(aiDir, '.gitignore'),          'locks/\n',                 'utf8');

  const projectName = inPlace ? path.basename(process.cwd()) : project;
  const state = {
    project: projectName,
    phase: 'prototype',
    current_task: null,
    blocked: false,
    completed_tasks: [],
  };
  if (description) state.description = description;
  writeState(project, state);

  return { projectName, aiDir, tasksDir: tDir, inPlace };
}

/**
 * Create the next numbered task file. Returns { taskId, taskPath, setCurrent }.
 * Sets current_task if none is active.
 */
function addTask(project, title, { description = '', after = '' } = {}) {
  if (!isProjectDir(project)) {
    throw new WorkflowError(`project '${project}' not found.`);
  }

  const n        = nextTaskId(project);
  const taskId   = `T-${String(n).padStart(3, '0')}`;
  const filename = `${taskId}-${slugify(title)}.md`;
  const taskPath = path.join(tasksDir(project), filename);
  const desc     = description || title;
  const deps     = after || 'none';
  const nextStep = `Proceed to T-${String(n + 1).padStart(3, '0')}.`;

  const content = `\
Status: pending

Goal: ${desc}

Context:

Dependencies: ${deps}

Subtasks:

Done Criteria:

Verification:

Verify:

Next Step:
${nextStep}

Blockers:
None
`;

  fs.writeFileSync(taskPath, content, 'utf8');

  const state = readState(project);
  let setCurrent = false;
  if (!state.current_task) {
    state.current_task = taskId;
    writeState(project, state);
    setCurrent = true;
  }
  return { taskId, taskPath, setCurrent };
}

/** A compact status row for one project. */
function projectSummary(projectPath) {
  const state = readState(projectPath);
  return {
    name: projectPath === '.' ? state.project : projectPath,
    phase: state.phase || '?',
    current: state.current_task || '-',
    completed: (state.completed_tasks || []).length,
    total: countTasks(projectPath),
    blocked: !!state.blocked,
  };
}

// ---------------------------------------------------------------------------
// Locks — atomic task claims for parallel agents
// ---------------------------------------------------------------------------

function locksDir(projectDir) { return path.join(projectDir, '.ai', 'locks'); }
function lockPath(projectDir, taskId) { return path.join(locksDir(projectDir), `${taskId}.lock`); }

/** Task ids that currently hold a lock. */
function listLocks(projectDir) {
  try {
    return fs.readdirSync(locksDir(projectDir))
      .filter(f => f.endsWith('.lock'))
      .map(f => f.replace(/\.lock$/, ''));
  } catch {
    return [];
  }
}

function readLock(projectDir, taskId) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(projectDir, taskId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomically claim a task. The `wx` flag makes the write fail if the lock file
 * already exists — race-safe across concurrent processes, no dependency needed.
 */
function acquireLock(projectDir, taskId, agent = 'agent') {
  fs.mkdirSync(locksDir(projectDir), { recursive: true });
  const record = JSON.stringify({ agent, ts: new Date().toISOString() });
  try {
    fs.writeFileSync(lockPath(projectDir, taskId), record, { flag: 'wx', encoding: 'utf8' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      const held = readLock(projectDir, taskId);
      throw new WorkflowError(
        `${taskId} is already claimed${held && held.agent ? ` by '${held.agent}'` : ''}. ` +
        `Release it with \`agent-workflow release ${taskId}\` first.`);
    }
    throw err;
  }
}

function releaseLock(projectDir, taskId) {
  try { fs.unlinkSync(lockPath(projectDir, taskId)); } catch { /* not held */ }
}

// ---------------------------------------------------------------------------
// Scheduler — dependency-aware runnable set
// ---------------------------------------------------------------------------

/**
 * Every task that could be started right now: status pending, all dependencies
 * completed, and not currently claimed. Returns task objects in id order.
 */
function runnableTasks(project, state = null) {
  const st = state || readState(project);
  const completed = new Set(st.completed_tasks || []);
  const locked = new Set(listLocks(project));
  return listTasks(project).filter(t =>
    t.status === 'pending' &&
    !locked.has(t.id) &&
    t.dependencies.every(d => completed.has(d)));
}

// ---------------------------------------------------------------------------
// State machine — guarded task transitions
// ---------------------------------------------------------------------------

const STATUSES = ['pending', 'in-progress', 'completed', 'blocked'];

/** Legal transitions: from-status -> set of allowed to-statuses. */
const TRANSITIONS = {
  'pending':     new Set(['in-progress', 'blocked']),
  'in-progress': new Set(['completed', 'blocked']),
  'blocked':     new Set(['pending', 'in-progress']),
  'completed':   new Set(),
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from] || !TRANSITIONS[from].has(to)) {
    throw new WorkflowError(
      `illegal transition ${from} → ${to}. ` +
      `Allowed from ${from}: ${[...(TRANSITIONS[from] || [])].join(', ') || '(none — terminal)'}.`
    );
  }
}

/** Rewrite the `Status:` line of a task file in place. */
function setTaskStatus(projectDir, task, status) {
  const full = path.join(tasksDir(projectDir), task.file);
  let raw = task.raw;
  if (/^Status:.*$/m.test(raw)) {
    raw = raw.replace(/^Status:.*$/m, `Status: ${status}`);
  } else {
    raw = `Status: ${status}\n\n` + raw;
  }
  fs.writeFileSync(full, raw, 'utf8');
}

/** True when any task file is currently blocked. */
function anyBlocked(projectDir) {
  return listTasks(projectDir).some(t => t.status === 'blocked');
}

/**
 * The next runnable task in id order (pending, deps completed, unclaimed).
 * Returns a task id or null. Used when completing the current task.
 */
function selectNextTask(projectDir, state) {
  const runnable = runnableTasks(projectDir, state);
  return runnable.length ? runnable[0].id : null;
}

function addUnique(arr, id) {
  const a = arr || [];
  return a.includes(id) ? a : [...a, id];
}
function removeId(arr, id) {
  return (arr || []).filter(x => x !== id);
}

/** pending → in-progress. Atomically claims the task first. */
function startTask(project, taskId, { agent = 'agent' } = {}) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  assertTransition(task.status, 'in-progress');

  acquireLock(project, task.id, agent); // throws if another agent holds it
  const state = readState(project);
  setTaskStatus(project, task, 'in-progress');
  state.in_progress = addUnique(state.in_progress, task.id);
  if (!state.current_task) state.current_task = task.id;
  writeState(project, state);
  return { taskId: task.id, status: 'in-progress' };
}

/**
 * Run a task's `Verify:` command in the project dir. Returns
 * { ran, ok, command, code, stdout?, stderr? }. `inherit` streams the child's
 * output to this process (used by the CLI); otherwise output is captured.
 */
function verifyTask(project, taskId, { inherit = false } = {}) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  const command = task.verify;
  if (!command) return { ran: false, ok: false, command: '', code: null };

  const res = spawnSync(command, {
    cwd: project,
    shell: true,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });
  const code = res.status === null ? 1 : res.status;
  return {
    ran: true,
    ok: code === 0,
    command,
    code,
    stdout: inherit ? undefined : res.stdout,
    stderr: inherit ? undefined : res.stderr,
  };
}

/**
 * in-progress → completed. Runs the task's Verify command first and refuses to
 * complete on failure. `force` skips verification; `noVerify` completes a task
 * that has no Verify command. Advances current_task to the next runnable task.
 */
function completeTask(project, taskId, { force = false, noVerify = false, inherit = false } = {}) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  assertTransition(task.status, 'completed');

  let verified = false;
  if (!force && !noVerify) {
    if (!task.verify) {
      throw new WorkflowError(
        `${task.id} has no Verify command. Add a \`Verify:\` line to the task, ` +
        `or pass --no-verify (accept without a check) or --force.`);
    }
    const v = verifyTask(project, task.id, { inherit });
    if (!v.ok) {
      throw new WorkflowError(
        `verification failed for ${task.id} (exit ${v.code}). Not completed.`,
        v.code || 1);
    }
    verified = true;
  }

  const state = readState(project);
  setTaskStatus(project, task, 'completed');
  releaseLock(project, task.id);
  state.completed_tasks = addUnique(state.completed_tasks, task.id);
  state.in_progress = removeId(state.in_progress, task.id);
  if (!verified) state.unverified = addUnique(state.unverified, task.id);

  let nextTask = null;
  if (state.current_task === task.id || !state.current_task) {
    nextTask = selectNextTask(project, state);
    state.current_task = nextTask;
  }
  writeState(project, state);
  return { taskId: task.id, status: 'completed', nextTask, verified };
}

/** pending|in-progress → blocked. */
function blockTask(project, taskId, { reason = '', strategy = '' } = {}) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  assertTransition(task.status, 'blocked');

  const state = readState(project);
  setTaskStatus(project, task, 'blocked');
  releaseLock(project, task.id);
  state.in_progress = removeId(state.in_progress, task.id);
  state.blocked = true;
  if (reason) state.block_reason = reason;
  if (strategy) state.unblock_strategy = strategy;
  writeState(project, state);
  return { taskId: task.id, status: 'blocked' };
}

/** blocked → pending. Clears project block flag when nothing else is blocked. */
function unblockTask(project, taskId) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  assertTransition(task.status, 'pending');

  const state = readState(project);
  setTaskStatus(project, task, 'pending');
  if (!anyBlocked(project)) {
    state.blocked = false;
    delete state.block_reason;
    delete state.unblock_strategy;
  }
  writeState(project, state);
  return { taskId: task.id, status: 'pending' };
}

function requireProjectDir(project) {
  if (!isProjectDir(project)) {
    throw new WorkflowError(project === '.'
      ? 'not inside a project directory.'
      : `project '${project}' not found.`);
  }
}

/** Explicitly claim a task without changing its status. */
function claimTask(project, taskId, { agent = 'agent' } = {}) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  acquireLock(project, task.id, agent);
  return { taskId: task.id, agent };
}

/** Release a task's claim. */
function releaseTask(project, taskId) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  releaseLock(project, task.id);
  return { taskId: task.id };
}

// ---------------------------------------------------------------------------
// Worktree helper — isolate a task on its own branch
// ---------------------------------------------------------------------------

/** Compute the branch name and worktree directory name for a task (pure). */
function worktreePlan(task) {
  return {
    branch: `task/${task.id}-${task.slug}`,
    dirName: `${task.id.toLowerCase()}-${task.slug}`,
  };
}

/**
 * Create a git worktree on a task branch, placed as a sibling of the repo root
 * so it never pollutes the working tree. Returns { branch, path }.
 */
function createWorktree(project, taskId) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  const plan = worktreePlan(task);

  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: project, encoding: 'utf8' });
  if (top.status !== 0) {
    throw new WorkflowError(`not a git repository: ${(top.stderr || '').trim()}`);
  }
  const toplevel = top.stdout.trim();
  const wtPath = path.join(toplevel, '..', `${path.basename(toplevel)}-${plan.dirName}`);

  const res = spawnSync('git', ['worktree', 'add', '-b', plan.branch, wtPath], {
    cwd: project,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new WorkflowError(`git worktree add failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return { branch: plan.branch, path: wtPath };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a project's state file and task graph. Returns { ok, errors }.
 * Checks schema shape, referential integrity, dependency cycles, and
 * consistency between task-file statuses and PROJECT_STATE.
 */
function validateProject(project) {
  requireProjectDir(project);
  const errors = [];
  const state = readState(project);

  // --- shape ---
  const isStr  = v => typeof v === 'string';
  const isBool = v => typeof v === 'boolean';
  const isArr  = v => Array.isArray(v);
  if (!isStr(state.project))        errors.push('project must be a string');
  if (!isStr(state.phase))          errors.push('phase must be a string');
  if (!(state.current_task === null || isStr(state.current_task)))
    errors.push('current_task must be a string or null');
  if (!isBool(state.blocked))       errors.push('blocked must be a boolean');
  if (!isArr(state.completed_tasks)) errors.push('completed_tasks must be an array');
  if ('in_progress' in state && !isArr(state.in_progress))
    errors.push('in_progress must be an array');
  if ('unverified' in state && !isArr(state.unverified))
    errors.push('unverified must be an array');

  const tasks = listTasks(project);
  const ids = new Set(tasks.map(t => t.id));
  const byId = new Map(tasks.map(t => [t.id, t]));

  // --- referential integrity ---
  if (isStr(state.current_task) && !ids.has(state.current_task)) {
    errors.push(`current_task '${state.current_task}' has no task file`);
  }
  for (const id of state.completed_tasks || []) {
    if (!ids.has(id)) errors.push(`completed_tasks references missing task '${id}'`);
  }
  for (const id of state.in_progress || []) {
    if (!ids.has(id)) errors.push(`in_progress references missing task '${id}'`);
  }
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (!ids.has(dep)) errors.push(`${t.id} depends on missing task '${dep}'`);
    }
    if (!STATUSES.includes(t.status)) {
      errors.push(`${t.id} has unknown status '${t.status}'`);
    }
  }

  // --- dependency cycles ---
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...ids].map(id => [id, WHITE]));
  const visit = (id, stack) => {
    color.set(id, GRAY);
    const t = byId.get(id);
    for (const dep of (t ? t.dependencies : [])) {
      if (!ids.has(dep)) continue;
      if (color.get(dep) === GRAY) {
        errors.push(`dependency cycle: ${[...stack, id, dep].join(' → ')}`);
        continue;
      }
      if (color.get(dep) === WHITE) visit(dep, [...stack, id]);
    }
    color.set(id, BLACK);
  };
  for (const id of ids) if (color.get(id) === WHITE) visit(id, []);

  // --- status consistency ---
  const completedSet = new Set(state.completed_tasks || []);
  for (const t of tasks) {
    if (t.status === 'completed' && !completedSet.has(t.id)) {
      errors.push(`${t.id} status is completed but it is not in completed_tasks`);
    }
    if (t.status !== 'completed' && completedSet.has(t.id)) {
      errors.push(`${t.id} is in completed_tasks but its status is '${t.status}'`);
    }
  }
  if (state.blocked && !tasks.some(t => t.status === 'blocked')) {
    errors.push('state.blocked is true but no task is blocked');
  }
  if (!state.blocked && tasks.some(t => t.status === 'blocked')) {
    errors.push('a task is blocked but state.blocked is false');
  }

  return { ok: errors.length === 0, errors };
}

/** Set the project phase (the one field agents change directly, via command). */
function finalize(project, phase = 'completed') {
  requireProjectDir(project);
  const state = readState(project);
  state.phase = phase;
  writeState(project, state);
  return { phase };
}

/** State summary used by the plan/start prompt builders. */
function stateSummary(project) {
  const state = readState(project);
  return {
    phase: state.phase || 'prototype',
    current: state.current_task || 'none',
    blocked: !!state.blocked,
    completed: (state.completed_tasks || []).length,
    total: countTasks(project),
  };
}

module.exports = {
  WorkflowError,
  slugify,
  statePath,
  tasksDir,
  isProjectDir,
  readState,
  writeState,
  listTaskFiles,
  countTasks,
  nextTaskId,
  taskIdFromFilename,
  normalizeStatus,
  parseDependencies,
  parseTaskFile,
  listTasks,
  findTask,
  initProject,
  addTask,
  projectSummary,
  stateSummary,
  STATUSES,
  TRANSITIONS,
  setTaskStatus,
  selectNextTask,
  runnableTasks,
  startTask,
  verifyTask,
  completeTask,
  blockTask,
  unblockTask,
  claimTask,
  releaseTask,
  listLocks,
  readLock,
  worktreePlan,
  createWorktree,
  validateProject,
  finalize,
  requireProjectDir,
};
