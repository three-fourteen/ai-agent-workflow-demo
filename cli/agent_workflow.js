#!/usr/bin/env node
/**
 * agent_workflow.js — CLI for the git-native AI agent workflow.
 *
 * Usage:
 *   agent-workflow init <project> [--description|-d "..."]
 *   agent-workflow task add <project> <title> [--description|-d "..."] [--after T-001]
 *   agent-workflow status [project]
 *   agent-workflow plan [<project>] [--execute]
 *   agent-workflow start [<project>] [--all]
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Embedded templates (mirrors .ai/ files in existing demo projects)
// ---------------------------------------------------------------------------

const AGENT_PLAN_HERE = `\
This repository uses an AI-native development workflow.

You are in PLANNING mode. Do not implement anything yet.

1. Read PROJECT_STATE.json and .ai/WORKING_RULES.md
2. Ask the user any clarifying questions needed before creating tasks (scope, requirements, constraints, priorities)
3. Wait for answers before proceeding
4. Create task files in /tasks following .ai/TASK_TEMPLATE.md and WORKING_RULES.md
5. Update PROJECT_STATE.json with the first task as current_task
6. Present the task plan to the user

Follow the mode instruction from the command output above.

Do not explore the repository unnecessarily.
Do not start implementing.
`;

const AGENT_START_HERE = `\
This repository uses an AI-native development workflow.

You are in EXECUTION mode.

1. Read PROJECT_STATE.json
2. If current_task exists and is valid, open it
3. Else:
   - scan /tasks
   - resolve dependencies
   - pick next task
4. Execute the task's subtasks
5. When the task is complete:
   - Set Status to completed
   - Add task to completed_tasks in PROJECT_STATE.json
   - Update current_task to the next pending task (or null if none remain)
6. Summarize what you implemented for the completed task
7. Follow the mode instruction from the command output above

Do not explore the repository unnecessarily.
Focus on the current task only.
`;

const WORKING_RULES = `\
Rules for AI agents working in this repository.

- Only one task may be in progress.

## Task Requirements

All tasks must include:
- Status
- Goal
- Context
- Dependencies
- Subtasks
- Done Criteria
- Verification
- Next Step
- Blockers

## Task Selection

- \`current_task\` is optional in hybrid mode.
- If \`current_task\` exists and matches a task file, use it.
- If \`current_task\` is null, missing, or invalid, scan \`/tasks\`, ignore tasks with \`Status: completed\` or \`Status: blocked\`, and pick the first task whose dependencies are all listed in \`completed_tasks\`.
- If no task qualifies, trigger finalization.

## When completing a task

1. Set Status to completed
2. Add task to completed_tasks in PROJECT_STATE.json
3. Select next task
4. Update next_step

## When blocked

1. Set blocked=true in PROJECT_STATE.json
2. Add:
   - block_reason
   - unblock_strategy
3. Update task file Blockers section

## Finalization step

If:
- current_task is null or no valid task can be selected
- no pending tasks exist

Then:

1. Generate:
   - /docs/completion-summary.md
   - /docs/user-story.md
2. Update PROJECT_STATE.json:
   "phase": "completed"
`;

const TASK_TEMPLATE = `\
Status: pending | in-progress | completed | blocked

Goal

Context

Dependencies: none

Subtasks

Done Criteria

Verification

Next Step

Blockers
`;

const TASK_INDEX = JSON.stringify(
  {
    mode: 'placeholder',
    notes: 'Reserved for future optimization. Hybrid mode scans /tasks when current_task is missing.',
  },
  null,
  2
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readState(projectDir) {
  const statePath = path.join(projectDir, '.ai', 'PROJECT_STATE.json');
  if (!fs.existsSync(statePath)) {
    process.stderr.write(`Error: ${statePath} not found. Is '${projectDir}' a valid project?\n`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeState(projectDir, state) {
  const statePath = path.join(projectDir, '.ai', 'PROJECT_STATE.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function countTasks(projectDir) {
  const tasksDir = path.join(projectDir, 'tasks');
  try {
    return fs.readdirSync(tasksDir).filter(f => /^T-.*\.md$/.test(f)).length;
  } catch {
    return 0;
  }
}

function nextTaskId(projectDir) {
  return countTasks(projectDir) + 1;
}

/**
 * Returns the correct command prefix for "next steps" hints.
 * When run via `npx`, process.argv[1] contains `_npx` in its path,
 * meaning `agent-workflow` is not in $PATH.
 * AFW_INVOKE_PREFIX env var overrides for testing.
 */
