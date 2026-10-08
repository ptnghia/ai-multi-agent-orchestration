#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { makeContactSheet } from './contact-sheet.js';
import { commitContext, recordEvent, syncActive } from './context.js';
import { runShell, tail } from './exec.js';
import * as git from './git.js';
import { runTask } from './runner.js';
import {
  AIO_HOME,
  listTaskIds,
  loadState,
  loadTask,
  newState,
  readJson,
  saveState,
  saveTask,
  setStatus,
  taskDir,
  taskExists,
} from './store.js';
import type { TaskResult, TaskSpec, TaskStatus } from './types.js';

const USAGE = `aio — AI orchestrator (store: ${AIO_HOME})

  aio create <task.json...> [--force]     register tasks (status: queued); merges <repo>/aio.defaults.json
  aio run [id...] [-j N] [--force]        run tasks in parallel (default: all queued/rework); one line per task
          [--verbose]                     print full review packets instead
  aio status                              list tasks with their last result
  aio show <id> [--json] [--diff]         compact review packet for the latest attempt
  aio sheet <id...> [-o file.png]         one contact sheet of the tasks' screenshots and images
  aio approve <id> [--merge]              accept; --merge merges, then runs post_merge_verify
  aio reject <id> -m "feedback"           send back for rework with feedback
  aio clean <id> [--delete-branch]        remove the task worktree
  aio context [repo]                      regenerate <repo>/.context/ACTIVE.md (also done on every event)
`;

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};

/** Task file + optional <repo>/aio.defaults.json, so specs only state what is task-specific. */
function loadWithDefaults(file: string): unknown {
  const raw = readJson<Record<string, unknown>>(file);
  if (typeof raw.repo !== 'string') return raw;
  const repo = path.resolve(path.dirname(path.resolve(file)), raw.repo);
  const defaultsFile = path.join(repo, 'aio.defaults.json');
  if (!fs.existsSync(defaultsFile)) return raw;
  const defaults = readJson<Record<string, unknown>>(defaultsFile);
  const merged: Record<string, unknown> = { ...defaults, ...raw };
  for (const key of ['codex', 'agy'] as const) {
    if (defaults[key] || raw[key]) merged[key] = { ...(defaults[key] as object), ...(raw[key] as object) };
  }
  return merged;
}

function validateTask(raw: unknown, file: string): TaskSpec {
  const t = raw as TaskSpec;
  const fail = (msg: string) => {
    throw new Error(`${file}: ${msg}`);
  };
  if (!t || typeof t !== 'object') fail('not a JSON object');
  if (typeof t.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(t.id)) fail('id must match [A-Za-z0-9._-]+');
  if (t.agent !== 'codex' && t.agent !== 'agy') fail('agent must be "codex" or "agy"');
  if (typeof t.objective !== 'string' || !t.objective.trim()) fail('objective is required');
  if (typeof t.repo !== 'string') fail('repo is required');
  for (const key of ['context', 'files', 'constraints', 'acceptance_criteria', 'setup', 'verify', 'expected_files', 'allowed_paths', 'post_merge_verify'] as const) {
    const v = t[key] as unknown;
    if (typeof v === 'string') (t as unknown as Record<string, unknown>)[key] = [v];
    else if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) fail(`${key} must be a string array`);
  }
  // Relative repo paths are relative to the task file.
  t.repo = path.resolve(path.dirname(path.resolve(file)), t.repo);
  if (!fs.existsSync(path.join(t.repo, '.git'))) fail(`repo is not a git repository: ${t.repo}`);
  return t;
}

function cmdCreate(files: string[], force: boolean): void {
  if (!files.length) throw new Error('usage: aio create <task.json...>');
  for (const file of files) {
    const task = validateTask(loadWithDefaults(file), file);
    const exists = taskExists(task.id);
    if (exists && !force) throw new Error(`${task.id} already exists; pass --force to overwrite the spec`);
    saveTask(task);
    if (!exists) {
      const state = newState(task.id);
      setStatus(state, 'queued', `created from ${path.resolve(file)}`);
    }
    recordEvent(task.repo, `${exists ? 'updated' : 'queued'} ${task.id} (${task.agent}): ${oneLine(task.objective, 120)}`);
    console.log(`${exists ? 'updated' : 'created'} ${task.id} (${task.agent})`);
  }
}

function formatSummary(r: TaskResult): string {
  const lines = [
    `${r.status === 'passed' ? 'PASS' : 'FAIL'} ${r.task_id} — attempt ${r.attempt}, ${r.files_changed.length} files, agent ${r.agent_run.duration_seconds}s`,
  ];
  for (const c of r.checks.filter((c) => !c.ok)) lines.push(`  - ${c.name}${c.detail ? `: ${oneLine(c.detail, 200)}` : ''}`);
  if (r.review) lines.push(`  review: ${r.review.verdict} — ${oneLine(r.review.summary, 200)}`);
  if (r.contact_sheet) lines.push(`  sheet: ${r.contact_sheet}`);
  return lines.join('\n');
}

