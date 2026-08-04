#!/usr/bin/env node
/**
 * agent_workflow.js — CLI for the git-native AI agent workflow.
 *
 * Thin wrapper: parses args, calls core.js, formats output, maps
 * WorkflowError → stderr + exit code.
 *
 * Usage:
 *   agent-workflow init [<project>] [--description|-d "..."]
 *   agent-workflow task add [<project>] <title> [--description|-d "..."] [--after T-001]
 *   agent-workflow status [<project>]
 *   agent-workflow plan [<project>] [--execute]
 *   agent-workflow start [<project>] [--all]
 */

'use strict';

const fs   = require('node:fs');
const core = require('./core');
const { WorkflowError } = core;

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

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

function cmdInit(project, description) {
  const { projectName, aiDir, tasksDir, inPlace } = core.initProject(project, description);

  console.log(`Initialized project '${projectName}'`);
  console.log(`  ${aiDir}/`);
  console.log(`  ${tasksDir}/`);
  console.log();
  console.log('Next: add tasks with:');
  const taskHint = inPlace ? `"<task title>"` : `${project} "<task title>"`;
  console.log(`  ${invokePrefix()} task add ${taskHint}`);
}

function cmdTaskAdd(project, title, description, after) {
  const { taskPath, setCurrent } = core.addTask(project, title, { description, after });
  console.log(setCurrent
    ? `Created ${taskPath}  (set as current_task)`
    : `Created ${taskPath}`);
}

/**
 * Resolve `<project> <id>` or (inside a project) `<id>` from positionals.
 * Returns { project, taskId }.
 */
function resolveTaskArgs(positional, verb) {
  if (positional[1]) return { project: positional[0], taskId: positional[1] };
  if (positional[0] && core.isProjectDir('.')) return { project: '.', taskId: positional[0] };
  fail(`task ${verb} requires <id> (run from project dir) or <project> <id>.\n` + USAGE);
}

function agentName(flags) {
  return flags.agent || process.env.AFW_AGENT || 'agent';
}

function cmdTaskStart(project, taskId, agent) {
  const r = core.startTask(project, taskId, { agent });
  console.log(`${r.taskId} → in-progress`);
}

function cmdTaskComplete(project, taskId, { force, noVerify }) {
  const r = core.completeTask(project, taskId, { force, noVerify, inherit: true });
  console.log(`${r.taskId} → completed${r.verified ? ' (verified)' : ' (unverified)'}`);
  console.log(r.nextTask
    ? `Next task: ${r.nextTask}`
    : `No runnable task remains — run \`${invokePrefix()} validate\`, then \`${invokePrefix()} finalize\`.`);
}

function cmdVerify(project, taskId) {
  const v = core.verifyTask(project, taskId, { inherit: true });
  if (!v.ran) {
    process.stderr.write(`Error: ${taskId} has no Verify command.\n`);
    process.exit(1);
  }
  if (v.ok) {
    console.log(`✓ ${taskId} verification passed`);
  } else {
    process.stderr.write(`✗ ${taskId} verification failed (exit ${v.code})\n`);
    process.exit(v.code || 1);
  }
}

function cmdTaskBlock(project, taskId, reason, strategy) {
  const r = core.blockTask(project, taskId, { reason, strategy });
  console.log(`${r.taskId} → blocked`);
}

function cmdTaskUnblock(project, taskId) {
  const r = core.unblockTask(project, taskId);
  console.log(`${r.taskId} → pending`);
}

function cmdValidate(project) {
  const { ok, errors } = core.validateProject(project);
  if (ok) {
    console.log('✓ valid');
    return;
  }
  process.stderr.write(`✗ ${errors.length} problem(s):\n`);
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}

function cmdFinalize(project) {
  const r = core.finalize(project, 'completed');
  console.log(`phase → ${r.phase}`);
}

