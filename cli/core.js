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

/** Write via a temp file + rename so a reader never sees a half-written file. */
function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

function writeState(projectDir, state) {
  writeFileAtomic(statePath(projectDir), JSON.stringify(state, null, 2) + '\n');
}

// --- state lock: serialises read-modify-write across processes -------------

const LOCK_WAIT_MS  = 10_000; // give up after this long
const LOCK_STALE_MS = 30_000; // a lock older than this belongs to a dead process
const heldStateLocks = new Map(); // lock path -> re-entry depth (this process)

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding the project's state lock (`.ai/state.lock`, created
 * with the `wx` flag). Re-entrant within a process. Mutating commands use it so
 * two concurrent readers of PROJECT_STATE.json can't overwrite each other's
 * update. Do not hold it across long work such as a task's Verify command.
 */
function withStateLock(projectDir, fn) {
  if (!isProjectDir(projectDir)) return fn(); // nothing to protect yet (e.g. before init)
  const lock = path.join(projectDir, '.ai', 'state.lock');
  const depth = heldStateLocks.get(lock) || 0;
  if (depth > 0) {
    heldStateLocks.set(lock, depth + 1);
    try { return fn(); } finally { heldStateLocks.set(lock, depth); }
  }

  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
      } catch { continue; } // vanished between calls: retry immediately
      if (Date.now() > deadline) {
        throw new WorkflowError(`timed out waiting for the project state lock (${lock}). Remove it if no other agent is running.`);
      }
      sleepSync(10);
    }
  }

  heldStateLocks.set(lock, 1);
  try {
    return fn();
  } finally {
    heldStateLocks.delete(lock);
    try { fs.unlinkSync(lock); } catch { /* already removed */ }
  }
}

/** Wrap a `(project, ...args)` mutator so it runs under the state lock. */
const locked = fn => (project, ...args) => withStateLock(project, () => fn(project, ...args));

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

/**
 * Next free task number: one past the highest id that ever existed. The state's
 * `max_task_id` high-water mark retires ids of removed tasks; file names cover
 * hand-created tasks and projects that predate the field.
 */
function nextTaskId(projectDir) {
  const nums = listTaskFiles(projectDir)
    .map(f => /^T-(\d+)/.exec(f))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10));
  let high = 0;
  try { high = Number(readState(projectDir).max_task_id) || 0; } catch { /* not initialised yet */ }
  return Math.max(high, ...nums, 0) + 1;
}

/** Raise the state's retired-id high-water mark to at least `n`. */
function noteTaskId(state, n) {
  if (!(state.max_task_id >= n)) state.max_task_id = n;
}