async function cmdRun(ids: string[], concurrency: number, force: boolean, verbose: boolean): Promise<void> {
  const runnable: TaskStatus[] = ['queued', 'rework', 'failed'];
  const queue = ids.length ? ids : listTaskIds().filter((id) => ['queued', 'rework'].includes(loadState(id).status));
  if (!queue.length) {
    console.log('nothing to run');
    return;
  }
  for (const id of queue) {
    const s = loadState(id).status;
    if (!force && !runnable.includes(s)) throw new Error(`${id} is ${s}; pass --force to run anyway`);
  }
  const results: Array<TaskResult | Error> = [];
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const id = queue[next++];
      results.push(await runTask(id, force).catch((e: Error) => new Error(`${id}: ${e.message}`)));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  for (const r of results) {
    if (r instanceof Error) {
      console.log(`ERROR ${r.message}`);
      continue;
    }
    console.log(verbose ? formatResult(r, loadTask(r.task_id)) : formatSummary(r));
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    recordEvent(
      loadTask(r.task_id).repo,
      `ran ${r.task_id} attempt ${r.attempt}: ${r.status}${failed.length ? ` (${oneLine(failed.join('; '), 120)})` : ''}`,
    );
  }
  if (results.some((r) => r instanceof Error || r.status === 'failed')) process.exitCode = 1;
}