function cmdNext(project, all, json) {
  const runnable = core.runnableTasks(project);
  const chosen = all ? runnable : runnable.slice(0, 1);
  if (json) {
    console.log(JSON.stringify(chosen.map(t => ({ id: t.id, goal: t.goal, dependencies: t.dependencies })), null, 2));
    return;
  }
  if (chosen.length === 0) {
    console.log('No runnable task — all tasks are completed, blocked, or waiting on dependencies.');
    return;
  }
  for (const t of chosen) {
    console.log(`${t.id}  ${t.goal || t.slug}`);
  }
  if (all && chosen.length > 1) {
    console.log(`\n${chosen.length} tasks can run in parallel. Claim one with \`${invokePrefix()} task start <id>\`.`);
  }
}

function cmdClaim(project, taskId, agent) {
  const r = core.claimTask(project, taskId, { agent });
  console.log(`${r.taskId} claimed by '${r.agent}'`);
}

function cmdRelease(project, taskId) {
  const r = core.releaseTask(project, taskId);
  console.log(`${r.taskId} released`);
}

function cmdWorktree(project, taskId) {
  const r = core.createWorktree(project, taskId);
  console.log(`Created worktree at ${r.path} on branch ${r.branch}`);
  console.log(`Next: cd ${r.path} && ${invokePrefix()} task start ${taskId}`);
}

function cmdStatus(filterProject) {
  const inPlace = !filterProject && core.isProjectDir('.');

  const entries = inPlace
    ? ['.']
    : fs.readdirSync('.', { withFileTypes: true })
        .filter(d => d.isDirectory())
        .filter(d => core.isProjectDir(d.name))
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

    let s;
    try {
      s = core.projectSummary(projectPath);
    } catch {
      continue;
    }

    console.log(
      s.name.padEnd(colW[0])                 + ' ' +
      s.phase.padEnd(colW[1])                + ' ' +
      s.current.padEnd(colW[2])              + ' ' +
      `${s.completed}/${s.total}`.padEnd(colW[3]) + ' ' +
      (s.blocked ? 'yes' : 'no')
    );
  }
}

function requireProject(project) {
  if (!core.isProjectDir(project)) {
    throw new WorkflowError(project === '.'
      ? 'not inside a project directory.'
      : `project '${project}' not found.`);
  }
}

function cmdPlan(project, execute) {
  requireProject(project);
  const s = core.stateSummary(project);

  const prefix = project === '.' ? '' : `Navigate to ${project}/ and `;
  if (execute) {
    console.log(`${prefix}Follow .ai/AGENT_PLAN_HERE.md to begin planning, then execute all tasks.`);
    console.log(`Mode: plan-and-execute — after presenting the task plan, immediately proceed to execute all tasks until none remain.`);
  } else {
    console.log(`${prefix}Follow .ai/AGENT_PLAN_HERE.md to begin planning.`);
    console.log(`Mode: plan-only — after presenting the task plan, stop and wait for the user to run \`${invokePrefix()} start\`.`);
  }
  console.log(`Current state: phase=${s.phase}, current_task=${s.current}, blocked=${s.blocked}.`);
  console.log(`Completed: ${s.completed}/${s.total} tasks.`);
}

