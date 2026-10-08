import fs from 'node:fs';
import path from 'node:path';
import { adapters } from './adapters.js';
import { DEFAULT_COOLDOWN_MINUTES, markUnavailable, pickAgent } from './agents.js';
import { makeContactSheet } from './contact-sheet.js';
import { runShell, tail } from './exec.js';
import * as git from './git.js';
import { imageInfo } from './image.js';
import { buildPrompt, REPORT_SCHEMA } from './prompt.js';
import { runReview } from './review.js';
import { takeScreenshots } from './screenshot.js';
import { appendCost, attemptDir, loadState, loadTask, saveState, setStatus, taskDir, worktreePath, writeJson } from './store.js';
import type { AgentName, AgentRun, Check, CommandResult, Executor, TaskResult, TaskSpec, TaskState } from './types.js';
import { globToRegExp, isProcessAlive, normalizeClaim } from './util.js';

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

function log(id: string, msg: string): void {
  console.error(`${new Date().toTimeString().slice(0, 8)} [${id}] ${msg}`);
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
    const r = await runShell(command, { cwd: wt, timeoutMs: VERIFY_TIMEOUT_MS, env: task.env });
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
    const r = await runShell(command, { cwd: wt, timeoutMs: VERIFY_TIMEOUT_MS, env: task.env });
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

/** The task as a given agent runs it: the model only carries over to the agent it was written for. */
function taskFor(task: TaskSpec, agent: AgentName): TaskSpec {
  return { ...task, agent, model: task.models?.[agent] ?? (agent === task.agent ? task.model : undefined) };
}

function guardRunnable(id: string, state: TaskState, force: boolean): void {
  if (force) return;
  if (state.status === 'approved') throw new Error(`${id} is approved; pass --force to run anyway`);
  if (state.status === 'running' && isProcessAlive(state.pid) && state.pid !== process.pid) {
    throw new Error(`${id} is running in process ${state.pid}; pass --force to run anyway`);
  }
  // A 'running' task whose process died is stale and may be re-run.
}

/**
 * Runs a task to a result the orchestrator can act on:
 * - agent out of quota → mark it, continue on the fallback agent in the same worktree;
 * - every agent out → hand the task back (status `handoff`) with a brief for the orchestrator;
 * - checks failed but the agent ran → auto-retry with the failures as feedback.
 */
export async function runTask(id: string, force = false): Promise<TaskResult> {
  const task = loadTask(id);
  guardRunnable(id, loadState(id), force);
  let retries = task.auto_retries ?? 1;
  const exhausted: AgentName[] = [];

  let agent = pickAgent(task);
  if (!agent) return handoff(id, 'no execution agent is available (all out of quota)');
  let result = await runAttempt(id, agent);

  for (;;) {
    if (result.agent_run.quota_exhausted) {
      const minutes = result.agent_run.retry_after_minutes ?? DEFAULT_COOLDOWN_MINUTES;
      const until = markUnavailable(agent, minutes, result.agent_run.error ?? 'quota exhausted');
      exhausted.push(agent);
      log(id, `${agent} is out of quota until ${until.toISOString()}`);
      const next = pickAgent(task, exhausted);
      if (!next) return handoff(id, `${exhausted.join(' and ')} ran out of quota during the task`);
      const state = loadState(id);
      state.feedback.push(
        `[auto] ${agent} ran out of quota in the middle of this task. Its partial work is already in the worktree; review it and continue from there.`,
      );
      setStatus(state, 'rework', `failover ${agent} -> ${next}`);
      log(id, `failover: ${agent} -> ${next}`);
      agent = next;
      result = await runAttempt(id, agent);
      continue;
    }
    if (result.status === 'failed' && result.agent_run.ok && retries > 0) {
      retries--;
      const state = loadState(id);
      state.feedback.push(autoFeedback(result));
      setStatus(state, 'rework', 'auto-retry');
      log(id, `auto-retry on ${agent}`);
      result = await runAttempt(id, agent);
      continue;
    }
    return result;
  }
}

/** Checks the orchestrator's own work in the worktree after a handoff (or any manual edit). */
export async function verifyTask(id: string): Promise<TaskResult> {
  const state = loadState(id);
  if (!state.worktree || !fs.existsSync(state.worktree)) throw new Error(`${id} has no worktree to verify`);
  return runAttempt(id, 'manual');
}

async function handoff(id: string, reason: string): Promise<TaskResult> {
  const task = loadTask(id);
  const state = loadState(id);
  const wt = await ensureWorktree(task, state);
  const base = state.base_commit!;
  await git.stageAll(wt);
  const filesChanged = await git.diffNames(wt, base);
  const diffStat = await git.diffStat(wt, base);
  const lastPrompt = state.attempts ? path.join(attemptDir(id, state.attempts), 'prompt.md') : undefined;
  const brief = [
    `# Handoff: ${id}`,
    '',
    `Reason: ${reason}. The execution agents are unavailable, so the orchestrator should finish this task directly.`,
    '',
    `- Worktree: ${wt} (branch ${state.branch}). Work and edit there, not in the main checkout.`,
    `- Objective: ${task.objective}`,
    lastPrompt && fs.existsSync(lastPrompt) ? `- Full instructions given to the agents: ${lastPrompt}` : `- Task spec: ${path.join(taskDir(id), 'task.json')}`,
    `- Changes already in the worktree vs base (${filesChanged.length} files):`,
    '```',
    diffStat || '(none)',
    '```',
    '',
    `When done, run \`aio verify ${id}\`: it runs the same checks (verify commands, allowed_paths, files, images, screenshots, review) on the worktree.`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');
  fs.writeFileSync(path.join(taskDir(id), 'handoff.md'), brief);
  state.pid = undefined;
  setStatus(state, 'handoff', reason);
  log(id, `handoff: ${reason}`);

  const result: TaskResult = {
    task_id: id,
    attempt: state.attempts,
    agent: task.agent,
    status: 'handoff',
    finished_at: new Date().toISOString(),
    agent_run: { ok: false, exit_code: null, timed_out: false, duration_seconds: 0, error: reason, quota_exhausted: true },
    checks: [{ name: 'execution agent available', ok: false, detail: `${reason} — see ${path.join(taskDir(id), 'handoff.md')}` }],
    commands: [],
    files_changed: filesChanged,
    diff_stat: diffStat,
    screenshots: [],
    artifacts_dir: taskDir(id),
  };
  writeJson(path.join(taskDir(id), 'result.json'), result);
  return result;
}

async function runAttempt(id: string, executor: Executor): Promise<TaskResult> {
  const task = loadTask(id);
  const state = loadState(id);
  const attempt = ++state.attempts;
  const dir = attemptDir(id, attempt);
  fs.mkdirSync(dir, { recursive: true });
  state.pid = process.pid;
  setStatus(state, 'running', `attempt ${attempt} (${executor})`);

  try {
    const wt = await ensureWorktree(task, state);
    const base = state.base_commit!;
    const startHead = await git.headCommit(wt);

    let agentRun: AgentRun;
    if (executor === 'manual') {
      // The orchestrator edited the worktree directly; there is no agent run or report to check.
      agentRun = { ok: true, exit_code: 0, timed_out: false, duration_seconds: 0 };
      log(id, `attempt ${attempt}: verifying manual changes in ${wt}`);
    } else {
      const execTask = taskFor(task, executor);
      const previousStat = attempt > 1 ? await git.diffStat(wt, base) : '';
      const prompt = buildPrompt(execTask, state, attempt, previousStat);
      fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
      const schemaPath = path.join(dir, 'report.schema.json');
      writeJson(schemaPath, REPORT_SCHEMA);
      log(id, `attempt ${attempt}: running ${executor} in ${wt}`);
      const timeoutMs = (task.timeout_minutes ?? 20) * 60 * 1000;
      agentRun = await adapters[executor](execTask, { worktree: wt, attemptDir: dir, prompt, schemaPath, timeoutMs });
      log(id, `${executor} finished in ${agentRun.duration_seconds}s (ok=${agentRun.ok}${agentRun.quota_exhausted ? ', out of quota' : ''})`);
    }

    // Snapshot the work before verification can touch the tree (partial work too, so a fallback agent can continue it).
    await git.stageAll(wt);
    const attemptFiles = await git.diffNames(wt, startHead);
    const filesChanged = await git.diffNames(wt, base);
    const diffStat = await git.diffStat(wt, base);
    fs.writeFileSync(path.join(dir, 'diff.patch'), await git.diffPatch(wt, base));

    const checks = executor === 'manual' ? [] : claimChecks(agentRun, attemptFiles, wt);
    try {
      await git.commitStaged(wt, `aio: ${id} attempt ${attempt} (${executor})`);
    } catch (e) {
      checks.push({ name: 'snapshot commit', ok: false, detail: (e as Error).message });
    }

    let commands: CommandResult[] = [];
    let screenshots: string[] = [];
    let contactSheet: string | undefined;
    let review: TaskResult['review'];

    // An agent that ran out of quota is replaced, not verified: its work is unfinished by definition.
    if (!agentRun.quota_exhausted) {
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
      commands = await runVerify(task, wt, dir);
      for (const c of commands) {
        checks.push({
          name: `verify: ${c.command}`,
          ok: c.exit_code === 0 && !c.timed_out,
          ...(c.exit_code === 0 ? {} : { detail: c.timed_out ? 'timed out' : `exit ${c.exit_code}` }),
        });
      }
      checks.push(...fileChecks(task, wt));

      if (task.screenshots?.pages.length) {
        log(id, 'taking screenshots');
        const shots = await takeScreenshots(task.screenshots, wt, path.join(dir, 'screenshots'), task.env);
        checks.push(...shots.checks);
        screenshots = shots.files;
      }

      const imageFiles = (task.images ?? []).map((i) => path.join(wt, i.path));
      contactSheet = await makeContactSheet([...screenshots, ...imageFiles], path.join(dir, 'contact-sheet.png'), `${id} attempt ${attempt}`).catch(
        (e: Error) => {
          log(id, `contact sheet failed: ${e.message}`);
          return undefined;
        },
      );

      const leftovers = await git.discardUnstaged(wt);
      if (leftovers.length) checks.push({ name: 'verify side effects discarded', ok: true, detail: leftovers.join(', ') });

      // Cross-review only work that already passes the machine checks.
      if (task.review && checks.every((c) => c.ok)) {
        const reviewer = pickAgent({ ...task, agent: task.review.agent });
        if (!reviewer) {
          checks.push({ name: 'review', ok: true, skipped: true, detail: 'no reviewer agent available (quota); the orchestrator must review' });
        } else {
          log(id, `cross-review by ${reviewer}`);
          const r = await runReview({ ...task, review: { ...task.review, agent: reviewer } }, wt, base, filesChanged, dir);
          appendCost({ task: id, attempt, agent: reviewer, role: 'review', duration_seconds: r.run.duration_seconds, usage: r.run.usage });
          if (r.run.quota_exhausted) {
            markUnavailable(reviewer, r.run.retry_after_minutes ?? DEFAULT_COOLDOWN_MINUTES, r.run.error ?? 'quota exhausted');
            checks.push({ name: 'review', ok: true, skipped: true, detail: `${reviewer} ran out of quota while reviewing; the orchestrator must review` });
          } else {
            checks.push(r.check);
            review = r.verdict;
          }
          const touched = await git.discardUnstaged(wt);
          if (touched.length) checks.push({ name: 'reviewer left files untouched', ok: false, detail: touched.join(', ') });
        }
      }
    }

    const passed = !agentRun.quota_exhausted && checks.every((c) => c.ok);
    const result: TaskResult = {
      task_id: id,
      attempt,
      agent: executor,
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
    if (executor !== 'manual') {
      appendCost({
        task: id,
        attempt,
        agent: executor,
        model: taskFor(task, executor).model ?? 'default',
        duration_seconds: agentRun.duration_seconds,
        usage: agentRun.usage,
        status: agentRun.quota_exhausted ? 'quota' : result.status,
      });
    }
    state.pid = undefined;
    setStatus(state, passed ? 'review' : 'failed', `attempt ${attempt} ${agentRun.quota_exhausted ? 'out of quota' : result.status}`);
    log(id, `attempt ${attempt} ${agentRun.quota_exhausted ? 'stopped: out of quota' : result.status}`);
    return result;
  } catch (e) {
    const message = (e as Error).message;
    fs.writeFileSync(path.join(dir, 'error.txt'), (e as Error).stack ?? message);
    state.pid = undefined;
    setStatus(state, 'failed', `attempt ${attempt} error: ${message}`);
    throw e;
  }
}
