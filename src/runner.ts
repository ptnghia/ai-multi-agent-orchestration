import fs from 'node:fs';
import path from 'node:path';
import { adapters } from './adapters.js';
import { runShell, tail } from './exec.js';
import * as git from './git.js';
import { imageInfo } from './image.js';
import { makeContactSheet } from './contact-sheet.js';
import { buildPrompt, REPORT_SCHEMA } from './prompt.js';
import { runReview } from './review.js';
import { takeScreenshots } from './screenshot.js';
import { appendCost, attemptDir, loadState, loadTask, saveState, setStatus, taskDir, worktreePath, writeJson } from './store.js';
import type { AgentRun, Check, CommandResult, TaskResult, TaskSpec, TaskState } from './types.js';

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

function log(id: string, msg: string): void {
  console.error(`${new Date().toTimeString().slice(0, 8)} [${id}] ${msg}`);
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  // A bare directory ("src/") allows everything below it.
  return new RegExp(`^${re}${glob.endsWith('/') ? '.*' : ''}$`);
}

function normalizeClaim(file: string, worktree: string): string {
  let f = file.replace(/\\/g, '/');
  const wt = worktree.replace(/\\/g, '/');
  if (f.toLowerCase().startsWith(wt.toLowerCase() + '/')) f = f.slice(wt.length + 1);
  return f.replace(/^\.\//, '');
}

async function ensureWorktree(task: TaskSpec, state: TaskState): Promise<string> {
  if (state.worktree && fs.existsSync(state.worktree)) return state.worktree;
  state.base_commit ??= await git.resolveCommit(task.repo, task.base ?? 'HEAD');
  state.branch ??= `aio/${task.id}`;
  const wt = worktreePath(task.id);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  await git.addWorktree(task.repo, wt, state.branch, state.base_commit);
  state.worktree = wt;
  saveState(state);
  for (const command of task.setup ?? []) {
    log(task.id, `setup: ${command}`);
    const r = await runShell(command, { cwd: wt, timeoutMs: VERIFY_TIMEOUT_MS });
    if (r.code !== 0) {
      // Drop the half-prepared worktree so the next run sets it up again.
      await git.removeWorktree(task.repo, wt).catch(() => {});
      state.worktree = undefined;
      saveState(state);
      throw new Error(`setup "${command}" failed (exit ${r.code}): ${tail(r.stderr || r.stdout, 800)}`);
    }
  }
  return wt;
}

async function runVerify(task: TaskSpec, wt: string, dir: string): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const [i, command] of (task.verify ?? []).entries()) {
    const r = await runShell(command, { cwd: wt, timeoutMs: VERIFY_TIMEOUT_MS });
    const output = r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '');
    fs.writeFileSync(path.join(dir, `verify-${i + 1}.log`), `$ ${command}\n${output}`);
    results.push({
      command,
      exit_code: r.code,
      timed_out: r.timedOut,
      duration_seconds: Math.round(r.durationMs / 1000),
      output_tail: tail(output.trim(), 1500),
    });
  }
  return results;
}

function fileChecks(task: TaskSpec, wt: string): Check[] {
  const checks: Check[] = [];
  for (const f of task.expected_files ?? []) {
    const ok = fs.existsSync(path.join(wt, f));
    checks.push({ name: `file exists: ${f}`, ok, ...(ok ? {} : { detail: 'missing' }) });
  }
  for (const img of task.images ?? []) {
    const file = path.join(wt, img.path);
    if (!fs.existsSync(file)) {
      checks.push({ name: `image: ${img.path}`, ok: false, detail: 'missing' });
      continue;
    }
    const info = imageInfo(file);
    if (!info) {
      checks.push({ name: `image: ${img.path}`, ok: false, detail: 'not a readable PNG/JPEG' });
      continue;
    }
    const sizeOk = (!img.width || info.width === img.width) && (!img.height || info.height === img.height);
    checks.push({ name: `image: ${img.path}`, ok: sizeOk, detail: `${info.format} ${info.width}x${info.height}` });
  }
  return checks;
}

