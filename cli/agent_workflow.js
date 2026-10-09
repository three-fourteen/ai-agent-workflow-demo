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
  if (r.warning) process.stderr.write(`Warning: ${r.warning}\n`);
}

function cmdVerifyConfig(project, { set, clear }) {
  if (clear) core.setProjectVerify(project, '');
  else if (set !== undefined) core.setProjectVerify(project, set);
  const cmd = core.readState(project).project_verify || '';
  console.log(cmd ? `project verify: ${cmd}` : 'project verify: (none)');
}

/** Why `next` is empty: work still in flight, blocked, waiting on dependencies, or truly done. */
function nothingRunnableHint(project) {
  const tasks = core.listTasks(project);
  const ids = status => tasks.filter(t => t.status === status).map(t => t.id);
  const inProgress = ids('in-progress');
  const blocked = ids('blocked');
  const pending = ids('pending');
  if (inProgress.length) return `No other task is runnable yet; ${inProgress.length} in progress (${inProgress.join(', ')}).`;
  if (blocked.length) return `Nothing is runnable; blocked: ${blocked.join(', ')}. Unblock or defer ${blocked.length > 1 ? 'them' : 'it'}.`;
  if (pending.length) {
    return `Nothing is runnable; ${pending.length} pending task(s) wait on dependencies (${pending.join(', ')}). ` +
           `Run \`${invokePrefix()} validate\`.`;
  }
  return `All tasks are done — run \`${invokePrefix()} validate\`, then \`${invokePrefix()} finalize\`.`;
}

function cmdTaskDecide(project, taskId, decisions) {
  if (!decisions.length) fail('task decide requires --decision "text" (repeatable).\n' + USAGE);
  const r = core.recordDecisions(project, taskId, decisions);
  console.log(`${r.taskId}: ${r.decisions.length} decision(s) recorded`);
}

function cmdDecisions(project, json) {
  const all = core.listDecisions(project);
  if (json) { console.log(JSON.stringify(all, null, 2)); return; }
  if (!all.length) { console.log('No decisions recorded.'); return; }
  let last = '';
  for (const d of all) {
    if (d.task !== last) { console.log(`${d.task}  ${d.title}`); last = d.task; }
    console.log(`  - ${d.text}`);
  }
}