function cmdStatus(): void {
  const ids = listTaskIds();
  if (!ids.length) {
    console.log('no tasks');
    return;
  }
  const rows = ids.map((id) => {
    const t = loadTask(id);
    const s = loadState(id);
    const file = path.join(taskDir(id), 'result.json');
    let last = '-';
    if (fs.existsSync(file)) {
      const r = readJson<TaskResult>(file);
      const failed = r.checks.filter((c) => !c.ok).length;
      last = failed ? `${r.status} (${failed} failed)` : r.status;
    }
    return [id, t.agent, s.status, String(s.attempts), last, t.objective.slice(0, 50)];
  });
  const header = ['ID', 'AGENT', 'STATUS', 'TRIES', 'LAST', 'OBJECTIVE'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  for (const r of [header, ...rows]) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  '));
}

function formatResult(r: TaskResult, task: TaskSpec): string {
  const state = loadState(r.task_id);
  const lines = [
    `## ${r.task_id} [${state.status}] ${r.status.toUpperCase()} — ${task.agent}, attempt ${r.attempt}`,
    `objective: ${task.objective}`,
    `branch: ${state.branch}  worktree: ${state.worktree}`,
  ];
  const report = r.agent_run.report;
  if (report) {
    lines.push(`agent says (${report.status}): ${report.summary}`);
    if (report.notes) lines.push(`agent notes: ${report.notes}`);
  }
  // Passing checks without details carry no information for the reviewer; only count them.
  const quiet = r.checks.filter((c) => c.ok && !c.skipped && !c.detail);
  lines.push(`checks: ${r.checks.filter((c) => c.ok).length}/${r.checks.length} ok`);
  for (const c of r.checks.filter((c) => !quiet.includes(c))) {
    const mark = c.skipped ? 'skip' : c.ok ? ' ok ' : 'FAIL';
    lines.push(`  [${mark}] ${c.name}${c.detail ? ` — ${oneLine(c.detail, 400)}` : ''}`);
  }
  for (const c of r.commands.filter((c) => c.exit_code !== 0)) {
    lines.push(`--- output of failed "${c.command}":\n${tail(c.output_tail, 800)}`);
  }
  const stat = r.diff_stat.split(/\r?\n/);
  lines.push(`files changed vs base: ${stat[stat.length - 1]?.trim() || 'none'}`);
  if (r.contact_sheet) lines.push(`contact sheet (${r.screenshots.length} screenshots): ${r.contact_sheet}`);
  else if (r.screenshots.length) lines.push(`screenshots:\n${r.screenshots.map((s) => `  ${s}`).join('\n')}`);
  const u = r.agent_run.usage;
  if (u) lines.push(`usage: in=${u.input_tokens ?? '?'} cached=${u.cached_input_tokens ?? '?'} out=${u.output_tokens ?? '?'} time=${r.agent_run.duration_seconds}s`);
  lines.push(`artifacts: ${r.artifacts_dir}\n`);
  return lines.join('\n');
}

function latestResult(id: string): TaskResult {
  const file = path.join(taskDir(id), 'result.json');
  if (!fs.existsSync(file)) throw new Error(`${id} has no result yet (status: ${loadState(id).status})`);
  return readJson<TaskResult>(file);
}

function cmdShow(id: string, json: boolean, diff: boolean): void {
  const r = latestResult(id);
  console.log(json ? JSON.stringify(r, null, 2) : formatResult(r, loadTask(id)));
  if (diff) console.log(fs.readFileSync(path.join(r.artifacts_dir, 'diff.patch'), 'utf8'));
}

async function cmdApprove(id: string, merge: boolean, force: boolean): Promise<void> {
  const task = loadTask(id);
  const state = loadState(id);
  if (state.status !== 'review' && !force) throw new Error(`${id} is ${state.status}, not review; pass --force to approve anyway`);
  if (merge) {
    if (!state.branch) throw new Error(`${id} has no branch`);
    const subject = task.objective.length > 60 ? task.objective.slice(0, 57) + '...' : task.objective;
    await git.mergeBranch(task.repo, state.branch, `Merge ${state.branch}: ${subject}`);
    console.log(`merged ${state.branch} into the current branch of ${task.repo}`);
    // Integration problems (stale generated types, conflicting changes) only show up on the merged tree.
    for (const command of task.post_merge_verify ?? []) {
      const r = await runShell(command, { cwd: task.repo, timeoutMs: 10 * 60 * 1000 });
      if (r.code !== 0) {
        setStatus(state, 'failed', `post-merge verify failed: ${command}`);
        throw new Error(
          `merged, but "${command}" fails on the merged tree (exit ${r.code}):\n${tail((r.stdout + r.stderr).trim(), 1500)}\n` +
            `Fix forward, or undo the merge with: git -C "${task.repo}" reset --hard HEAD~1 (only if nothing was committed after it)`,
        );
      }
      console.log(`post-merge ok: ${command}`);
    }
  }
  setStatus(state, 'approved', merge ? 'merged' : undefined);
  recordEvent(task.repo, `approved ${id}${merge ? ' and merged' : ''}: ${oneLine(task.objective, 120)}`);
  if (merge) await commitContext(task.repo, `context: approve ${id}`);
  console.log(`${id} approved${merge ? '' : ` (merge later with: git -C "${task.repo}" merge --no-ff ${state.branch})`}`);
}

async function cmdSheet(ids: string[], out: string | undefined): Promise<void> {
  if (!ids.length) throw new Error('usage: aio sheet <id...> [-o file.png]');
  const files: string[] = [];
  for (const id of ids) {
    const task = loadTask(id);
    const state = loadState(id);
    const file = path.join(taskDir(id), 'result.json');
    if (fs.existsSync(file)) files.push(...readJson<TaskResult>(file).screenshots);
    // Images live in the worktree until it is cleaned, then in the repo after merge.
    const root = state.worktree && fs.existsSync(state.worktree) ? state.worktree : task.repo;
    files.push(...(task.images ?? []).map((i) => path.join(root, i.path)));
  }
  const target = path.resolve(out ?? path.join(AIO_HOME, 'sheets', `${ids.join('+').slice(0, 80)}.png`));
  const sheet = await makeContactSheet(files, target, ids.join(', '));
  console.log(sheet ? `${files.length} images -> ${sheet}` : 'nothing to show (no images, or playwright-core missing)');
}

function cmdReject(id: string, feedback: string | undefined): void {
  if (!feedback) throw new Error('reject needs -m "feedback" so the agent knows what to fix');
  const state = loadState(id);
  state.feedback.push(feedback);
  setStatus(state, 'rework', feedback);
  recordEvent(loadTask(id).repo, `rejected ${id}: ${oneLine(feedback, 160)}`);
  console.log(`${id} set to rework; run "aio run ${id}" to start the next attempt`);
}

async function cmdClean(id: string, deleteBranch: boolean): Promise<void> {
  const task = loadTask(id);
  const state = loadState(id);
  if (state.worktree && fs.existsSync(state.worktree)) await git.removeWorktree(task.repo, state.worktree);
  if (deleteBranch && state.branch) await git.deleteBranch(task.repo, state.branch);
  state.worktree = undefined;
  saveState(state);
  console.log(`${id} worktree removed${deleteBranch ? ' and branch deleted' : ''}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      force: { type: 'boolean' },
      jobs: { type: 'string', short: 'j' },
      json: { type: 'boolean' },
      diff: { type: 'boolean' },
      merge: { type: 'boolean' },
      message: { type: 'string', short: 'm' },
      'delete-branch': { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      out: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...args] = positionals;
  const force = values.force ?? false;
  const needId = () => {
    if (!args[0]) throw new Error(`usage: aio ${cmd} <id>`);
    return args[0];
  };
  switch (cmd) {
    case 'create':
      return cmdCreate(args, force);
    case 'run':
      return cmdRun(args, Math.max(1, Number(values.jobs ?? 2)), force, values.verbose ?? false);
    case 'sheet':
      return cmdSheet(args, values.out);
    case 'context': {
      const repo = path.resolve(args[0] ?? '.');
      syncActive(repo);
      console.log(`synced ${path.join(repo, '.context', 'ACTIVE.md')}`);
      return;
    }
    case 'status':
      return cmdStatus();
    case 'show':
      return cmdShow(needId(), values.json ?? false, values.diff ?? false);
    case 'approve':
      return cmdApprove(needId(), values.merge ?? false, force);
    case 'reject':
      return cmdReject(needId(), values.message);
    case 'clean':
      return cmdClean(needId(), values['delete-branch'] ?? false);
    default:
      console.log(USAGE);
      if (cmd && !values.help) process.exitCode = 1;
  }
}

main().catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
});