function cmdStart(project, all) {
  requireProject(project);
  const s = core.stateSummary(project);

  const prefix = project === '.' ? '' : `Navigate to ${project}/ and `;
  console.log(`${prefix}Follow .ai/AGENT_START_HERE.md to begin working.`);
  if (all) {
    console.log(`Mode: all-tasks — execute all tasks until none remain, then generate completion artifacts as defined in .ai/WORKING_RULES.md.`);
  } else {
    console.log(`Mode: single-task — after completing and summarizing one task, ask the user whether to continue with the next task and stop.`);
  }
  console.log(`Current state: phase=${s.phase}, current_task=${s.current}, blocked=${s.blocked}.`);
  console.log(`Completed: ${s.completed}/${s.total} tasks.`);
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
    } else if (arg === '--reason' || arg === '-r') {
      flags.reason = argv[++i];
    } else if (arg === '--strategy' || arg === '-s') {
      flags.strategy = argv[++i];
    } else if (arg === '--execute' || arg === '-e') {
      flags.execute = true;
    } else if (arg === '--all' || arg === '-a') {
      flags.all = true;
    } else if (arg === '--force' || arg === '-f') {
      flags.force = true;
    } else if (arg === '--no-verify') {
      flags.noVerify = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--agent') {
      flags.agent = argv[++i];
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
  agent-workflow task start [<project>] <id> [--agent NAME]
  agent-workflow task complete [<project>] <id> [--force|-f] [--no-verify]
  agent-workflow task verify [<project>] <id>
  agent-workflow task block [<project>] <id> --reason "..." [--strategy "..."]
  agent-workflow task unblock [<project>] <id>
  agent-workflow next [<project>] [--all] [--json]
  agent-workflow claim [<project>] <id> [--agent NAME]
  agent-workflow release [<project>] <id>
  agent-workflow worktree [<project>] <id>
  agent-workflow status [<project>]
  agent-workflow validate [<project>]
  agent-workflow finalize [<project>]
  agent-workflow mcp [<project>]
  agent-workflow plan [<project>] [--execute]
  agent-workflow start [<project>] [--all]
`;

function fail(message) {
  process.stderr.write(`Error: ${message}`);
  process.exit(1);
}

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
    const sub = rest[0];
    const { flags, positional } = parseFlags(rest.slice(1));

    if (sub === 'add') {
      let taskProject, taskTitle;
      if (positional[1]) {
        taskProject = positional[0];
        taskTitle   = positional[1];
      } else if (positional[0] && core.isProjectDir('.')) {
        taskProject = '.';
        taskTitle   = positional[0];
      } else {
        fail('task add requires <title> (run from project dir) or <project> <title>.\n' + USAGE);
      }
      cmdTaskAdd(taskProject, taskTitle, flags.description || '', flags.after || '');

    } else if (sub === 'start') {
      const { project, taskId } = resolveTaskArgs(positional, 'start');
      cmdTaskStart(project, taskId, agentName(flags));

    } else if (sub === 'complete') {
      const { project, taskId } = resolveTaskArgs(positional, 'complete');
      cmdTaskComplete(project, taskId, { force: flags.force || false, noVerify: flags.noVerify || false });

    } else if (sub === 'verify') {
      const { project, taskId } = resolveTaskArgs(positional, 'verify');
      cmdVerify(project, taskId);

    } else if (sub === 'block') {
      const { project, taskId } = resolveTaskArgs(positional, 'block');
      cmdTaskBlock(project, taskId, flags.reason || '', flags.strategy || '');

    } else if (sub === 'unblock') {
      const { project, taskId } = resolveTaskArgs(positional, 'unblock');
      cmdTaskUnblock(project, taskId);

    } else {
      fail(`unknown task subcommand '${sub}'.\n` + USAGE);
    }

  } else if (command === 'next') {
    const { flags, positional } = parseFlags(rest);
    cmdNext(positional[0] || '.', flags.all || false, flags.json || false);

  } else if (command === 'claim') {
    const { flags, positional } = parseFlags(rest);
    const { project, taskId } = resolveTaskArgs(positional, 'claim');
    cmdClaim(project, taskId, agentName(flags));

  } else if (command === 'release') {
    const { positional } = parseFlags(rest);
    const { project, taskId } = resolveTaskArgs(positional, 'release');
    cmdRelease(project, taskId);

  } else if (command === 'worktree') {
    const { positional } = parseFlags(rest);
    const { project, taskId } = resolveTaskArgs(positional, 'worktree');
    cmdWorktree(project, taskId);

  } else if (command === 'validate') {
    const { positional } = parseFlags(rest);
    cmdValidate(positional[0] || '.');

  } else if (command === 'finalize') {
    const { positional } = parseFlags(rest);
    cmdFinalize(positional[0] || '.');

  } else if (command === 'mcp') {
    const { positional } = parseFlags(rest);
    // Lazy-require: the MCP SDK only loads when the server is actually started.
    require('./mcp_server').runServer(positional[0] || '.').catch(err => {
      process.stderr.write(`Error: mcp server failed: ${err.stack || err}\n`);
      process.exit(1);
    });

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
    fail(`unknown command '${command}'.\n` + USAGE);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof WorkflowError) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(err.code);
  }
  throw err;
}
