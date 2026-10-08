#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { makeContactSheet } from './contact-sheet.js';
import { commitContext, recordEvent, syncActive } from './context.js';
import { runShell, tail } from './exec.js';
import * as git from './git.js';
import { AGENTS, agentStatusLines, resetAgents } from './agents.js';
import { checkMachine, checkProject, formatFindings } from './doctor.js';
import { AIO_ROOT, aioVersion, initProject } from './init.js';
import { runTask, verifyTask } from './runner.js';
import { isProcessAlive } from './util.js';
import { AIO_HOME, listTaskIds, loadState, loadTask, newState, readJson, saveState, saveTask, setStatus, taskDir, taskExists, } from './store.js';
const USAGE = `aio — AI orchestrator (store: ${AIO_HOME})

  aio init [dir] [--force]                install the orchestration scaffold into a project (safe to re-run)
  aio doctor [dir]                        check tools, logins, quota, MCP servers and the project setup
  aio create <task.json...> [--force]     register tasks (status: queued); merges <repo>/aio.defaults.json
  aio run [id...] [-j N] [--force]        run tasks in parallel (default: all queued/rework); one line per task
          [--verbose]                     print full review packets instead
  aio status                              list tasks with their last result
  aio show <id> [--json] [--diff]         compact review packet for the latest attempt
  aio sheet <id...> [-o file.png]         one contact sheet of the tasks' screenshots and images
  aio verify <id>                         run all checks on the worktree as it is (after a handoff / manual work)
  aio agents [reset [codex|agy]]          quota status of the execution agents; reset clears cool-downs
  aio costs                               runs, time and tokens per agent and role
  aio approve <id> [--merge]              accept; --merge merges, runs post_merge_verify, removes the worktree
          [--keep-worktree]
  aio reject <id> -m "feedback"           send back for rework with feedback
  aio clean <id> [--delete-branch]        remove the task worktree
  aio delete <id>                         remove a task completely (worktree, branch, records)
  aio context [repo]                      regenerate <repo>/.context/ACTIVE.md (also done on every event)
`;
const oneLine = (s, max) => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};
/** Task file + optional <repo>/aio.defaults.json, so specs only state what is task-specific. */
function loadWithDefaults(file) {
    const raw = readJson(file);
    if (typeof raw.repo !== 'string')
        return raw;
    const repo = path.resolve(path.dirname(path.resolve(file)), raw.repo);
    const defaultsFile = path.join(repo, 'aio.defaults.json');
    if (!fs.existsSync(defaultsFile))
        return raw;
    const defaults = readJson(defaultsFile);
    const merged = { ...defaults, ...raw };
    for (const key of ['codex', 'agy']) {
        if (defaults[key] || raw[key])
            merged[key] = { ...defaults[key], ...raw[key] };
    }
    return merged;
}
function validateTask(raw, file) {
    const t = raw;
    const fail = (msg) => {
        throw new Error(`${file}: ${msg}`);
    };
    if (!t || typeof t !== 'object')
        fail('not a JSON object');
    if (typeof t.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(t.id))
        fail('id must match [A-Za-z0-9._-]+');
    if (t.agent !== 'codex' && t.agent !== 'agy')
        fail('agent must be "codex" or "agy"');
    if (t.fallback_agent !== undefined && !['codex', 'agy', 'none'].includes(t.fallback_agent)) {
        fail('fallback_agent must be "codex", "agy" or "none"');
    }
    if (t.env !== undefined && (typeof t.env !== 'object' || Object.values(t.env).some((v) => typeof v !== 'string'))) {
        fail('env must be an object of strings');
    }
    if (typeof t.objective !== 'string' || !t.objective.trim())
        fail('objective is required');
    if (typeof t.repo !== 'string')
        fail('repo is required');
    for (const key of ['context', 'files', 'constraints', 'acceptance_criteria', 'setup', 'verify', 'expected_files', 'allowed_paths', 'post_merge_verify', 'depends_on']) {
        const v = t[key];
        if (typeof v === 'string')
            t[key] = [v];
        else if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string')))
            fail(`${key} must be a string array`);
    }
    // Relative repo paths are relative to the task file.
    t.repo = path.resolve(path.dirname(path.resolve(file)), t.repo);
    if (!fs.existsSync(path.join(t.repo, '.git')))
        fail(`repo is not a git repository: ${t.repo}`);
    return t;
}
function cmdCreate(files, force) {
    if (!files.length)
        throw new Error('usage: aio create <task.json...>');
    for (const file of files) {
        const task = validateTask(loadWithDefaults(file), file);
        const exists = taskExists(task.id);
        if (exists && !force)
            throw new Error(`${task.id} already exists; pass --force to overwrite the spec`);
        assertNoCycle(task);
        const unknown = (task.depends_on ?? []).filter((d) => !taskExists(d));
        if (unknown.length)
            console.log(`note: ${task.id} depends on tasks not created yet: ${unknown.join(', ')}`);
        saveTask(task);
        if (!exists) {
            const state = newState(task.id);
            setStatus(state, 'queued', `created from ${path.resolve(file)}`);
        }
        recordEvent(task.repo, `${exists ? 'updated' : 'queued'} ${task.id} (${task.agent}): ${oneLine(task.objective, 120)}`);
        if (!task.verify?.length) {
            console.log(`warning: ${task.id} has no verify commands, so only path/file checks will judge it. Add "verify" (or fill aio.defaults.json; re-run \`aio init\` after scaffolding).`);
        }
        console.log(`${exists ? 'updated' : 'created'} ${task.id} (${task.agent})`);
    }
}
/** Dependencies of a task that are not approved yet. */
function unmetDependencies(id) {
    return (loadTask(id).depends_on ?? []).filter((d) => !taskExists(d) || loadState(d).status !== 'approved');
}
/** Rejects a dependency cycle among the registered tasks plus the one being created. */
function assertNoCycle(task) {
    const depsOf = (id) => (id === task.id ? (task.depends_on ?? []) : taskExists(id) ? (loadTask(id).depends_on ?? []) : []);
    const visit = (id, trail) => {
        if (trail.includes(id))
            throw new Error(`dependency cycle: ${[...trail, id].join(' -> ')}`);
        for (const d of depsOf(id))
            visit(d, [...trail, id]);
    };
    visit(task.id, []);
}
function formatSummary(r) {
    if (r.status === 'handoff') {
        return `HANDOFF ${r.task_id} — ${r.agent_run.error}\n  brief: ${path.join(taskDir(r.task_id), 'handoff.md')} (finish in the worktree, then: aio verify ${r.task_id})`;
    }
    const lines = [
        `${r.status === 'passed' ? 'PASS' : 'FAIL'} ${r.task_id} — attempt ${r.attempt} by ${r.agent}, ${r.files_changed.length} files, agent ${r.agent_run.duration_seconds}s`,
    ];
    for (const c of r.checks.filter((c) => !c.ok))
        lines.push(`  - ${c.name}${c.detail ? `: ${oneLine(c.detail, 200)}` : ''}`);
    for (const c of r.checks.filter((c) => c.ok && c.warn))
        lines.push(`  ! ${c.name}${c.detail ? `: ${oneLine(c.detail, 200)}` : ''}`);
    if (r.review)
        lines.push(`  review: ${r.review.verdict} — ${oneLine(r.review.summary, 200)}`);
    if (r.contact_sheet)
        lines.push(`  sheet: ${r.contact_sheet}`);
    return lines.join('\n');
}
async function cmdRun(ids, concurrency, force, verbose) {
    const auto = ['queued', 'rework'];
    let queue = ids.length ? ids : listTaskIds().filter((id) => auto.includes(loadState(id).status));
    if (!queue.length) {
        console.log('nothing to run');
        return;
    }
    // A task waits until every dependency is approved (merged), so it branches from code that contains them.
    const blocked = force ? [] : queue.filter((id) => unmetDependencies(id).length);
    for (const id of blocked) {
        const waits = unmetDependencies(id).map((d) => `${d} (${taskExists(d) ? loadState(d).status : 'not created'})`);
        console.log(`BLOCKED ${id} — waiting for ${waits.join(', ')}; approve --merge them, then run again`);
    }
    queue = queue.filter((id) => !blocked.includes(id));
    if (!queue.length)
        return;
    // runTask itself refuses approved tasks and tasks running in a live process.
    const results = [];
    let next = 0;
    const worker = async () => {
        while (next < queue.length) {
            const id = queue[next++];
            results.push(await runTask(id, force).catch((e) => new Error(`${id}: ${e.message}`)));
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
        recordEvent(loadTask(r.task_id).repo, `ran ${r.task_id} attempt ${r.attempt}: ${r.status}${failed.length ? ` (${oneLine(failed.join('; '), 120)})` : ''}`);
    }
    if (results.some((r) => r instanceof Error || r.status !== 'passed'))
        process.exitCode = 1;
}
async function cmdVerify(id) {
    const r = await verifyTask(id);
    console.log(formatSummary(r));
    recordEvent(loadTask(id).repo, `verified manual work on ${id}: ${r.status}`);
    if (r.status !== 'passed')
        process.exitCode = 1;
}
function cmdAgents(args) {
    if (args[0] === 'reset') {
        const agent = args[1];
        if (agent && !AGENTS.includes(agent))
            throw new Error(`unknown agent ${agent}`);
        resetAgents(agent);
        console.log(`reset ${agent ?? 'all agents'}`);
        return;
    }
    for (const line of agentStatusLines())
        console.log(line);
}
function cmdCosts() {
    const file = path.join(AIO_HOME, 'costs.jsonl');
    if (!fs.existsSync(file)) {
        console.log('no cost records yet');
        return;
    }
    const groups = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
        const e = JSON.parse(line);
        const key = `${e.agent} ${e.role ?? 'execute'}`;
        const g = groups.get(key) ?? { runs: 0, seconds: 0, input: 0, cached: 0, output: 0, quota: 0 };
        g.runs++;
        g.seconds += e.duration_seconds ?? 0;
        g.input += e.usage?.input_tokens ?? 0;
        g.cached += e.usage?.cached_input_tokens ?? 0;
        g.output += e.usage?.output_tokens ?? 0;
        if (e.status === 'quota')
            g.quota++;
        groups.set(key, g);
    }
    const k = (n) => `${(n / 1000).toFixed(0)}k`;
    console.log('AGENT ROLE          RUNS  TIME     INPUT    CACHED   OUTPUT  QUOTA-STOPS');
    for (const [key, g] of groups) {
        console.log(`${key.padEnd(18)}${String(g.runs).padStart(5)}  ${`${Math.round(g.seconds / 60)}m`.padStart(5)}  ${k(g.input).padStart(7)}  ${k(g.cached).padStart(7)}  ${k(g.output).padStart(7)}  ${String(g.quota).padStart(11)}`);
    }
}
function cmdStatus() {
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
            const r = readJson(file);
            const failed = r.checks.filter((c) => !c.ok).length;
            last = failed ? `${r.status} (${failed} failed)` : r.status;
        }
        const waiting = s.status === 'queued' ? unmetDependencies(id) : [];
        const status = s.status === 'running' && !isProcessAlive(s.pid) ? 'running (stale)' : waiting.length ? `blocked (${waiting.join(',')})` : s.status;
        return [id, t.agent, status, String(s.attempts), last, t.objective.slice(0, 50)];
    });
    const header = ['ID', 'AGENT', 'STATUS', 'TRIES', 'LAST', 'OBJECTIVE'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    for (const r of [header, ...rows])
        console.log(r.map((c, i) => c.padEnd(widths[i])).join('  '));
}
function formatResult(r, task) {
    const state = loadState(r.task_id);
    const lines = [
        `## ${r.task_id} [${state.status}] ${r.status.toUpperCase()} — ${task.agent}, attempt ${r.attempt}`,
        `objective: ${task.objective}`,
        `branch: ${state.branch}  worktree: ${state.worktree}`,
    ];
    const report = r.agent_run.report;
    if (report) {
        lines.push(`agent says (${report.status}): ${report.summary}`);
        if (report.notes)
            lines.push(`agent notes: ${report.notes}`);
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
    if (r.contact_sheet)
        lines.push(`contact sheet (${r.screenshots.length} screenshots): ${r.contact_sheet}`);
    else if (r.screenshots.length)
        lines.push(`screenshots:\n${r.screenshots.map((s) => `  ${s}`).join('\n')}`);
    const u = r.agent_run.usage;
    if (u)
        lines.push(`usage: in=${u.input_tokens ?? '?'} cached=${u.cached_input_tokens ?? '?'} out=${u.output_tokens ?? '?'} time=${r.agent_run.duration_seconds}s`);
    lines.push(`artifacts: ${r.artifacts_dir}\n`);
    return lines.join('\n');
}
function latestResult(id) {
    const file = path.join(taskDir(id), 'result.json');
    if (!fs.existsSync(file))
        throw new Error(`${id} has no result yet (status: ${loadState(id).status})`);
    return readJson(file);
}
function cmdShow(id, json, diff) {
    const r = latestResult(id);
    console.log(json ? JSON.stringify(r, null, 2) : formatResult(r, loadTask(id)));
    if (diff)
        console.log(fs.readFileSync(path.join(r.artifacts_dir, 'diff.patch'), 'utf8'));
}
async function cmdApprove(id, merge, force, keepWorktree) {
    const task = loadTask(id);
    const state = loadState(id);
    if (state.status !== 'review' && !force)
        throw new Error(`${id} is ${state.status}, not review; pass --force to approve anyway`);
    if (merge) {
        if (!state.branch)
            throw new Error(`${id} has no branch`);
        const subject = task.objective.length > 60 ? task.objective.slice(0, 57) + '...' : task.objective;
        await git.mergeBranch(task.repo, state.branch, `Merge ${state.branch}: ${subject}`);
        console.log(`merged ${state.branch} into the current branch of ${task.repo}`);
        // Integration problems (stale generated types, conflicting changes) only show up on the merged tree.
        for (const command of task.post_merge_verify ?? []) {
            const r = await runShell(command, { cwd: task.repo, timeoutMs: 10 * 60 * 1000, env: task.env });
            if (r.code !== 0) {
                setStatus(state, 'failed', `post-merge verify failed: ${command}`);
                throw new Error(`merged, but "${command}" fails on the merged tree (exit ${r.code}):\n${tail((r.stdout + r.stderr).trim(), 1500)}\n` +
                    `Fix forward, or undo the merge with: git -C "${task.repo}" reset --hard HEAD~1 (only if nothing was committed after it)`);
            }
            console.log(`post-merge ok: ${command}`);
        }
    }
    // A merged worktree only costs disk (node_modules); the branch keeps its history.
    if (merge && !keepWorktree && state.worktree && fs.existsSync(state.worktree)) {
        await git.removeWorktree(task.repo, state.worktree);
        state.worktree = undefined;
        console.log(`removed worktree of ${id} (branch ${state.branch} kept)`);
    }
    setStatus(state, 'approved', merge ? 'merged' : undefined);
    recordEvent(task.repo, `approved ${id}${merge ? ' and merged' : ''}: ${oneLine(task.objective, 120)}`);
    if (merge)
        await commitContext(task.repo, `context: approve ${id}`);
    console.log(`${id} approved${merge ? '' : ` (merge later with: git -C "${task.repo}" merge --no-ff ${state.branch})`}`);
}
/** Removes a task entirely (worktree, branch, records); for experiments and mistakes, not history. */
async function cmdDelete(id) {
    const task = loadTask(id);
    const state = loadState(id);
    if (state.worktree && fs.existsSync(state.worktree))
        await git.removeWorktree(task.repo, state.worktree);
    if (state.branch)
        await git.deleteBranch(task.repo, state.branch).catch(() => { });
    fs.rmSync(taskDir(id), { recursive: true, force: true });
    syncActive(task.repo);
    console.log(`${id} deleted`);
}
async function cmdDoctor(dir) {
    const machine = await checkMachine();
    console.log(formatFindings('Machine', machine));
    const repo = path.resolve(dir ?? '.');
    const isProject = dir !== undefined || ['aio.defaults.json', '.git'].some((p) => fs.existsSync(path.join(repo, p)));
    const project = isProject ? await checkProject(repo) : [];
    if (isProject)
        console.log('\n' + formatFindings(`Project ${repo}`, project));
    const all = [...machine, ...project];
    const fails = all.filter((x) => x.level === 'fail').length;
    const warns = all.filter((x) => x.level === 'warn').length;
    console.log(`\n${fails} problem(s), ${warns} warning(s)`);
    if (fails)
        process.exitCode = 1;
}
function cmdInit(dir, force) {
    const report = initProject(dir ?? '.', force);
    console.log(`AIO scaffold in ${report.repo}`);
    for (const f of report.files)
        console.log(`  ${f.action.padEnd(8)} ${f.file}${f.note ? `  (${f.note})` : ''}`);
    for (const w of report.warnings)
        console.log(`warning: ${w}`);
    const changed = report.files.some((f) => f.action !== 'kept');
    console.log(changed
        ? '\nNext: review aio.defaults.json, fill docs/PRODUCT.md and .context/DECISIONS.md, commit, then open Claude Code in this folder (see docs/GETTING-STARTED.md in the AIO repo).'
        : '\nAlready up to date.');
}
async function cmdSheet(ids, out) {
    if (!ids.length)
        throw new Error('usage: aio sheet <id...> [-o file.png]');
    const files = [];
    for (const id of ids) {
        const task = loadTask(id);
        const state = loadState(id);
        const file = path.join(taskDir(id), 'result.json');
        if (fs.existsSync(file))
            files.push(...readJson(file).screenshots);
        // Images live in the worktree until it is cleaned, then in the repo after merge.
        const root = state.worktree && fs.existsSync(state.worktree) ? state.worktree : task.repo;
        files.push(...(task.images ?? []).map((i) => path.join(root, i.path)));
    }
    const target = path.resolve(out ?? path.join(AIO_HOME, 'sheets', `${ids.join('+').slice(0, 80)}.png`));
    const sheet = await makeContactSheet(files, target, ids.join(', '));
    console.log(sheet ? `${files.length} images -> ${sheet}` : 'nothing to show (no images, or playwright-core missing)');
}
function cmdReject(id, feedback) {
    if (!feedback)
        throw new Error('reject needs -m "feedback" so the agent knows what to fix');
    const state = loadState(id);
    state.feedback.push(feedback);
    setStatus(state, 'rework', feedback);
    recordEvent(loadTask(id).repo, `rejected ${id}: ${oneLine(feedback, 160)}`);
    console.log(`${id} set to rework; run "aio run ${id}" to start the next attempt`);
}
async function cmdClean(id, deleteBranch) {
    const task = loadTask(id);
    const state = loadState(id);
    if (state.worktree && fs.existsSync(state.worktree))
        await git.removeWorktree(task.repo, state.worktree);
    if (deleteBranch && state.branch)
        await git.deleteBranch(task.repo, state.branch);
    state.worktree = undefined;
    saveState(state);
    console.log(`${id} worktree removed${deleteBranch ? ' and branch deleted' : ''}`);
}
async function main() {
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
            'keep-worktree': { type: 'boolean' },
            verbose: { type: 'boolean' },
            version: { type: 'boolean', short: 'v' },
            out: { type: 'string', short: 'o' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    const [cmd, ...args] = positionals;
    if (values.version || cmd === 'version') {
        console.log(`aio ${aioVersion()} (${AIO_ROOT})`);
        return;
    }
    const force = values.force ?? false;
    const needId = () => {
        if (!args[0])
            throw new Error(`usage: aio ${cmd} <id>`);
        return args[0];
    };
    switch (cmd) {
        case 'create':
            return cmdCreate(args, force);
        case 'run':
            return cmdRun(args, Math.max(1, Number(values.jobs ?? 2)), force, values.verbose ?? false);
        case 'sheet':
            return cmdSheet(args, values.out);
        case 'verify':
            return cmdVerify(needId());
        case 'agents':
            return cmdAgents(args);
        case 'costs':
            return cmdCosts();
        case 'delete':
            return cmdDelete(needId());
        case 'init':
            return cmdInit(args[0], force);
        case 'doctor':
            return cmdDoctor(args[0]);
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
            return cmdApprove(needId(), values.merge ?? false, force, values['keep-worktree'] ?? false);
        case 'reject':
            return cmdReject(needId(), values.message);
        case 'clean':
            return cmdClean(needId(), values['delete-branch'] ?? false);
        default:
            console.log(USAGE);
            if (cmd && !values.help)
                process.exitCode = 1;
    }
}
main().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map