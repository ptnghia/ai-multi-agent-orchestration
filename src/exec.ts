import { spawn, type ChildProcess } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  shell?: boolean;
  /** Added to (not replacing) the current environment. */
  env?: Record<string, string>;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
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
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
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
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

export function runShell(command: string, opts: Omit<RunOptions, 'shell'> = {}): Promise<RunResult> {
  return run(command, [], { ...opts, shell: true });
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Runs a CLI that may be an npm shim (.cmd/.ps1) on Windows, which spawn()
 * cannot launch without a shell.
 */
export function runCli(bin: string, args: string[], opts: Omit<RunOptions, 'shell'> = {}): Promise<RunResult> {
  if (process.platform !== 'win32') return run(bin, args, opts);
  return runShell([bin, ...args].map(quoteArg).join(' '), opts);
}

export function tail(text: string, max = 2000): string {
  return text.length <= max ? text : '…' + text.slice(-max);
}
