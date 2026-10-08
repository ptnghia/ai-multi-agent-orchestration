import fs from 'node:fs';
import path from 'node:path';
import { run, runCli, tail } from './exec.js';
import { codexMcpArgs } from './mcp.js';
import { isQuotaError, parseRetryAfterMinutes } from './quota.js';
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/** A .mjs/.js override (tests, wrappers) runs on this Node; anything else is launched as a CLI. */
function runAgentBin(bin, args, opts, native) {
    if (/\.(mjs|cjs|js)$/i.test(bin))
        return run(process.execPath, [bin, ...args], opts);
    return native ? run(bin, args, opts) : runCli(bin, args, opts);
}
/** Fills quota fields from error text only; a successful run is never a quota failure. */
function withQuota(result, errorText) {
    if (result.ok || !isQuotaError(errorText))
        return result;
    const minutes = parseRetryAfterMinutes(errorText);
    return { ...result, quota_exhausted: true, ...(minutes ? { retry_after_minutes: minutes } : {}) };
}
const runCodex = async (task, ctx) => {
    const reportFile = path.join(ctx.attemptDir, 'agent-report.json');
    const args = ['exec', '-C', ctx.worktree, '-s', task.codex?.sandbox ?? 'workspace-write', '--skip-git-repo-check'];
    if (task.codex?.network)
        args.push('-c', 'sandbox_workspace_write.network_access=true');
    args.push(...codexMcpArgs(task.mcp));
    args.push('--output-schema', ctx.schemaPath, '-o', reportFile, '--json');
    if (task.model)
        args.push('-m', task.model);
    args.push('-'); // prompt from stdin: avoids Windows command-line quoting and length limits
    const r = await runAgentBin(process.env.AIO_CODEX_BIN ?? 'codex', args, { cwd: ctx.worktree, input: ctx.prompt, timeoutMs: ctx.timeoutMs }, false);
    fs.writeFileSync(path.join(ctx.attemptDir, 'agent-events.jsonl'), r.stdout);
    fs.writeFileSync(path.join(ctx.attemptDir, 'agent-stderr.txt'), r.stderr);
    const usage = {};
    const failures = [];
    for (const line of r.stdout.split(/\r?\n/)) {
        const ev = parseJson(line);
        if (!ev)
            continue;
        if (ev.type === 'error' || ev.type === 'turn.failed')
            failures.push(ev.message ?? ev.error?.message ?? line);
        if (ev.type !== 'turn.completed' || !ev.usage)
            continue;
        usage.input_tokens = (usage.input_tokens ?? 0) + (ev.usage.input_tokens ?? 0);
        usage.cached_input_tokens = (usage.cached_input_tokens ?? 0) + (ev.usage.cached_input_tokens ?? 0);
        usage.output_tokens = (usage.output_tokens ?? 0) + (ev.usage.output_tokens ?? 0);
        usage.reasoning_tokens = (usage.reasoning_tokens ?? 0) + (ev.usage.reasoning_output_tokens ?? 0);
    }
    const report = fs.existsSync(reportFile) ? parseJson(fs.readFileSync(reportFile, 'utf8')) : undefined;
    const ok = r.code === 0 && !r.timedOut;
    const errorText = [...failures, r.stderr].join('\n');
    return withQuota({
        ok,
        exit_code: r.code,
        timed_out: r.timedOut,
        duration_seconds: Math.round(r.durationMs / 1000),
        report,
        usage,
        ...(ok ? {} : { error: tail(failures.join('\n') || r.stderr || r.stdout, 1500) }),
    }, errorText);
};
const runAgy = async (task, ctx) => {
    const minutes = Math.ceil(ctx.timeoutMs / 60000);
    const args = ['-p', ctx.prompt, '--output-format', 'json', '--json-schema', ctx.schemaPath, '--print-timeout', `${minutes}m`];
    if (task.agy?.skip_permissions !== false)
        args.push('--dangerously-skip-permissions');
    if (task.model)
        args.push('--model', task.model);
    // agy is a native exe; its own --print-timeout fires first, ours is the backstop.
    const r = await runAgentBin(process.env.AIO_AGY_BIN ?? 'agy', args, { cwd: ctx.worktree, timeoutMs: ctx.timeoutMs + 60000 }, true);
    fs.writeFileSync(path.join(ctx.attemptDir, 'agent-output.json'), r.stdout);
    fs.writeFileSync(path.join(ctx.attemptDir, 'agent-stderr.txt'), r.stderr);
    const out = parseJson(r.stdout.trim());
    if (out?.structured_output)
        writeReport(ctx.attemptDir, out.structured_output);
    const ok = r.code === 0 && !r.timedOut && out?.status === 'SUCCESS';
    return withQuota({
        ok,
        exit_code: r.code,
        timed_out: r.timedOut,
        duration_seconds: Math.round(r.durationMs / 1000),
        report: out?.structured_output,
        usage: out?.usage && {
            input_tokens: out.usage.input_tokens,
            cached_input_tokens: out.usage.cache_read_tokens,
            output_tokens: out.usage.output_tokens,
            reasoning_tokens: out.usage.thinking_tokens,
            total_tokens: out.usage.total_tokens,
        },
        ...(ok ? {} : { error: out?.error || tail(r.stderr || r.stdout, 1500) || `agy status ${out?.status}` }),
    }, [out?.error ?? '', r.stderr].join('\n'));
};
function writeReport(dir, report) {
    fs.writeFileSync(path.join(dir, 'agent-report.json'), JSON.stringify(report, null, 2));
}
export const adapters = { codex: runCodex, agy: runAgy };
//# sourceMappingURL=adapters.js.map