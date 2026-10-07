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

/** Next free task number: highest existing id + 1, so gaps never cause collisions. */
function nextTaskId(projectDir) {
  const nums = listTaskFiles(projectDir)
    .map(f => /^T-(\d+)/.exec(f))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10));
  return (nums.length ? Math.max(...nums) : 0) + 1;
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
 * Returns { id, file, slug, status, dependencies, goal, verify, source, raw }.
 */
function parseTaskFile(fullPath) {
  const raw = fs.readFileSync(fullPath, 'utf8');
  const filename = path.basename(fullPath);
  const fields = { status: 'pending', dependencies: [], goal: '', verify: '', source: '' };

  for (const line of raw.split(/\r?\n/)) {
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

  const slugMatch = /^T-\d+-(.*)\.md$/.exec(filename);
  return {
    id: taskIdFromFilename(filename),
    file: filename,
    slug: slugMatch ? slugMatch[1] : '',
    status: fields.status,
    dependencies: fields.dependencies,
    goal: fields.goal,
    verify: fields.verify,
    source: fields.source,
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
  fs.writeFileSync(path.join(aiDir, '.gitignore'),          'locks/\n',                 'utf8');

  const projectName = name || (inPlace ? path.basename(path.resolve(project)) : project);
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

/** Render a task markdown file in the canonical loose `Key: value` format. */
function renderTask({ goal, source = '', context = '', dependencies = [], subtasks = [],
                      doneCriteria = '', verify = '', nextStep = 'None.' }) {
  const deps = dependencies.length ? dependencies.join(', ') : 'none';
  const subs = subtasks.length ? subtasks.map((t, i) => `${i + 1}. ${t}`).join('\n') : '';
  const block = text => (text ? `${text}\n` : '');
  return `\
Status: pending

Goal: ${goal}
${source ? `\nSource: ${source}\n` : ''}
Context:
${block(context)}
Dependencies: ${deps}

Subtasks:
${block(subs)}
Done Criteria:
${block(doneCriteria)}
Verification:

Verify: ${verify}

Next Step:
${nextStep}

Blockers:
None
`;
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
  const filename = `${taskId}-${slugify(title)}.md`;
  const taskPath = path.join(tasksDir(project), filename);
  const deps     = Array.isArray(after) ? after : (after ? [after] : []);

  fs.writeFileSync(taskPath, renderTask({
    goal: description || title,
    source, context, subtasks, doneCriteria, verify,
    dependencies: deps,
    nextStep: `Proceed to T-${String(n + 1).padStart(3, '0')}.`,
  }), 'utf8');

  const state = readState(project);
  let setCurrent = false;
  if (!state.current_task) {
    state.current_task = taskId;
    writeState(project, state);
    setCurrent = true;
  }
  return { taskId, taskPath, setCurrent };
}

// ---------------------------------------------------------------------------
// Planning — validate and write a whole task list at once
// ---------------------------------------------------------------------------

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Free-text lines that the line-based task parser would mistake for fields. */
const RESERVED_LINE_RE = /^\s*(status|dependencies|goal|verify|source)\s*:/im;
const MAX_SUBTASKS = 8;

function checkOneLine(errors, label, v) {
  if (typeof v !== 'string' || /[\r\n]/.test(v)) errors.push(`${label} must be a single-line string`);
}
function checkFreeText(errors, label, v) {
  if (typeof v !== 'string') errors.push(`${label} must be a string`);
  else if (RESERVED_LINE_RE.test(v)) {
    errors.push(`${label} has a line starting with a reserved field (Status/Dependencies/Goal/Verify/Source)`);
  }
}

/**
 * Validate a proposed plan and resolve it to concrete task ids WITHOUT writing
 * anything. Works before `init` (ids start at T-001) and when appending to an
 * existing project. Each spec: { key, title, goal?, context?, depends_on?,
 * subtasks?, done_criteria?, verify?, source? }; `depends_on` entries are plan
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
    const file = `${r.id}-${slugify(spec.title)}.md`;
    const next = plan.resolved[i + 1];
    return {
      r, file,
      full: path.join(tasksDir(project), file),
      content: renderTask({
        goal: spec.goal || spec.title,
        source: spec.source || '',
        context: spec.context || '',
        dependencies: r.depends_on,
        subtasks: spec.subtasks || [],
        doneCriteria: spec.done_criteria || '',
        verify: spec.verify || '',
        nextStep: next ? `Proceed to ${next.id}.` : 'None.',
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
  let currentTask = state.current_task || null;
  if (!currentTask) {
    currentTask = plan.waves[0][0];
    state.current_task = currentTask;
    writeState(project, state);
  }
  return {
    created: files.map(f => ({ key: f.r.key, id: f.r.id, file: f.file, verify: f.r.verify })),
    currentTask,
  };
}

// ---------------------------------------------------------------------------
// Re-planning — edit or remove tasks that haven't started
// ---------------------------------------------------------------------------

const HEADERS = ['Status', 'Goal', 'Source', 'Context', 'Dependencies', 'Subtasks',
                 'Done Criteria', 'Verification', 'Verify', 'Next Step', 'Blockers'];
const HEADER_RE = new RegExp(`^(${HEADERS.join('|')}):`, 'i');
const headerRe = name => new RegExp(`^${name}:`, 'i');

/** Replace (or insert) a single-line `Header: value` field. */
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

/** Replace (or append) a block section — everything up to the next known header. */
function setSection(raw, header, body) {
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
 * context, depends_on (task ids), subtasks, done_criteria, verify, source.
 * Hand-written content outside the patched fields is left untouched.
 */
function updateTask(project, taskId, patch = {}) {
  requireProjectDir(project);
  const task = findTask(project, taskId);
  assertEditable(project, task);

  const known = ['title', 'goal', 'context', 'depends_on', 'subtasks', 'done_criteria', 'verify', 'source'];
  const unknown = Object.keys(patch).filter(k => !known.includes(k));
  if (unknown.length) throw new WorkflowError(`unknown field(s): ${unknown.join(', ')}.`);
  if (!Object.keys(patch).length) throw new WorkflowError('nothing to update.');

  const errors = [];
  for (const f of ['title', 'goal', 'verify', 'source']) {
    if (patch[f] !== undefined) checkOneLine(errors, f, patch[f]);
  }
  if (patch.title !== undefined && typeof patch.title === 'string') {
    if (!patch.title.trim() || !slugify(patch.title)) errors.push('title needs at least one letter or digit');
    if (patch.title.length > 80) errors.push('title is longer than 80 characters');
  }
  for (const f of ['context', 'done_criteria']) {
    if (patch[f] !== undefined) checkFreeText(errors, f, patch[f]);
  }
  if (patch.subtasks !== undefined) {
    if (!Array.isArray(patch.subtasks)) errors.push('subtasks must be an array');
    else patch.subtasks.forEach((t, i) => checkFreeText(errors, `subtasks[${i}]`, t));
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
  if (patch.goal !== undefined)          raw = setLineField(raw, 'Goal', patch.goal);
  if (patch.source !== undefined)        raw = setLineField(raw, 'Source', patch.source);
  if (patch.verify !== undefined)        raw = setLineField(raw, 'Verify', patch.verify);
  if (deps)                              raw = setLineField(raw, 'Dependencies', deps.length ? deps.join(', ') : 'none');
  if (patch.context !== undefined)       raw = setSection(raw, 'Context', patch.context);
  if (patch.done_criteria !== undefined) raw = setSection(raw, 'Done Criteria', patch.done_criteria);
  if (patch.subtasks !== undefined) {
    raw = setSection(raw, 'Subtasks', patch.subtasks.map((t, i) => `${i + 1}. ${t}`).join('\n'));
  }

  let file = task.file;
  if (patch.title !== undefined) file = `${task.id}-${slugify(patch.title)}.md`;
  const target = path.join(tasksDir(project), file);
  if (file !== task.file && fs.existsSync(target)) throw new WorkflowError(`${file} already exists.`);

  fs.writeFileSync(path.join(tasksDir(project), task.file), raw, 'utf8');
  if (file !== task.file) fs.renameSync(path.join(tasksDir(project), task.file), target);
  return { taskId: task.id, file };
}

/**
 * Delete a pending task. Refuses while other tasks depend on it (update or
 * remove those first). Ids are never reused or renumbered.
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
  if (state.current_task === task.id) {
    state.current_task = selectNextTask(project, state);
    writeState(project, state);
  }
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
    if (!state.current_task) state.current_task = task.id;
    writeState(project, state);
  } catch (err) {
    releaseLock(project, task.id); // don't leave an orphaned claim behind
    throw err;
  }
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
  resolvePlan,
  addTasks,
  updateTask,
  removeTask,
  setBrief,
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
