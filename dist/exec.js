import { spawn, spawnSync } from 'node:child_process';
const POSIX = process.platform !== 'win32';
const live = new Set();
let cleanupInstalled = false;
/**
 * Kills a child and everything it started (shell → npx → node dev server, agent → its tools).
 * POSIX children are spawned as process-group leaders, so the whole group is signalled,
 * even when the leader itself already exited and left grandchildren behind.
 */
export function killTree(child) {
    if (child.pid === undefined)
        return;
    if (POSIX) {
        try {
            process.kill(-child.pid, 'SIGKILL');
        }
        catch {
            // group already gone
        }
        return;
    }
    if (child.exitCode !== null)
        return;
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
}
/** Detached children no longer receive the terminal's Ctrl+C, so AIO forwards it by killing them. */
function installCleanup() {
    if (cleanupInstalled)
        return;
    cleanupInstalled = true;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(signal, () => {
            for (const child of live)
                killTree(child);
            process.exit(130);
        });
    }
}
/** spawn() for anything AIO may need to stop: own process group on POSIX, tracked for Ctrl+C. */
export function spawnTracked(command, args, options) {
    installCleanup();
    const child = spawn(command, args, { ...options, detached: POSIX, windowsHide: true });
    live.add(child);
    child.on('close', () => live.delete(child));
    return child;
}
export function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const child = spawnTracked(cmd, args, {
            cwd: opts.cwd,
            shell: opts.shell ?? false,
            env: opts.env ? { ...process.env, ...opts.env } : process.env,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
        child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
        const timer = opts.timeoutMs
            ? setTimeout(() => {
                timedOut = true;
                killTree(child);
            }, opts.timeoutMs)
            : undefined;
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - start });
        });
        // Always close stdin: some CLIs (codex) otherwise wait for more input forever.
        child.stdin.on('error', () => { });
        child.stdin.end(opts.input ?? '');
    });
}
export function runShell(command, opts = {}) {
    return run(command, [], { ...opts, shell: true });
}
function quoteArg(arg) {
    return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}
/**
 * Runs a CLI that may be an npm shim (.cmd/.ps1) on Windows, which spawn()
 * cannot launch without a shell.
 */
export function runCli(bin, args, opts = {}) {
    if (process.platform !== 'win32')
        return run(bin, args, opts);
    return runShell([bin, ...args].map(quoteArg).join(' '), opts);
}
export function tail(text, max = 2000) {
    return text.length <= max ? text : '…' + text.slice(-max);
}
//# sourceMappingURL=exec.js.map