import { spawn } from 'node:child_process';
export function killTree(child) {
    if (child.pid === undefined || child.exitCode !== null)
        return;
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    }
    else {
        child.kill('SIGKILL');
    }
}
export function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            shell: opts.shell ?? false,
            windowsHide: true,
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