function invokePrefix() {
  if (process.env.AFW_INVOKE_PREFIX) return process.env.AFW_INVOKE_PREFIX;
  if (process.argv[1] && process.argv[1].includes('_npx')) {
    return 'npx github:three-fourteen/ai-agent-workflow-demo';
  }
  return 'agent-workflow';
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function isProjectDir(dir) {
  return fs.existsSync(path.join(dir, '.ai', 'PROJECT_STATE.json'));
}

function cmdInit(project, description) {
  const inPlace = project === '.';

  if (!inPlace && fs.existsSync(project)) {
    process.stderr.write(`Error: '${project}' already exists.\n`);
    process.exit(1);
  }

  const aiDir    = path.join(project, '.ai');
  const tasksDir = path.join(project, 'tasks');
  fs.mkdirSync(aiDir,    { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  fs.writeFileSync(path.join(aiDir, 'AGENT_PLAN_HERE.md'),  AGENT_PLAN_HERE,  'utf8');
  fs.writeFileSync(path.join(aiDir, 'AGENT_START_HERE.md'), AGENT_START_HERE, 'utf8');
  fs.writeFileSync(path.join(aiDir, 'WORKING_RULES.md'),    WORKING_RULES,    'utf8');
  fs.writeFileSync(path.join(aiDir, 'TASK_TEMPLATE.md'),    TASK_TEMPLATE,    'utf8');
  fs.writeFileSync(path.join(aiDir, 'TASK_INDEX.json'),     TASK_INDEX + '\n','utf8');

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

  console.log(`Initialized project '${projectName}'`);
  console.log(`  ${aiDir}/`);
  console.log(`  ${tasksDir}/`);
  console.log();
  console.log('Next: add tasks with:');
  const taskHint = inPlace ? `"<task title>"` : `${project} "<task title>"`;
  console.log(`  ${invokePrefix()} task add ${taskHint}`);
}

function cmdTaskAdd(project, title, description, after) {
  if (!isProjectDir(project)) {
    process.stderr.write(`Error: project '${project}' not found.\n`);
    process.exit(1);
  }

  const n      = nextTaskId(project);
  const taskId = `T-${String(n).padStart(3, '0')}`;
  const slug   = slugify(title);
  const filename  = `${taskId}-${slug}.md`;
  const taskPath  = path.join(project, 'tasks', filename);
  const desc      = description || title;
  const deps      = after || 'none';
  const nextStep  = `Proceed to T-${String(n + 1).padStart(3, '0')}.`;

  const content = `\
Status: pending

Goal: ${desc}

Context:

Dependencies: ${deps}

Subtasks:

Done Criteria:

Verification:

Next Step:
${nextStep}

Blockers:
None
`;

  fs.writeFileSync(taskPath, content, 'utf8');

  const state = readState(project);
  if (!state.current_task) {
    state.current_task = taskId;
    writeState(project, state);
    console.log(`Created ${taskPath}  (set as current_task)`);
  } else {
    console.log(`Created ${taskPath}`);
  }
}

function cmdStatus(filterProject) {
  const inPlace = !filterProject && isProjectDir('.');

  const entries = inPlace
    ? ['.']
    : fs.readdirSync('.', { withFileTypes: true })
        .filter(d => d.isDirectory())
        .filter(d => isProjectDir(d.name))
        .map(d => d.name)
        .sort();

  if (entries.length === 0) {
    console.log('No projects found in current directory.');
    return;
  }

  const colW = [14, 10, 28, 6, 8];
  const header =
    'Project'.padEnd(colW[0]) + ' ' +
    'Phase'.padEnd(colW[1])   + ' ' +
    'Current Task'.padEnd(colW[2]) + ' ' +
    'Done'.padEnd(colW[3])    + ' ' +
    'Blocked';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const projectPath of entries) {
    if (filterProject && projectPath !== filterProject) continue;

    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(projectPath, '.ai', 'PROJECT_STATE.json'), 'utf8'));
    } catch {
      continue;
    }

    const projectName = projectPath === '.' ? state.project : projectPath;
    const phase     = (state.phase || '?');
    const current   = state.current_task || '-';
    const completed = (state.completed_tasks || []).length;
    const total     = countTasks(projectPath);
    const blocked   = state.blocked ? 'yes' : 'no';
    const done      = `${completed}/${total}`;

    console.log(
      projectName.padEnd(colW[0]) + ' ' +
      phase.padEnd(colW[1])       + ' ' +
      current.padEnd(colW[2])     + ' ' +
      done.padEnd(colW[3])        + ' ' +
      blocked
    );
  }
}

