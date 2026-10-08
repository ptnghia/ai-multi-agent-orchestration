import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';

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

const POSIX = process.platform !== 'win32';
const live = new Set<ChildProcess>();
let cleanupInstalled = false;

/**
 * Kills a child and everything it started (shell → npx → node dev server, agent → its tools).
 * POSIX children are spawned as process-group leaders, so the whole group is signalled,
 * even when the leader itself already exited and left grandchildren behind.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (POSIX) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // group already gone
    }
    return;
  }
  if (child.exitCode !== null) return;
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
}

/** Detached children no longer receive the terminal's Ctrl+C, so AIO forwards it by killing them. */
function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      for (const child of live) killTree(child);
      process.exit(130);
    });
  }
}

/** spawn() for anything AIO may need to stop: own process group on POSIX, tracked for Ctrl+C. */
export function spawnTracked(command: string, args: string[], options: SpawnOptions): ChildProcess {
  installCleanup();
  const child = spawn(command, args, { ...options, detached: POSIX, windowsHide: true });
  live.add(child);
  child.on('close', () => live.delete(child));
  return child;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
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
    child.stdout!.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr!.setEncoding('utf8').on('data', (d: string) => (stderr += d));
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
    child.stdin!.on('error', () => {});
    child.stdin!.end(opts.input ?? '');
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