function cmdTaskComplete(project, taskId, { force, noVerify, decisions = [] }) {
  const r = core.completeTask(project, taskId, { force, noVerify, decisions, inherit: true });
  console.log(`${r.taskId} → completed${r.verified ? ' (verified)' : ' (unverified)'}`);
  console.log(r.nextTask ? `Next task: ${r.nextTask}` : nothingRunnableHint(project));
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

function cmdTaskReset(project, taskId, agent) {
  const r = core.resetTask(project, taskId, { agent });
  console.log(`${r.taskId} → pending`);
}

function cmdTaskDefer(project, taskId, reason) {
  const r = core.deferTask(project, taskId, { reason });
  console.log(`${r.taskId} → deferred`);
}

function cmdTaskReopen(project, taskId) {
  const r = core.reopenTask(project, taskId);
  console.log(`${r.taskId} → pending`);
}

function cmdMigrate(project, dryRun) {
  const r = core.migrateProject(project, { dryRun });
  if (!r.migrated.length) {
    console.log(`Nothing to migrate: ${r.skipped.length} task file(s) already use format ${core.FORMAT_VERSION}.`);
    return;
  }
  for (const m of r.migrated) console.log(`${dryRun ? 'would migrate' : 'migrated'} ${m.from} → ${m.to}`);
  console.log(dryRun
    ? `\nDry run: ${r.migrated.length} file(s) would change. Re-run without --dry-run to apply.`
    : `\nMigrated ${r.migrated.length} task file(s) to format ${core.FORMAT_VERSION}.`);
}

function cmdValidate(project) {
  const { ok, errors, warnings = [] } = core.validateProject(project);
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
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
  if (r.deferred.length) console.log(`Deferred (kept on record): ${r.deferred.join(', ')}`);
}

function cmdNext(project, all, json) {
  const runnable = core.runnableTasks(project);
  const chosen = all ? runnable : runnable.slice(0, 1);
  if (json) {
    console.log(JSON.stringify(chosen.map(t => ({ id: t.id, goal: t.goal, dependencies: t.dependencies })), null, 2));
    return;
  }
  if (chosen.length === 0) {
    console.log('No runnable task — all tasks are completed, blocked, deferred, or waiting on dependencies.');
    for (const w of core.tasksWaitingOnDeferred(project)) {
      console.log(`${w.id} is waiting on deferred ${w.deferred.join(', ')} (reopen it or change the dependency).`);
    }
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
    if (s.deferred.length) console.log(`  deferred: ${s.deferred.join(', ')}`);
    if (s.decisions) console.log(`  decisions: ${s.decisions} (run \`${invokePrefix()} decisions\`)`);
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
  printDecisionsSoFar(s.decisions);
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
  printDecisionsSoFar(s.decisions);
}

/** Show the latest decisions so the next agent starts from what was already settled. */
function printDecisionsSoFar(decisions, limit = 10) {
  if (!decisions.length) return;
  const shown = decisions.slice(-limit);
  console.log(`Decisions so far${decisions.length > shown.length ? ` (latest ${shown.length} of ${decisions.length}; see \`${invokePrefix()} decisions\`)` : ''}:`);
  for (const d of shown) console.log(`  - ${d.task}: ${d.text}`);
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
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--decision') {
      (flags.decisions = flags.decisions || []).push(argv[++i]);
    } else if (arg === '--agent') {
      flags.agent = argv[++i];
    } else if (arg === '--set') {
      flags.set = argv[++i];
    } else if (arg === '--clear') {
      flags.clear = true;
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
  agent-workflow task complete [<project>] <id> [--force|-f] [--no-verify] [--decision "..."]...
  agent-workflow task decide [<project>] <id> --decision "..." [--decision "..."]...
  agent-workflow task verify [<project>] <id>
  agent-workflow task block [<project>] <id> --reason "..." [--strategy "..."]
  agent-workflow task unblock [<project>] <id>
  agent-workflow task reset [<project>] <id> [--agent NAME]
  agent-workflow task defer [<project>] <id> [--reason "..."]
  agent-workflow task reopen [<project>] <id>
  agent-workflow next [<project>] [--all] [--json]
  agent-workflow claim [<project>] <id> [--agent NAME]
  agent-workflow release [<project>] <id>
  agent-workflow worktree [<project>] <id>
  agent-workflow status [<project>]
  agent-workflow verify-config [<project>] [--set "<command>" | --clear]
  agent-workflow decisions [<project>] [--json]
  agent-workflow migrate [<project>] [--dry-run]
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
      cmdTaskComplete(project, taskId, { force: flags.force || false, noVerify: flags.noVerify || false, decisions: flags.decisions || [] });

    } else if (sub === 'decide') {
      const { project, taskId } = resolveTaskArgs(positional, 'decide');
      cmdTaskDecide(project, taskId, flags.decisions || []);

    } else if (sub === 'verify') {
      const { project, taskId } = resolveTaskArgs(positional, 'verify');
      cmdVerify(project, taskId);

    } else if (sub === 'block') {
      const { project, taskId } = resolveTaskArgs(positional, 'block');
      cmdTaskBlock(project, taskId, flags.reason || '', flags.strategy || '');

    } else if (sub === 'unblock') {
      const { project, taskId } = resolveTaskArgs(positional, 'unblock');
      cmdTaskUnblock(project, taskId);

    } else if (sub === 'reset') {
      const { project, taskId } = resolveTaskArgs(positional, 'reset');
      cmdTaskReset(project, taskId, flags.agent || '');

    } else if (sub === 'defer') {
      const { project, taskId } = resolveTaskArgs(positional, 'defer');
      cmdTaskDefer(project, taskId, flags.reason || '');

    } else if (sub === 'reopen') {
      const { project, taskId } = resolveTaskArgs(positional, 'reopen');
      cmdTaskReopen(project, taskId);

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

  } else if (command === 'verify-config') {
    const { flags, positional } = parseFlags(rest);
    cmdVerifyConfig(positional[0] || '.', { set: flags.set, clear: flags.clear || false });

  } else if (command === 'decisions') {
    const { positional, flags } = parseFlags(rest);
    cmdDecisions(positional[0] || '.', !!flags.json);

  } else if (command === 'migrate') {
    const { positional, flags } = parseFlags(rest);
    cmdMigrate(positional[0] || '.', !!flags.dryRun);

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