function claimChecks(agentRun: AgentRun, attemptFiles: string[], wt: string): Check[] {
  const checks: Check[] = [
    {
      name: 'agent process',
      ok: agentRun.ok,
      ...(agentRun.ok ? {} : { detail: agentRun.timed_out ? 'timed out' : agentRun.error }),
    },
  ];
  const report = agentRun.report;
  if (!report) {
    checks.push({ name: 'agent report', ok: false, detail: 'no structured report returned' });
    return checks;
  }
  checks.push({ name: 'agent reports completed', ok: report.status === 'completed', detail: report.status });
  const claimed = new Set(report.files_changed.map((f) => normalizeClaim(f, wt)));
  const actual = new Set(attemptFiles);
  const falseClaims = [...claimed].filter((f) => !actual.has(f));
  const unreported = [...actual].filter((f) => !claimed.has(f));
  checks.push({
    name: 'claimed changes exist',
    ok: falseClaims.length === 0,
    ...(falseClaims.length ? { detail: `claimed but unchanged: ${falseClaims.join(', ')}` } : {}),
  });
  if (unreported.length) {
    checks.push({ name: 'unreported changes', ok: true, detail: unreported.join(', ') });
  }
  return checks;
}

/** Turns failed checks into rework feedback the agent can act on without a human. */
function autoFeedback(result: TaskResult): string {
  const failed = result.checks.filter((c) => !c.ok).map((c) => `- ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  const outputs = result.commands
    .filter((c) => c.exit_code !== 0)
    .map((c) => `Output of "${c.command}":\n${tail(c.output_tail, 1200)}`);
  return [`[auto] Attempt ${result.attempt} failed these checks; fix them:`, ...failed, ...outputs].join('\n');
}

/**
 * Runs attempts until the checks pass or the auto-retry budget is spent, so
 * mechanical failures never need the orchestrator's attention.
 */
export async function runTask(id: string, force = false): Promise<TaskResult> {
  const task = loadTask(id);
  const retries = task.auto_retries ?? 1;
  let result = await runAttempt(id, force);
  for (let i = 0; i < retries && result.status === 'failed' && result.agent_run.ok; i++) {
    const state = loadState(id);
    state.feedback.push(autoFeedback(result));
    setStatus(state, 'rework', 'auto-retry');
    log(id, `auto-retry ${i + 1}/${retries}`);
    result = await runAttempt(id, false);
  }
  return result;
}

async function runAttempt(id: string, force: boolean): Promise<TaskResult> {
  const task = loadTask(id);
  const state = loadState(id);
  if ((state.status === 'running' || state.status === 'approved') && !force) {
    throw new Error(`${id} is ${state.status}; pass --force to run anyway`);
  }
  const attempt = ++state.attempts;
  const dir = attemptDir(id, attempt);
  fs.mkdirSync(dir, { recursive: true });
  setStatus(state, 'running', `attempt ${attempt}`);

  try {
    const wt = await ensureWorktree(task, state);
    const base = state.base_commit!;
    const startHead = await git.headCommit(wt);
    const previousStat = attempt > 1 ? await git.diffStat(wt, base) : '';
    const prompt = buildPrompt(task, state, attempt, previousStat);
    fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
    const schemaPath = path.join(dir, 'report.schema.json');
    writeJson(schemaPath, REPORT_SCHEMA);

    log(id, `attempt ${attempt}: running ${task.agent} in ${wt}`);
    const timeoutMs = (task.timeout_minutes ?? 20) * 60 * 1000;
    const agentRun = await adapters[task.agent](task, { worktree: wt, attemptDir: dir, prompt, schemaPath, timeoutMs });
    log(id, `${task.agent} finished in ${agentRun.duration_seconds}s (ok=${agentRun.ok})`);

    // Snapshot the agent's work before verification can touch the tree.
    await git.stageAll(wt);
    const attemptFiles = await git.diffNames(wt, startHead);
    const filesChanged = await git.diffNames(wt, base);
    const diffStat = await git.diffStat(wt, base);
    fs.writeFileSync(path.join(dir, 'diff.patch'), await git.diffPatch(wt, base));

    const checks = claimChecks(agentRun, attemptFiles, wt);
    try {
      await git.commitStaged(wt, `aio: ${id} attempt ${attempt}`);
    } catch (e) {
      checks.push({ name: 'snapshot commit', ok: false, detail: (e as Error).message });
    }

    if (task.allowed_paths?.length) {
      const patterns = task.allowed_paths.map(globToRegExp);
      const outside = filesChanged.filter((f) => !patterns.some((re) => re.test(f)));
      checks.push({
        name: 'changes within allowed_paths',
        ok: outside.length === 0,
        ...(outside.length ? { detail: outside.join(', ') } : {}),
      });
    }

    log(id, `verifying (${task.verify?.length ?? 0} commands)`);
    const commands = await runVerify(task, wt, dir);
    for (const c of commands) {
      checks.push({
        name: `verify: ${c.command}`,
        ok: c.exit_code === 0 && !c.timed_out,
        ...(c.exit_code === 0 ? {} : { detail: c.timed_out ? 'timed out' : `exit ${c.exit_code}` }),
      });
    }
    checks.push(...fileChecks(task, wt));

    let screenshots: string[] = [];
    if (task.screenshots?.pages.length) {
      log(id, 'taking screenshots');
      const shots = await takeScreenshots(task.screenshots, wt, path.join(dir, 'screenshots'));
      checks.push(...shots.checks);
      screenshots = shots.files;
    }

    const imageFiles = (task.images ?? []).map((i) => path.join(wt, i.path));
    const contactSheet = await makeContactSheet(
      [...screenshots, ...imageFiles],
      path.join(dir, 'contact-sheet.png'),
      `${id} attempt ${attempt}`,
    ).catch((e: Error) => {
      log(id, `contact sheet failed: ${e.message}`);
      return undefined;
    });

    const leftovers = await git.discardUnstaged(wt);
    if (leftovers.length) checks.push({ name: 'verify side effects discarded', ok: true, detail: leftovers.join(', ') });

    // Cross-review only work that already passes the machine checks.
    let review: TaskResult['review'];
    if (task.review && checks.every((c) => c.ok)) {
      log(id, `cross-review by ${task.review.agent}`);
      const r = await runReview(task, wt, base, filesChanged, dir);
      checks.push(r.check);
      review = r.verdict;
      appendCost({ task: id, attempt, agent: task.review.agent, role: 'review', duration_seconds: r.run.duration_seconds, usage: r.run.usage });
      const touched = await git.discardUnstaged(wt);
      if (touched.length) checks.push({ name: 'reviewer left files untouched', ok: false, detail: touched.join(', ') });
    }

    const passed = checks.every((c) => c.ok);
    const result: TaskResult = {
      task_id: id,
      attempt,
      agent: task.agent,
      status: passed ? 'passed' : 'failed',
      finished_at: new Date().toISOString(),
      agent_run: agentRun,
      checks,
      commands,
      files_changed: filesChanged,
      diff_stat: diffStat,
      screenshots,
      ...(contactSheet ? { contact_sheet: contactSheet } : {}),
      ...(review ? { review } : {}),
      artifacts_dir: dir,
    };
    writeJson(path.join(dir, 'result.json'), result);
    writeJson(path.join(taskDir(id), 'result.json'), result);
    appendCost({
      task: id,
      attempt,
      agent: task.agent,
      model: task.model ?? 'default',
      duration_seconds: agentRun.duration_seconds,
      usage: agentRun.usage,
      status: result.status,
    });
    setStatus(state, passed ? 'review' : 'failed', `attempt ${attempt} ${result.status}`);
    log(id, `attempt ${attempt} ${result.status}`);
    return result;
  } catch (e) {
    const message = (e as Error).message;
    fs.writeFileSync(path.join(dir, 'error.txt'), (e as Error).stack ?? message);
    setStatus(state, 'failed', `attempt ${attempt} error: ${message}`);
    throw e;
  }
}