function cmdPlan(project, execute) {
  if (!isProjectDir(project)) {
    const msg = project === '.'
      ? 'Error: not inside a project directory.\n'
      : `Error: project '${project}' not found.\n`;
    process.stderr.write(msg);
    process.exit(1);
  }

  const state     = readState(project);
  const phase     = state.phase || 'prototype';
  const current   = state.current_task || 'none';
  const blocked   = state.blocked ? 'true' : 'false';
  const completed = (state.completed_tasks || []).length;
  const total     = countTasks(project);

  const prefix = project === '.' ? '' : `Navigate to ${project}/ and `;
  if (execute) {
    console.log(`${prefix}Follow .ai/AGENT_PLAN_HERE.md to begin planning, then execute all tasks.`);
    console.log(`Mode: plan-and-execute — after presenting the task plan, immediately proceed to execute all tasks until none remain.`);
  } else {
    console.log(`${prefix}Follow .ai/AGENT_PLAN_HERE.md to begin planning.`);
    console.log(`Mode: plan-only — after presenting the task plan, stop and wait for the user to run \`${invokePrefix()} start\`.`);
  }
  console.log(`Current state: phase=${phase}, current_task=${current}, blocked=${blocked}.`);
  console.log(`Completed: ${completed}/${total} tasks.`);
}

function cmdStart(project, all) {
  if (!isProjectDir(project)) {
    const msg = project === '.'
      ? 'Error: not inside a project directory.\n'
      : `Error: project '${project}' not found.\n`;
    process.stderr.write(msg);
    process.exit(1);
  }

  const state     = readState(project);
  const phase     = state.phase || 'prototype';
  const current   = state.current_task || 'none';
  const blocked   = state.blocked ? 'true' : 'false';
  const completed = (state.completed_tasks || []).length;
  const total     = countTasks(project);

  const prefix = project === '.' ? '' : `Navigate to ${project}/ and `;
  console.log(`${prefix}Follow .ai/AGENT_START_HERE.md to begin working.`);
  if (all) {
    console.log(`Mode: all-tasks — execute all tasks until none remain, then generate completion artifacts as defined in .ai/WORKING_RULES.md.`);
  } else {
    console.log(`Mode: single-task — after completing and summarizing one task, ask the user whether to continue with the next task and stop.`);
  }
  console.log(`Current state: phase=${phase}, current_task=${current}, blocked=${blocked}.`);
  console.log(`Completed: ${completed}/${total} tasks.`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--description' || arg === '-d') {
      flags.description = argv[++i];
    } else if (arg === '--after') {
      flags.after = argv[++i];
    } else if (arg === '--execute' || arg === '-e') {
      flags.execute = true;
    } else if (arg === '--all' || arg === '-a') {
      flags.all = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const USAGE = `\
Usage:
  agent-workflow init [<project>] [--description|-d "..."]
  agent-workflow task add [<project>] <title> [--description|-d "..."] [--after T-001]
  agent-workflow status [<project>]
  agent-workflow plan [<project>] [--execute]
  agent-workflow start [<project>] [--all]
`;

function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE);
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const command = argv[0];
  const rest    = argv.slice(1);

  if (command === 'init') {
    const { flags, positional } = parseFlags(rest);
    cmdInit(positional[0] || '.', flags.description || '');

  } else if (command === 'task') {
    if (rest[0] !== 'add') {
      process.stderr.write(`Error: unknown task subcommand '${rest[0]}'.\n` + USAGE);
      process.exit(1);
    }
    const { flags, positional } = parseFlags(rest.slice(1));
    let taskProject, taskTitle;
    if (positional[1]) {
      taskProject = positional[0];
      taskTitle   = positional[1];
    } else if (positional[0] && isProjectDir('.')) {
      taskProject = '.';
      taskTitle   = positional[0];
    } else {
      process.stderr.write('Error: task add requires <title> (run from project dir) or <project> <title>.\n' + USAGE);
      process.exit(1);
    }
    cmdTaskAdd(taskProject, taskTitle, flags.description || '', flags.after || '');

  } else if (command === 'status') {
    const { positional } = parseFlags(rest);
    cmdStatus(positional[0] || '');

  } else if (command === 'plan') {
    const { flags, positional } = parseFlags(rest);
    cmdPlan(positional[0] || '.', flags.execute || false);

  } else if (command === 'start') {
    const { flags, positional } = parseFlags(rest);
    cmdStart(positional[0] || '.', flags.all || false);

  } else {
    process.stderr.write(`Error: unknown command '${command}'.\n` + USAGE);
    process.exit(1);
  }
}

main();