function taskIdFromFilename(filename) {
  const m = /^(T-\d+)/.exec(filename);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Task file format v2: YAML frontmatter (one-line fields) + a free-form body
// ---------------------------------------------------------------------------
//
//   ---
//   title: "Short title"
//   status: pending
//   goal: "One line"
//   dependencies: ["T-001"]
//   verify: "npm test"
//   ---
//   ## Context
//   ...free text, any line allowed...
//
// Frontmatter values are written as JSON (a YAML subset), so any character is
// safe in a value and no YAML library is needed. v1 files (loose `Key: value`
// lines) are still read and edited in place; `migrate` converts them.

const FORMAT_VERSION = 2;
const SECTION_NAMES = ['Context', 'Subtasks', 'Done Criteria', 'Decisions', 'Verification', 'Next Step', 'Blockers', 'Evidence'];
const SECTION_RE = new RegExp(`^##\\s+(${SECTION_NAMES.join('|')})\\s*$`, 'i');
/** Body headings v2 sections are delimited by; free text must not contain them. */
const RESERVED_HEADING_RE = new RegExp(`^##\\s+(${SECTION_NAMES.join('|')})\\s*$`, 'im');
const FM_KEYS = { status: 'status', goal: 'goal', source: 'source', verify: 'verify',
                  verify_expect: 'verify_expect', dependencies: 'dependencies', title: 'title' };

function hasFrontmatter(raw) { return /^---\r?\n/.test(raw); }

/** Split a v2 file into { front: [lines], body: string }. */
function splitFrontmatter(raw) {
  const lines = raw.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 0) return { front: [], body: raw };
  return { front: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}

function fmEncode(v) { return JSON.stringify(v); }
function fmDecode(text) {
  const t = String(text).trim();
  if (/^["\[]/.test(t)) { try { return JSON.parse(t); } catch { /* fall through to raw text */ } }
  return t;
}

function parseFrontmatter(frontLines) {
  const out = {};
  for (const line of frontLines) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = fmDecode(m[2]);
  }
  return out;
}

/** "project-setup" → "Project setup" (v1 files only kept their title as a slug). */
function humanizeSlug(slug) {
  const t = String(slug || '').replace(/-+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
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
  if (s.startsWith('deferred') || s === 'wontdo' || s === "won't-do") return 'deferred';
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
 * Returns { id, file, slug, status, dependencies, goal, verify, source, raw }.
 */
function parseTaskFile(fullPath) {
  return parseTaskText(fs.readFileSync(fullPath, 'utf8'), path.basename(fullPath));
}

/** Parse task file text (format v1 or v2) as if it were stored under `filename`. */
function parseTaskText(raw, filename) {
  const fields = { status: 'pending', dependencies: [], goal: '', verify: '', verifyExpect: '', source: '', title: '' };
  const v2 = hasFrontmatter(raw);

  if (v2) {
    const fm = parseFrontmatter(splitFrontmatter(raw).front);
    if (fm.status !== undefined)     fields.status = normalizeStatus(fm.status);
    if (fm.dependencies !== undefined) {
      fields.dependencies = parseDependencies(Array.isArray(fm.dependencies) ? fm.dependencies.join(',') : fm.dependencies);
    }
    for (const [k, to] of [['goal', 'goal'], ['verify', 'verify'], ['verify_expect', 'verifyExpect'],
                           ['source', 'source'], ['title', 'title']]) {
      if (typeof fm[k] === 'string') fields[to] = fm[k].trim();
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const ve = /^Verify-Expect:\s*(.*)$/i.exec(line);
      if (ve) { fields.verifyExpect = ve[1].trim(); continue; }
      const m = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].trim().toLowerCase();
      const val = m[2].trim();
      if (key === 'status')            fields.status = normalizeStatus(val);
      else if (key === 'dependencies') fields.dependencies = parseDependencies(val);
      else if (key === 'goal')         fields.goal = val;
      else if (key === 'verify')       fields.verify = val;
      else if (key === 'source')       fields.source = val;
    }
  }

  const slugMatch = /^T-\d+-(.*)\.md$/.exec(filename);
  const fileSlug = slugMatch ? slugMatch[1] : '';
  const title = fields.title || humanizeSlug(fileSlug);
  return {
    id: taskIdFromFilename(filename),
    file: filename,
    format: v2 ? 2 : 1,
    title,
    slug: fileSlug || slugify(title),
    status: fields.status,
    dependencies: fields.dependencies,
    goal: fields.goal,
    verify: fields.verify,
    verifyExpect: fields.verifyExpect,
    source: fields.source,
    decisions: parseDecisions(raw),
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

/**
 * Scaffold a new project. Returns { projectName, aiDir, tasksDir, inPlace }.
 * `inPlace` (or project === '.') initialises an existing directory; `name`
 * overrides the project name recorded in the state file.
 */
function initProject(project, description, { inPlace: forceInPlace = false, name = '' } = {}) {
  const inPlace = forceInPlace || project === '.';
  if (inPlace ? isProjectDir(project) : fs.existsSync(project)) {
    throw new WorkflowError(inPlace
      ? `'${project}' is already an initialised project.`
      : `'${project}' already exists.`);
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
  fs.writeFileSync(path.join(aiDir, '.gitignore'),          'locks/\nstate.lock\n*.tmp\n',                 'utf8');

  const projectName = name || (inPlace ? path.basename(path.resolve(project)) : project);
  const state = {
    project: projectName,
    phase: 'prototype',
    current_task: null,
    blocked: false,
    completed_tasks: [],
    format_version: FORMAT_VERSION,
  };
  if (description) state.description = description;
  writeState(project, state);

  return { projectName, aiDir, tasksDir: tDir, inPlace };
}

/** Render a task file in format v2: JSON-valued frontmatter + `## Section` body. */
function renderTask({ title = '', goal, source = '', context = '', dependencies = [], subtasks = [],
                      doneCriteria = '', verify = '', verifyExpect = '', nextStep = 'None.' }) {
  const subs = subtasks.length ? subtasks.map((t, i) => `${i + 1}. ${t}`).join('\n') : '';
  const front = [
    `title: ${fmEncode(title || goal)}`,
    'status: pending',
    `goal: ${fmEncode(goal)}`,
    ...(source ? [`source: ${fmEncode(source)}`] : []),
    `dependencies: ${fmEncode(dependencies)}`,
    `verify: ${fmEncode(verify)}`,
    ...(verifyExpect ? [`verify_expect: ${fmEncode(verifyExpect)}`] : []),
  ];
  const section = (name, text) => `## ${name}\n${text ? `\n${text}\n` : ''}`;
  return `---\n${front.join('\n')}\n---\n\n` + [
    section('Context', context),
    section('Subtasks', subs),
    section('Done Criteria', doneCriteria),
    section('Next Step', nextStep),
    section('Blockers', 'None'),
  ].join('\n');
}

const NEXT_STEP_HINT = 'Run `agent-workflow next --all` for the runnable tasks.';
/** Next Step text from the dependency graph: the plan tasks that depend on `id`. */
function dependentsText(resolved, id) {
  const deps = resolved.filter(x => x.depends_on.includes(id)).map(x => x.id);
  return deps.length ? `Unblocks ${deps.join(', ')} (once all their dependencies complete). ${NEXT_STEP_HINT}` : NEXT_STEP_HINT;
}

/**
 * Create the next numbered task file. Returns { taskId, taskPath, setCurrent }.
 * Sets current_task if none is active. `after` may be a string or an array of ids.
 */
function addTask(project, title, {
  description = '', after = '', context = '', subtasks = [], doneCriteria = '', verify = '', source = '',
} = {}) {
  if (!isProjectDir(project)) {
    throw new WorkflowError(`project '${project}' not found.`);
  }

  const n        = nextTaskId(project);
  const taskId   = `T-${String(n).padStart(3, '0')}`;
  const filename = `${taskId}.md`;
  const taskPath = path.join(tasksDir(project), filename);
  const deps     = Array.isArray(after) ? after : (after ? [after] : []);

  fs.writeFileSync(taskPath, renderTask({
    title,
    goal: description || title,
    source, context, subtasks, doneCriteria, verify,
    dependencies: deps,
    nextStep: NEXT_STEP_HINT,
  }), 'utf8');

  const state = readState(project);
  noteTaskId(state, n);
  let setCurrent = false;
  if (!state.current_task) {
    state.current_task = taskId;
    setCurrent = true;
  }
  writeState(project, state);
  return { taskId, taskPath, setCurrent };
}

// ---------------------------------------------------------------------------
// Planning — validate and write a whole task list at once
// ---------------------------------------------------------------------------

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Free-text lines that the line-based task parser would mistake for fields. */
const RESERVED_LINE_RE = /^\s*(status|dependencies|goal|verify|verify-expect|source|evidence)\s*:/im;
const MAX_SUBTASKS = 8;

function checkOneLine(errors, label, v) {
  if (typeof v !== 'string' || /[\r\n]/.test(v)) errors.push(`${label} must be a single-line string`);
}
/** A single-line, compilable regular expression (the `verify_expect` field). */
function checkExpect(errors, label, v) {
  checkOneLine(errors, label, v);
  if (typeof v === 'string' && !/[\r\n]/.test(v)) {
    try { new RegExp(v); } catch (e) { errors.push(`${label} is not a valid regular expression: ${e.message}`); }
  }
}
function checkFreeText(errors, label, v, { legacy = false } = {}) {
  if (typeof v !== 'string') errors.push(`${label} must be a string`);
  else if (RESERVED_HEADING_RE.test(v)) {
    errors.push(`${label} has a line that is a task section heading (## Context, ## Subtasks, ## Done Criteria, ## Next Step, ## Blockers, ## Evidence)`);
  } else if (legacy && RESERVED_LINE_RE.test(v)) {
    errors.push(`${label} has a line starting with a reserved field (Status/Dependencies/Goal/Verify/Source) and this task is still in the legacy format; run \`agent-workflow migrate\``);
  }
}

/**
 * Validate a proposed plan and resolve it to concrete task ids WITHOUT writing
 * anything. Works before `init` (ids start at T-001) and when appending to an
 * existing project. Each spec: { key, title, goal?, context?, depends_on?,
 * subtasks?, done_criteria?, verify?, verify_expect?, source? }; `depends_on` entries are plan
 * keys or existing task ids.
 *
 * Returns { ok, errors, warnings, resolved, waves }. `waves` are parallelisable
 * layers of task ids.
 */
function resolvePlan(project, specs) {
  const errors = [];
  const warnings = [];
  const fail = () => ({ ok: false, errors, warnings, resolved: [], waves: [] });

  if (!Array.isArray(specs) || specs.length === 0) {
    errors.push('tasks must be a non-empty array');
    return fail();
  }

  const exists = isProjectDir(project);
  const existingIds = new Set(exists ? listTasks(project).map(t => t.id) : []);
  const base = exists ? nextTaskId(project) : 1;

  const oneLine = (label, v) => checkOneLine(errors, label, v);
  const freeText = (label, v) => checkFreeText(errors, label, v);

  // --- per-task shape + key → id assignment ---
  const keyToId = new Map();
  specs.forEach((spec, i) => {
    const at = spec && typeof spec.key === 'string' ? `task '${spec.key}'` : `task #${i + 1}`;
    if (!spec || typeof spec !== 'object') { errors.push(`${at} must be an object`); return; }

    if (typeof spec.key !== 'string' || !KEY_RE.test(spec.key)) {
      errors.push(`${at}: key must match ${KEY_RE}`);
    } else if (keyToId.has(spec.key)) {
      errors.push(`${at}: duplicate key`);
    } else {
      const id = `T-${String(base + i).padStart(3, '0')}`;
      if (existingIds.has(id)) errors.push(`${at}: id ${id} already exists in the project`);
      keyToId.set(spec.key, id);
    }

    if (typeof spec.title !== 'string' || !spec.title.trim()) errors.push(`${at}: title is required`);
    else {
      oneLine(`${at}: title`, spec.title);
      if (spec.title.length > 80) errors.push(`${at}: title is longer than 80 characters`);
      if (!slugify(spec.title)) errors.push(`${at}: title needs at least one letter or digit`);
    }
    for (const f of ['goal', 'verify', 'source']) {
      if (spec[f] !== undefined) oneLine(`${at}: ${f}`, spec[f]);
    }
    if (spec.verify_expect !== undefined) checkExpect(errors, `${at}: verify_expect`, spec.verify_expect);
    for (const f of ['context', 'done_criteria']) {
      if (spec[f] !== undefined) freeText(`${at}: ${f}`, spec[f]);
    }
    if (spec.subtasks !== undefined) {
      if (!Array.isArray(spec.subtasks)) errors.push(`${at}: subtasks must be an array`);
      else spec.subtasks.forEach((t, j) => freeText(`${at}: subtasks[${j}]`, t));
    }
    if (spec.depends_on !== undefined && !Array.isArray(spec.depends_on)) {
      errors.push(`${at}: depends_on must be an array`);
    }
  });

  // --- dependencies: plan keys or existing ids ---
  const planDeps = new Map(); // key -> [plan keys]
  const taskDeps = new Map(); // key -> [ids]
  for (const spec of specs) {
    if (!spec || typeof spec.key !== 'string' || !keyToId.has(spec.key)) continue;
    if (planDeps.has(spec.key)) continue; // duplicate key: first definition wins
    const keys = [];
    const ids = [];
    for (const dep of Array.isArray(spec.depends_on) ? spec.depends_on : []) {
      if (dep === spec.key) errors.push(`task '${spec.key}' depends on itself`);
      else if (keyToId.has(dep)) { keys.push(dep); ids.push(keyToId.get(dep)); }
      else if (typeof dep === 'string' && existingIds.has(dep.toUpperCase())) ids.push(dep.toUpperCase());
      else errors.push(`task '${spec.key}' depends on unknown task '${dep}'`);
    }
    planDeps.set(spec.key, keys);
    taskDeps.set(spec.key, ids);
  }

  // --- layering (Kahn) doubles as cycle detection ---
  const waves = [];
  const placed = new Set();
  let remaining = [...planDeps.keys()];
  while (remaining.length) {
    const layer = remaining.filter(k => planDeps.get(k).every(d => placed.has(d)));
    if (!layer.length) {
      errors.push(`dependency cycle among: ${remaining.join(', ')}`);
      break;
    }
    layer.forEach(k => placed.add(k));
    waves.push(layer.map(k => keyToId.get(k)));
    remaining = remaining.filter(k => !placed.has(k));
  }

  // --- warnings ---
  for (const spec of specs) {
    if (!spec || typeof spec.key !== 'string') continue;
    if (!spec.verify) warnings.push(`task '${spec.key}' has no verify command`);
    if (spec.verify_expect && !spec.verify) warnings.push(`task '${spec.key}' has verify_expect but no verify command`);
    if (Array.isArray(spec.subtasks) && spec.subtasks.length > MAX_SUBTASKS) {
      warnings.push(`task '${spec.key}' is large: ${spec.subtasks.length} subtasks`);
    }
  }

  if (errors.length) return fail();
  const resolved = specs.map(spec => ({
    key: spec.key,
    id: keyToId.get(spec.key),
    title: spec.title,
    depends_on: taskDeps.get(spec.key),
    verify: spec.verify || '',
    verify_expect: spec.verify_expect || '',
  }));
  return { ok: true, errors, warnings, resolved, waves };
}

/**
 * Write a whole plan: validates first, then creates every task file or none.
 * Returns { created: [{ key, id, file, verify }], currentTask }.
 */
function addTasks(project, specs) {
  requireProjectDir(project);
  const plan = resolvePlan(project, specs);
  if (!plan.ok) {
    throw new WorkflowError(`plan is invalid:\n${plan.errors.map(e => `  - ${e}`).join('\n')}`);
  }

  const files = plan.resolved.map((r, i) => {
    const spec = specs[i];
    const file = `${r.id}.md`;
    return {
      r, file,
      full: path.join(tasksDir(project), file),
      content: renderTask({
        title: spec.title,
        goal: spec.goal || spec.title,
        source: spec.source || '',
        context: spec.context || '',
        dependencies: r.depends_on,
        subtasks: spec.subtasks || [],
        doneCriteria: spec.done_criteria || '',
        verify: spec.verify || '',
        verifyExpect: spec.verify_expect || '',
        nextStep: dependentsText(plan.resolved, r.id),
      }),
    };
  });

  const clash = files.find(f => fs.existsSync(f.full));
  if (clash) throw new WorkflowError(`${clash.file} already exists. Nothing was written.`);

  fs.mkdirSync(tasksDir(project), { recursive: true });
  const written = [];
  try {
    for (const f of files) {
      fs.writeFileSync(f.full, f.content, { flag: 'wx', encoding: 'utf8' });
      written.push(f.full);
    }
  } catch (err) {
    for (const p of written) { try { fs.unlinkSync(p); } catch { /* best effort */ } }
    throw err;
  }

  const state = readState(project);
  noteTaskId(state, Math.max(...plan.resolved.map(r => parseInt(r.id.slice(2), 10))));
  let currentTask = state.current_task || null;
  if (!currentTask) {
    currentTask = plan.waves[0][0];
    state.current_task = currentTask;
  }
  writeState(project, state);
  return {
    created: files.map(f => ({ key: f.r.key, id: f.r.id, file: f.file, verify: f.r.verify })),
    currentTask,
  };
}

// ---------------------------------------------------------------------------
// Re-planning — edit or remove tasks that haven't started
// ---------------------------------------------------------------------------

const HEADERS = ['Status', 'Goal', 'Source', 'Context', 'Dependencies', 'Subtasks',
                 'Done Criteria', 'Decisions', 'Verification', 'Verify', 'Verify-Expect', 'Evidence', 'Next Step', 'Blockers'];
const HEADER_RE = new RegExp(`^(${HEADERS.join('|')}):`, 'i');
const headerRe = name => new RegExp(`^${name}:`, 'i');

/** v1: replace (or insert) a single-line `Header: value` field. */
function setLineField(raw, header, value) {
  const lines = raw.split(/\r?\n/);
  const i = lines.findIndex(l => headerRe(header).test(l));
  if (i >= 0) lines[i] = `${header}: ${value}`;
  else {
    const g = lines.findIndex(l => headerRe('Goal').test(l));
    lines.splice(g >= 0 ? g + 1 : lines.length, 0, ...(g >= 0 ? ['', `${header}: ${value}`] : [`${header}: ${value}`]));
  }
  return lines.join('\n');
}

/** v1: replace (or append) a block section — everything up to the next known header. */
function setLegacySection(raw, header, body) {
  const lines = raw.split(/\r?\n/);
  const i = lines.findIndex(l => headerRe(header).test(l));
  const block = [`${header}:`, ...(body ? body.split(/\r?\n/) : []), ''];
  if (i < 0) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return [...lines, '', ...block].join('\n') + (raw.endsWith('\n') ? '' : '\n');
  }
  let end = i + 1;
  while (end < lines.length && !HEADER_RE.test(lines[end])) end++;
  lines.splice(i, end - i, ...block);
  return lines.join('\n');
}

const LEGACY_FIELD = { status: 'Status', goal: 'Goal', source: 'Source', verify: 'Verify',
                       verify_expect: 'Verify-Expect', dependencies: 'Dependencies' };

/**
 * Set a one-line field (status, goal, source, verify, verify_expect,
 * dependencies [array], title) in either format. Empty optional fields are
 * removed from v2 frontmatter instead of being written blank.
 */
function setField(raw, key, value) {
  if (!hasFrontmatter(raw)) {
    if (key === 'title') return raw; // v1 keeps its title in the filename
    const v = key === 'dependencies' ? (value.length ? value.join(', ') : 'none') : value;
    if (key === 'status' && !/^Status:/im.test(raw)) return `Status: ${v}\n\n` + raw;
    return setLineField(raw, LEGACY_FIELD[key], v);
  }
  const { front, body } = splitFrontmatter(raw);
  const lineKey = FM_KEYS[key];
  const optional = key === 'source' || key === 'verify_expect';
  const i = front.findIndex(l => l.startsWith(`${lineKey}:`));
  const text = `${lineKey}: ${key === 'status' ? value : fmEncode(value)}`;
  if (i >= 0) { if (optional && !value) front.splice(i, 1); else front[i] = text; }
  else if (!(optional && !value)) front.push(text);
  return `---\n${front.join('\n')}\n---\n${body}`;
}

/** Replace (or append) a named body section in either format. */
function setSection(raw, header, body) {
  if (!hasFrontmatter(raw)) return setLegacySection(raw, header, body);
  const lines = raw.split(/\r?\n/);
  const want = header.toLowerCase();
  const isHead = l => { const m = SECTION_RE.exec(l); return m && m[1].toLowerCase() === want; };
  const i = lines.findIndex(isHead);
  const block = [`## ${header}`, ...(body ? ['', ...body.split(/\r?\n/)] : []), ''];
  if (i < 0) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return [...lines, '', ...block].join('\n');
  }
  let end = i + 1;
  while (end < lines.length && !SECTION_RE.test(lines[end])) end++;
  lines.splice(i, end - i, ...block);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Decisions — choices made while working a task, kept with the task
// ---------------------------------------------------------------------------

const MAX_DECISION_LEN = 500;
const MAX_DECISIONS_PER_CALL = 20;

/** Body lines of a named section in either format ([] when absent). */
function getSection(raw, name) {
  const lines = raw.split(/\r?\n/);
  const want = name.toLowerCase();
  if (hasFrontmatter(raw)) {
    const i = lines.findIndex(l => { const m = SECTION_RE.exec(l); return m && m[1].toLowerCase() === want; });
    if (i < 0) return [];
    let end = i + 1;
    while (end < lines.length && !SECTION_RE.test(lines[end])) end++;
    return lines.slice(i + 1, end);
  }
  const i = lines.findIndex(l => headerRe(name).test(l));
  if (i < 0) return [];
  let end = i + 1;
  while (end < lines.length && !HEADER_RE.test(lines[end])) end++;
  return lines.slice(i + 1, end);
}

/** The recorded decisions of a task file: the `- ` bullets of its Decisions section. */
function parseDecisions(raw) {
  return getSection(raw, 'Decisions')
    .map(l => /^\s*[-*]\s+(.*\S)\s*$/.exec(l))
    .filter(Boolean)
    .map(m => m[1]);
}

/** Validate and clean a list of decision strings; throws WorkflowError on bad input. */
function normalizeDecisions(list) {
  if (list === undefined || list === null) return [];
  const items = Array.isArray(list) ? list : [list];
  if (items.length > MAX_DECISIONS_PER_CALL) {
    throw new WorkflowError(`at most ${MAX_DECISIONS_PER_CALL} decisions per call.`);
  }
  return items.map((d, i) => {
    if (typeof d !== 'string' || !d.trim()) throw new WorkflowError(`decision #${i + 1} must be a non-empty string.`);
    if (/[\r\n]/.test(d)) throw new WorkflowError(`decision #${i + 1} must be a single line.`);
    if (d.trim().length > MAX_DECISION_LEN) throw new WorkflowError(`decision #${i + 1} is longer than ${MAX_DECISION_LEN} characters.`);
    return d.trim();
  });
}

/** Append decisions to a task file's text (existing ones are kept, duplicates skipped). */
function withDecisions(raw, decisions) {
  const have = parseDecisions(raw);
  const add = decisions.filter(d => !have.includes(d));
  if (!add.length) return raw;
  return setSection(raw, 'Decisions', [...have, ...add].map(d => `- ${d}`).join('\n'));
}

/**
 * Record decisions on a task (any status). Returns { taskId, decisions } with
 * every decision now on the task.
 */
function recordDecisions(project, taskId, decisions) {
  requireProjectDir(project);
  const items = normalizeDecisions(decisions);
  if (!items.length) throw new WorkflowError('no decision given.');
  const task = findTask(project, taskId);
  fs.writeFileSync(path.join(tasksDir(project), task.file), withDecisions(task.raw, items), 'utf8');
  return { taskId: task.id, decisions: findTask(project, taskId).decisions };
}

/** Every recorded decision in the project, in task order: [{ task, title, text }]. */
function listDecisions(project) {
  requireProjectDir(project);
  return listTasks(project).flatMap(t => t.decisions.map(text => ({ task: t.id, title: t.title, text })));
}

// ---------------------------------------------------------------------------
// Migration — format v1 (loose `Key: value` lines) → v2 (frontmatter + sections)
// ---------------------------------------------------------------------------

const LEGACY_ONE_LINE = ['status', 'goal', 'source', 'dependencies', 'verify', 'verify-expect'];

/** Convert one parsed v1 task to v2 text. Lines that fit no section go to `## Notes`. */
function legacyToV2(task) {
  const sections = new Map(); // lower-case name -> lines
  const notes = [];
  const seenOneLine = new Map(); // one-line field -> its latest line
  let current = null; // { key, oneLine }
  for (const line of task.raw.split(/\r?\n/)) {
    const m = HEADER_RE.exec(line);
    if (m) {
      const key = m[1].toLowerCase();
      const inline = line.slice(m[0].length).trim();
      const oneLine = LEGACY_ONE_LINE.includes(key);
      current = { key, oneLine };
      if (oneLine) {
        // The v1 parser keeps the LAST occurrence of a field; earlier ones were prose or stale, so keep them as notes.
        if (seenOneLine.has(key)) notes.push(seenOneLine.get(key));
        seenOneLine.set(key, line);
      } else {
        sections.set(key, inline ? [inline] : []);
      }
      continue;
    }
    if (!current) { if (line.trim()) notes.push(line); continue; }
    if (current.oneLine) { if (line.trim()) notes.push(line); continue; }
    sections.get(current.key).push(line);
  }

  const trim = lines => {
    const l = [...lines];
    while (l.length && !l[0].trim()) l.shift();
    while (l.length && !l[l.length - 1].trim()) l.pop();
    return l.join('\n');
  };
  const out = [];
  for (const name of SECTION_NAMES) {
    const body = sections.has(name.toLowerCase()) ? trim(sections.get(name.toLowerCase())) : null;
    if (body === null) continue;
    if (name === 'Verification' && !body) continue; // empty placeholder heading
    out.push(`## ${name}\n${body ? `\n${body}\n` : ''}`);
  }
  if (notes.length) out.push(`## Notes\n\n${trim(notes)}\n`);

  const front = [
    `title: ${fmEncode(task.title)}`,
    `status: ${task.status}`,
    `goal: ${fmEncode(task.goal || task.title)}`,
    ...(task.source ? [`source: ${fmEncode(task.source)}`] : []),
    `dependencies: ${fmEncode(task.dependencies)}`,
    `verify: ${fmEncode(task.verify)}`,
    ...(task.verifyExpect ? [`verify_expect: ${fmEncode(task.verifyExpect)}`] : []),
  ];
  return `---\n${front.join('\n')}\n---\n\n${out.join('\n')}`;
}

/**
 * Convert every v1 task file to format v2 (id-only filenames, frontmatter,
 * `## Section` bodies) and stamp the state with format_version. Each converted
 * file is re-parsed and compared with the original before anything is written,
 * so a conversion that would change a field aborts the whole migration.
 * `dryRun` reports what would change and writes nothing.
 */
function migrateProject(project, { dryRun = false } = {}) {
  requireProjectDir(project);
  return withStateLock(project, () => {
    const migrated = [];
    const skipped = [];
    const plan = [];
    for (const t of listTasks(project)) {
      if (t.format === 2) { skipped.push(t.id); continue; }
      const to = `${t.id}.md`;
      const text = legacyToV2(t);
      const back = parseTaskText(text, to);
      for (const f of ['status', 'goal', 'verify', 'verifyExpect', 'source']) {
        const want = f === 'goal' ? (t.goal || t.title) : t[f];
        if (back[f] !== want) throw new WorkflowError(`migration would change ${f} of ${t.id}; nothing was written.`);
      }
      if (back.dependencies.join() !== t.dependencies.join()) {
        throw new WorkflowError(`migration would change dependencies of ${t.id}; nothing was written.`);
      }
      plan.push({ t, to, text });
      migrated.push({ id: t.id, from: t.file, to });
    }
    if (!dryRun) {
      for (const { t, to, text } of plan) {
        writeFileAtomic(path.join(tasksDir(project), to), text);
        if (t.file !== to) fs.unlinkSync(path.join(tasksDir(project), t.file));
      }
      const state = readState(project);
      state.format_version = FORMAT_VERSION;
      writeState(project, state);
      const tpl = path.join(project, '.ai', 'TASK_TEMPLATE.md');
      if (fs.existsSync(tpl)) fs.writeFileSync(tpl, templates.TASK_TEMPLATE, 'utf8');
    }
    return { migrated, skipped, dryRun };
  });
}

/** Throws unless the task can still be re-planned: pending and unclaimed. */
function assertEditable(project, task) {
  if (task.status !== 'pending') {
    throw new WorkflowError(
      `${task.id} is ${task.status}; only pending tasks can be changed` +
      `${task.status === 'blocked' ? ' (unblock it first)' : ''}.`);
  }
  if (listLocks(project).includes(task.id)) {
    throw new WorkflowError(`${task.id} is claimed by an agent; release it first.`);
  }
}

/**
 * Edit a pending task in place. `patch` fields: title (renames the file), goal,
 * context, depends_on (task ids), subtasks, done_criteria, verify, verify_expect, source.
 * Hand-written content outside the patched fields is left untouched.
 */
function updateTask(project, taskId, patch = {}, { agent = '' } = {}) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  if (task.status === 'in-progress') {
    // A started task may be re-scoped, but only by the agent that claimed it.
    const held = readLock(project, task.id);
    if (held && held.agent !== agent) {
      throw new WorkflowError(
        `${task.id} is in progress, claimed by '${held.agent}'; only that agent can update it` +
        `${agent ? ` (you passed '${agent}')` : ' (pass agent)'}.`);
    }
    const structural = Object.keys(patch).filter(k => k === 'title' || k === 'depends_on');
    if (structural.length) {
      throw new WorkflowError(`${task.id} is in progress; ${structural.join(', ')} can only change while pending (reset it first).`);
    }
  } else {
    assertEditable(project, task);
  }

  const known = ['title', 'goal', 'context', 'depends_on', 'subtasks', 'done_criteria', 'verify', 'verify_expect', 'source'];
  const unknown = Object.keys(patch).filter(k => !known.includes(k));
  if (unknown.length) throw new WorkflowError(`unknown field(s): ${unknown.join(', ')}.`);
  if (!Object.keys(patch).length) throw new WorkflowError('nothing to update.');

  const errors = [];
  for (const f of ['title', 'goal', 'verify', 'source']) {
    if (patch[f] !== undefined) checkOneLine(errors, f, patch[f]);
  }
  if (patch.verify_expect !== undefined) checkExpect(errors, 'verify_expect', patch.verify_expect);
  if (patch.title !== undefined && typeof patch.title === 'string') {
    if (!patch.title.trim() || !slugify(patch.title)) errors.push('title needs at least one letter or digit');
    if (patch.title.length > 80) errors.push('title is longer than 80 characters');
  }
  const legacy = { legacy: task.format === 1 };
  for (const f of ['context', 'done_criteria']) {
    if (patch[f] !== undefined) checkFreeText(errors, f, patch[f], legacy);
  }
  if (patch.subtasks !== undefined) {
    if (!Array.isArray(patch.subtasks)) errors.push('subtasks must be an array');
    else patch.subtasks.forEach((t, i) => checkFreeText(errors, `subtasks[${i}]`, t, legacy));
  }

  let deps = null;
  if (patch.depends_on !== undefined) {
    if (!Array.isArray(patch.depends_on)) errors.push('depends_on must be an array');
    else {
      const tasks = listTasks(project);
      const byId = new Map(tasks.map(t => [t.id, t]));
      deps = patch.depends_on.map(d => String(d).toUpperCase());
      for (const d of deps) {
        if (d === task.id) errors.push(`${task.id} cannot depend on itself`);
        else if (!byId.has(d)) errors.push(`depends_on references unknown task '${d}'`);
      }
      // A cycle exists if the task is reachable from any of its new dependencies.
      const seen = new Set();
      const reaches = id => {
        if (id === task.id) return true;
        if (seen.has(id) || !byId.has(id)) return false;
        seen.add(id);
        return byId.get(id).dependencies.some(reaches);
      };
      if (!errors.length && deps.some(reaches)) errors.push(`depends_on would create a dependency cycle through ${task.id}`);
    }
  }
  if (errors.length) throw new WorkflowError(`invalid update:\n${errors.map(e => `  - ${e}`).join('\n')}`);

  let raw = task.raw;
  if (patch.title !== undefined)         raw = setField(raw, 'title', patch.title);
  if (patch.goal !== undefined)          raw = setField(raw, 'goal', patch.goal);
  if (patch.source !== undefined)        raw = setField(raw, 'source', patch.source);
  if (patch.verify !== undefined)        raw = setField(raw, 'verify', patch.verify);
  if (patch.verify_expect !== undefined) raw = setField(raw, 'verify_expect', patch.verify_expect);
  if (deps)                              raw = setField(raw, 'dependencies', deps);
  if (patch.context !== undefined)       raw = setSection(raw, 'Context', patch.context);
  if (patch.done_criteria !== undefined) raw = setSection(raw, 'Done Criteria', patch.done_criteria);
  if (patch.subtasks !== undefined) {
    raw = setSection(raw, 'Subtasks', patch.subtasks.map((t, i) => `${i + 1}. ${t}`).join('\n'));
  }

  let file = task.file;
  // v2 files are named by id alone, so a new title never renames them; v1 keeps its slug in the name.
  if (patch.title !== undefined && task.format === 1) file = `${task.id}-${slugify(patch.title)}.md`;
  const target = path.join(tasksDir(project), file);
  if (file !== task.file && fs.existsSync(target)) throw new WorkflowError(`${file} already exists.`);

  fs.writeFileSync(path.join(tasksDir(project), task.file), raw, 'utf8');
  if (file !== task.file) fs.renameSync(path.join(tasksDir(project), task.file), target);
  return { taskId: task.id, file };
}

/**
 * Delete a pending task. Refuses while other tasks depend on it (update or
 * remove those first). Its id is retired: never reused, never renumbered.
 */
function removeTask(project, taskId) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  assertEditable(project, task);

  const dependents = listTasks(project).filter(t => t.dependencies.includes(task.id)).map(t => t.id);
  if (dependents.length) {
    throw new WorkflowError(`${task.id} is a dependency of ${dependents.join(', ')}; update or remove those first.`);
  }

  fs.unlinkSync(path.join(tasksDir(project), task.file));
  const state = readState(project);
  noteTaskId(state, Math.max(parseInt(task.id.slice(2), 10), nextTaskId(project) - 1)); // retire the id
  if (state.current_task === task.id) {
    state.current_task = selectNextTask(project, state);
  }
  writeState(project, state);
  return { taskId: task.id, removed: true, currentTask: state.current_task };
}

const MAX_BRIEF_BYTES = 200 * 1024;

/**
 * Store the source brief at docs/brief.md. `content` is text (never a path or
 * URL); `source` is an opaque, single-line origin reference.
 */
function setBrief(project, content, { source = '', mode = 'replace' } = {}) {
  requireProjectDir(project);
  if (typeof content !== 'string' || !content.trim()) throw new WorkflowError('brief content is empty.');
  if (Buffer.byteLength(content) > MAX_BRIEF_BYTES) {
    throw new WorkflowError(`brief is larger than ${MAX_BRIEF_BYTES / 1024} KB.`);
  }
  if (/[\r\n]/.test(source)) throw new WorkflowError('source must be a single line.');
  if (mode !== 'replace' && mode !== 'append') throw new WorkflowError("mode must be 'replace' or 'append'.");

  const dir = path.join(project, 'docs');
  const file = path.join(dir, 'brief.md');
  fs.mkdirSync(dir, { recursive: true });

  const section = `${source ? `> Source: ${source}\n\n` : ''}${content.trimEnd()}\n`;
  const body = mode === 'append' && fs.existsSync(file)
    ? `${fs.readFileSync(file, 'utf8').trimEnd()}\n\n---\n\n${section}`
    : section;
  fs.writeFileSync(file, body, 'utf8');
  return { path: path.join('docs', 'brief.md'), bytes: Buffer.byteLength(body) };
}

/** A compact status row for one project. */
function projectSummary(projectPath) {
  const state = readState(projectPath);
  return {
    name: projectPath === '.' ? state.project : projectPath,
    phase: state.phase || '?',
    current: deriveCurrentTask(projectPath, state) || '-',
    completed: (state.completed_tasks || []).length,
    total: countTasks(projectPath),
    blocked: !!state.blocked,
    deferred: listTasks(projectPath).filter(t => t.status === 'deferred').map(t => t.id),
    decisions: listDecisions(projectPath).length,
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

const STATUSES = ['pending', 'in-progress', 'completed', 'blocked', 'deferred'];

/** Legal transitions: from-status -> set of allowed to-statuses. */
const TRANSITIONS = {
  'pending':     new Set(['in-progress', 'blocked', 'deferred']),
  'in-progress': new Set(['completed', 'blocked', 'pending']),
  'blocked':     new Set(['pending', 'in-progress', 'deferred']),
  'completed':   new Set(),
  'deferred':    new Set(['pending']),
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from] || !TRANSITIONS[from].has(to)) {
    throw new WorkflowError(
      `illegal transition ${from} → ${to}. ` +
      `Allowed from ${from}: ${[...(TRANSITIONS[from] || [])].join(', ') || '(none — terminal)'}.`
    );
  }
}

/** Rewrite the status of a task file in place. */
function setTaskStatus(projectDir, task, status) {
  const full = path.join(tasksDir(projectDir), task.file);
  fs.writeFileSync(full, setField(task.raw, 'status', status), 'utf8');
}

/** True when any task file is currently blocked. */
function anyBlocked(projectDir) {
  return listTasks(projectDir).some(t => t.status === 'blocked');
}

/**
 * The next runnable task in id order (pending, deps completed, unclaimed).
 * Returns a task id or null. Used when completing the current task.
 */
function selectNextTask(projectDir, state, preferUnblockedBy = null) {
  if (preferUnblockedBy) {
    const hit = runnableTasks(projectDir, state).find(t => t.dependencies.includes(preferUnblockedBy));
    if (hit) return hit.id;
  }
  const runnable = runnableTasks(projectDir, state);
  return runnable.length ? runnable[0].id : null;
}

/**
 * The graph-derived current task: the recorded one if still in progress, else any
 * in-progress task, else the recorded one if still runnable, else the first runnable
 * task, else null. Never returns a task that is neither in progress nor runnable.
 */
function deriveCurrentTask(project, state) {
  const tasks = listTasks(project);
  const inProg = tasks.filter(t => t.status === 'in-progress').map(t => t.id);
  const cur = state.current_task;
  if (cur && inProg.includes(cur)) return cur;
  if (inProg.length) return inProg[0];
  const runnable = runnableTasks(project, state).map(t => t.id);
  if (cur && runnable.includes(cur)) return cur;
  return runnable[0] || null;
}

function addUnique(arr, id) {
  const a = arr || [];
  return a.includes(id) ? a : [...a, id];
}
function removeId(arr, id) {
  return (arr || []).filter(x => x !== id);
}

/** pending → in-progress. Atomically claims the task first. */
function startTaskLocked(project, taskId, { agent = 'agent' } = {}) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  if (task.status === 'completed') {
    throw new WorkflowError(`${task.id} is already completed. Use next_tasks / \`agent-workflow next\` to find runnable work.`);
  }
  if (task.status === 'in-progress') {
    const held = readLock(project, task.id);
    if (held) throw new WorkflowError(`${task.id} is already in progress, claimed by '${held.agent}'.`);
  }
  assertTransition(task.status, 'in-progress');

  acquireLock(project, task.id, agent); // throws if another agent holds it
  try {
    const state = readState(project);
    setTaskStatus(project, task, 'in-progress');
    state.in_progress = addUnique(state.in_progress, task.id);
    state.current_task = deriveCurrentTask(project, state);
    writeState(project, state);
  } catch (err) {
    releaseLock(project, task.id); // don't leave an orphaned claim behind
    throw err;
  }
  return { taskId: task.id, status: 'in-progress' };
}

const VERIFY_TIMEOUT_MS = Number(process.env.AFW_VERIFY_TIMEOUT_MS) || 10 * 60 * 1000;
const EVIDENCE_TAIL_LINES = 40;
const EVIDENCE_TAIL_CHARS = 4000;

/** Run one shell command, always capturing output (bounded by a timeout). */
function runCommand(command, cwd, { inherit = false } = {}) {
  const res = spawnSync(command, {
    cwd, shell: true, encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    timeout: VERIFY_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  if (inherit) { // the CLI shows the output; it was captured so it can be matched and recorded
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
  const timedOut = !!(res.error && res.error.code === 'ETIMEDOUT');
  const code = res.status === null || res.status === undefined ? 1 : res.status;
  return { code, stdout, stderr, timedOut };
}

/** Does `output` satisfy a `Verify-Expect:` regex? An empty expectation always matches. */
function matchesExpect(expect, output) {
  if (!expect) return true;
  try { return new RegExp(expect, 'm').test(output); } catch { return false; }
}

/** Run a command and apply its optional expectation → a verification record. */
function runCheck(command, expect, cwd, inherit) {
  const r = runCommand(command, cwd, { inherit });
  const expectMatched = r.code !== 0 ? null : matchesExpect(expect, `${r.stdout}\n${r.stderr}`);
  return {
    ran: true,
    ok: r.code === 0 && expectMatched !== false,
    command,
    code: r.code,
    expect: expect || '',
    expectMatched,
    timedOut: r.timedOut,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

function failureReason(label, id, v) {
  if (v.timedOut) return `${label} timed out for ${id} after ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s. Not completed.`;
  if (v.code === 0) return `${label} failed for ${id}: passed (exit 0) but its output did not match Verify-Expect /${v.expect}/. Not completed.`;
  return `${label} failed for ${id} (exit ${v.code}). Not completed.`;
}

/**
 * Run a task's `Verify:` command in the project dir (or, with `workdir`, in the
 * matching directory of a registered git worktree). Returns
 * { ran, ok, command, code, expectMatched?, stdout, stderr }. A task with a
 * `Verify-Expect:` regex only passes when the output also matches it. `inherit`
 * echoes the captured output to this process (used by the CLI).
 */
function verifyTask(project, taskId, { inherit = false, workdir = '' } = {}) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  const command = task.verify;
  if (!command) return { ran: false, ok: false, command: '', code: null };
  return runCheck(command, task.verifyExpect, workdir ? resolveWorkdir(project, workdir) : project, inherit);
}

/** Set (or, with an empty string, clear) the project-wide verify command. */
function setProjectVerify(project, command = '') {
  requireProjectDir(project);
  if (typeof command !== 'string' || /[\r\n]/.test(command)) {
    throw new WorkflowError('project verify command must be a single-line string.');
  }
  const state = readState(project);
  const c = command.trim();
  if (c) state.project_verify = c; else delete state.project_verify;
  writeState(project, state);
  return { projectVerify: c };
}

/** Run the project-wide verify command (if configured). */
function verifyProject(project, { inherit = false, workdir = '' } = {}) {
  requireProjectDir(project);
  const command = String(readState(project).project_verify || '').trim();
  if (!command) return { ran: false, ok: false, command: '', code: null };
  return runCheck(command, '', workdir ? resolveWorkdir(project, workdir) : project, inherit);
}

/** HEAD commit of the git checkout containing `dir`, or '' outside a repo. */
function gitHead(dir) {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() : '';
  } catch { return ''; }
}

/** Bounded tail of a check's combined output, indented so the task parser ignores it. */
function outputTail(v) {
  const sep = v.stdout && v.stderr && !v.stdout.endsWith('\n') ? '\n' : '';
  const text = `${v.stdout || ''}${sep}${v.stderr || ''}`
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').trimEnd();
  let lines = text ? text.split('\n') : [];
  if (lines.length > EVIDENCE_TAIL_LINES) lines = ['...', ...lines.slice(-EVIDENCE_TAIL_LINES)];
  let out = lines.join('\n');
  if (out.length > EVIDENCE_TAIL_CHARS) out = '...' + out.slice(-EVIDENCE_TAIL_CHARS);
  return out ? out.split('\n').map(l => `      | ${l}`.trimEnd()) : [];
}

/** Body of the task file's `Evidence:` section. Every line is indented. */
function renderEvidence(checks, commit, at) {
  const lines = [`  - recorded: ${at}`];
  if (commit) lines.push(`  - commit: ${commit}`);
  for (const { label, v } of checks) {
    lines.push(`  - ${label}: \`${v.command}\` exit ${v.code}${v.expect ? `, matched /${v.expect}/` : ''}`);
    lines.push(...outputTail(v));
  }
  return lines.join('\n');
}

/**
 * in-progress → completed. Runs the task's Verify command AND the project-wide
 * `project_verify` command (when configured) and refuses to complete if either
 * fails. `force` skips all verification; `noVerify` completes a task that has no
 * Verify command of its own (skips the task check) but the project check still
 * runs. On success the commands, an output tail, exit codes, timestamp and git
 * commit are recorded in the task file's `Evidence:` section. Advances
 * current_task to the next runnable task.
 */
function completeTask(project, taskId, { force = false, noVerify = false, inherit = false, workdir = '', decisions = [] } = {}) {
  requireProjectDir(project);
  const decided = normalizeDecisions(decisions); // fail before running a slow verify
  const task = findTask(project, taskId);
  assertTransition(task.status, 'completed');

  let verified = false;
  const checks = [];
  if (!force) {
    if (!noVerify) {
      if (!task.verify) {
        throw new WorkflowError(
          `${task.id} has no Verify command. Add a \`Verify:\` line to the task, ` +
          `or pass --no-verify (accept without a check) or --force.`);
      }
      const v = verifyTask(project, task.id, { inherit, workdir });
      if (!v.ok) throw new WorkflowError(failureReason('verification', task.id, v), v.code || 1);
      checks.push({ label: 'task verify', v });
      verified = true;
    }
    const pv = verifyProject(project, { inherit, workdir });
    if (pv.ran) {
      if (!pv.ok) throw new WorkflowError(failureReason('project verification', task.id, pv), pv.code || 1);
      checks.push({ label: 'project verify', v: pv });
    }
  }
  const commit = checks.length ? gitHead(workdir ? resolveWorkdir(project, workdir) : project) : '';

  // Verification can be slow, so the lock is taken only for the write phase.
  return withStateLock(project, () => {
    const fresh = findTask(project, taskId);
    assertTransition(fresh.status, 'completed'); // state may have moved during verify
    const state = readState(project);
    setTaskStatus(project, fresh, 'completed');
    if (checks.length) {
      const full = path.join(tasksDir(project), fresh.file);
      const raw = setSection(fs.readFileSync(full, 'utf8'), 'Evidence', renderEvidence(checks, commit, new Date().toISOString()));
      fs.writeFileSync(full, raw, 'utf8');
    }
    if (decided.length) {
      const full = path.join(tasksDir(project), fresh.file);
      fs.writeFileSync(full, withDecisions(fs.readFileSync(full, 'utf8'), decided), 'utf8');
    }
    releaseLock(project, fresh.id);
    state.completed_tasks = addUnique(state.completed_tasks, fresh.id);
    state.in_progress = removeId(state.in_progress, fresh.id);
    if (!verified) state.unverified = addUnique(state.unverified, fresh.id);

    // Graph-derived: prefer a task this completion just unblocked, else any runnable one.
    const nextTask = selectNextTask(project, state, fresh.id);
    state.current_task = deriveCurrentTask(project, state);
    writeState(project, state);
    return { taskId: fresh.id, status: 'completed', nextTask, verified, evidence: checks.length > 0 };
  });
}

const MAX_BATCH = 25;

/**
 * Run `fn(id)` for each id in order, stopping at the first WorkflowError so later
 * tasks (which may depend on it) are not touched. Returns
 * { ok, results: [{ id, ok, ...result | error }], failed, skipped }.
 */
function runBatch(ids, fn) {
  if (!Array.isArray(ids) || !ids.length) throw new WorkflowError('ids must be a non-empty array of task ids.');
  if (ids.length > MAX_BATCH) throw new WorkflowError(`at most ${MAX_BATCH} tasks per call.`);
  if (new Set(ids.map(i => String(i).toUpperCase())).size !== ids.length) throw new WorkflowError('ids must not repeat.');
  const results = [];
  let failed = null;
  for (const raw of ids) {
    const id = String(raw).toUpperCase();
    try {
      results.push({ id, ok: true, ...fn(id) });
    } catch (err) {
      if (!(err instanceof WorkflowError)) throw err;
      failed = { id, error: err.message };
      results.push({ id, ok: false, error: err.message });
      break;
    }
  }
  return { ok: !failed, results, failed, skipped: ids.slice(results.length).map(i => String(i).toUpperCase()) };
}

/** Start several tasks in order (see runBatch). `opts` apply to every task. */
function startTasks(project, ids, opts = {}) {
  requireProjectDir(project);
  return runBatch(ids, id => startTask(project, id, opts));
}

/** Complete several tasks in order, each fully verified (see runBatch). `opts` apply to every task. */
function completeTasks(project, ids, opts = {}) {
  requireProjectDir(project);
  const { decisions, ...rest } = opts; // decisions are per task: use complete_task for those
  if (decisions && decisions.length) throw new WorkflowError('decisions are per task: use complete_task, or record_decision afterwards.');
  return runBatch(ids, id => completeTask(project, id, rest));
}

/**
 * Start a task, then run its Verify once ("red first"): if it ALREADY passes the
 * check may be vacuous, so `warning` is returned. Never blocks. Runs after the
 * state lock is released, and costs nothing when the task has no Verify.
 * Pass `redFirst: false` to skip it.
 */
function startTask(project, taskId, { redFirst = true, workdir = '', ...opts } = {}) {
  const r = withStateLock(project, () => startTaskLocked(project, taskId, opts));
  if (redFirst) {
    let v = null;
    try { v = verifyTask(project, r.taskId, { workdir }); } catch { /* red-first is advisory only */ }
    if (v && v.ran && v.ok) {
      r.warning = `${r.taskId}'s Verify already passes before any work was done; the check may be vacuous. ` +
        'Make it fail first (or tighten it / add Verify-Expect).';
    }
  }
  return r;
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

/**
 * pending|blocked → deferred: the task is backlog, kept on record but out of the
 * way (never runnable, never blocks finalize). The reason is stored on a
 * `Deferred:` line in the task's Blockers section.
 */
function deferTask(project, taskId, { reason = '' } = {}) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  assertTransition(task.status, 'deferred');
  if (/[\r\n]/.test(reason)) throw new WorkflowError('reason must be a single line.');

  const state = readState(project);
  const body = `Deferred: ${reason.trim() || '(no reason given)'}`;
  fs.writeFileSync(path.join(tasksDir(project), task.file), setSection(task.raw, 'Blockers', body), 'utf8');
  setTaskStatus(project, findTask(project, task.id), 'deferred');
  releaseLock(project, task.id);
  state.in_progress = removeId(state.in_progress, task.id);
  if (!anyBlocked(project)) {
    state.blocked = false;
    delete state.block_reason;
    delete state.unblock_strategy;
  }
  if (state.current_task === task.id) state.current_task = selectNextTask(project, state);
  writeState(project, state);
  return { taskId: task.id, status: 'deferred' };
}

/** deferred → pending. Clears the Deferred reason from the Blockers section. */
function reopenTask(project, taskId) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  assertTransition(task.status, 'pending');

  if (/^Deferred:/m.test(task.raw)) {
    fs.writeFileSync(path.join(tasksDir(project), task.file), setSection(task.raw, 'Blockers', 'None'), 'utf8');
  }
  setTaskStatus(project, findTask(project, task.id), 'pending');
  const state = readState(project);
  if (!state.current_task) state.current_task = selectNextTask(project, state);
  writeState(project, state);
  return { taskId: task.id, status: 'pending' };
}

/**
 * Live tasks (not completed/deferred) that depend on a deferred task and so
 * cannot run until it is reopened or the dependency is changed.
 * Returns [{ id, deferred: [ids] }].
 */
function tasksWaitingOnDeferred(project) {
  const tasks = listTasks(project);
  const deferred = new Set(tasks.filter(t => t.status === 'deferred').map(t => t.id));
  return tasks
    .filter(t => t.status !== 'completed' && t.status !== 'deferred')
    .map(t => ({ id: t.id, deferred: t.dependencies.filter(d => deferred.has(d)) }))
    .filter(x => x.deferred.length);
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

/**
 * in-progress → pending. Drops the claim and the in_progress entry, keeps the task
 * content. With `agent`, refuses when the task is claimed by a different agent.
 */
function resetTask(project, taskId, { agent = '' } = {}) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  assertTransition(task.status, 'pending');
  const held = readLock(project, task.id);
  if (agent && held && held.agent !== agent) {
    throw new WorkflowError(`${task.id} is claimed by '${held.agent}', not '${agent}'.`);
  }
  const state = readState(project);
  setTaskStatus(project, task, 'pending');
  releaseLock(project, task.id);
  state.in_progress = removeId(state.in_progress, task.id);
  if (state.current_task === task.id) {
    const others = removeId(state.in_progress, task.id);
    state.current_task = others.length ? others[0] : selectNextTask(project, state);
  }
  writeState(project, state);
  return { taskId: task.id, status: 'pending', currentTask: state.current_task };
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
  if (task.status === 'completed') throw new WorkflowError(`${task.id} is already completed.`);
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

function git(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Map the project directory into one of this repository's registered git
 * worktrees, so a task's Verify command can run against code that lives on its
 * task branch. Only paths git itself lists as worktrees are accepted.
 */
function resolveWorkdir(project, workdir) {
  const top = git(project, 'rev-parse', '--show-toplevel');
  if (top.status !== 0) throw new WorkflowError(`not a git repository: ${(top.stderr || '').trim()}`);
  const list = git(project, 'worktree', 'list', '--porcelain');
  if (list.status !== 0) throw new WorkflowError(`git worktree list failed: ${(list.stderr || '').trim()}`);

  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const target = real(workdir);
  const root = list.stdout.split(/\r?\n/)
    .filter(l => l.startsWith('worktree '))
    .map(l => real(l.slice('worktree '.length)))
    .find(r => r === target);
  if (!root) throw new WorkflowError(`'${workdir}' is not a registered git worktree of this repository.`);

  const rel = path.relative(real(top.stdout.trim()), real(project));
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) throw new WorkflowError(`'${dir}' does not exist in that worktree (is the project committed on its branch?).`);
  return dir;
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
  if ('project_verify' in state && !isStr(state.project_verify))
    errors.push('project_verify must be a string');
  if ('max_task_id' in state && !Number.isInteger(state.max_task_id))
    errors.push('max_task_id must be an integer');
  if ('format_version' in state && !Number.isInteger(state.format_version))
    errors.push('format_version must be an integer');

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
  for (const w of tasksWaitingOnDeferred(project)) {
    errors.push(`${w.id} depends on deferred task ${w.deferred.join(', ')}; reopen it or change the dependency`);
  }
  if (state.blocked && !tasks.some(t => t.status === 'blocked')) {
    errors.push('state.blocked is true but no task is blocked');
  }
  if (!state.blocked && tasks.some(t => t.status === 'blocked')) {
    errors.push('a task is blocked but state.blocked is false');
  }

  const warnings = [];
  const legacy = tasks.filter(t => t.format === 1).map(t => t.id);
  if (legacy.length) {
    warnings.push(`${legacy.length} task file(s) use the legacy format (${legacy.join(', ')}); run \`agent-workflow migrate\``);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Set the project phase (the one field agents change directly, via command). */
function finalize(project, phase = 'completed') {
  requireProjectDir(project);
  const tasks = listTasks(project);
  const blocked = tasks.filter(t => t.status === 'blocked').map(t => t.id);
  if (blocked.length) {
    throw new WorkflowError(
      `cannot finalize: blocked task(s) ${blocked.join(', ')}. Unblock them, or defer backlog items with \`task defer\`.`);
  }
  const state = readState(project);
  state.phase = phase;
  writeState(project, state);
  return { phase, deferred: tasks.filter(t => t.status === 'deferred').map(t => t.id) };
}

/** State summary used by the plan/start prompt builders. */
function stateSummary(project) {
  const state = readState(project);
  return {
    phase: state.phase || 'prototype',
    current: deriveCurrentTask(project, state) || 'none',
    blocked: !!state.blocked,
    completed: (state.completed_tasks || []).length,
    total: countTasks(project),
    decisions: listDecisions(project),
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
  writeFileAtomic,
  withStateLock,
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
  addTask: locked(addTask),
  resolvePlan,
  addTasks: locked(addTasks),
  updateTask: locked(updateTask),
  removeTask: locked(removeTask),
  setBrief: locked(setBrief),
  projectSummary,
  stateSummary,
  STATUSES,
  TRANSITIONS,
  setTaskStatus,
  selectNextTask,
  runnableTasks,
  startTask,
  migrateProject,
  startTasks,
  completeTasks,
  recordDecisions: locked(recordDecisions),
  listDecisions,
  parseDecisions,
  parseTaskText,
  setField,
  FORMAT_VERSION,
  verifyTask,
  verifyProject,
  setProjectVerify: locked(setProjectVerify),
  completeTask,
  blockTask: locked(blockTask),
  unblockTask: locked(unblockTask),
  deferTask: locked(deferTask),
  reopenTask: locked(reopenTask),
  tasksWaitingOnDeferred,
  claimTask: locked(claimTask),
  releaseTask: locked(releaseTask),
  resetTask: locked(resetTask),
  listLocks,
  readLock,
  worktreePlan,
  createWorktree,
  validateProject,
  finalize: locked(finalize),
  requireProjectDir,
};
