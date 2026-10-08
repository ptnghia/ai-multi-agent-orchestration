import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { killTree, tail } from './exec.js';
import type { Check, ScreenshotSpec } from './types.js';

async function waitForUrl(url: string, timeoutMs: number, server: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited with code ${server.exitCode}: ${tail(log(), 800)}`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server did not respond at ${url} within ${timeoutMs / 1000}s: ${tail(log(), 800)}`);
}

export async function loadPlaywright(): Promise<any | undefined> {
  try {
    const moduleName = 'playwright-core';
    return await import(moduleName);
  } catch {
    return undefined;
  }
}

// Prefer browsers already installed on the machine so no Playwright download is needed.
export async function launchBrowser(pw: any): Promise<any> {
  const channels = [process.env.AIO_BROWSER_CHANNEL, 'msedge', 'chrome'].filter(Boolean);
  for (const channel of channels) {
    try {
      return await pw.chromium.launch({ channel });
    } catch {
      // try next
    }
  }
  return pw.chromium.launch();
}

export async function takeScreenshots(
  spec: ScreenshotSpec,
  worktree: string,
  outDir: string,
  env: Record<string, string> = {},
): Promise<{ checks: Check[]; files: string[] }> {
  const checks: Check[] = [];
  const files: string[] = [];
  const pw = await loadPlaywright();
  if (!pw) {
    return { checks: [{ name: 'screenshots', ok: true, skipped: true, detail: 'playwright-core is not installed' }], files };
  }

  let server: ChildProcess | undefined;
  let browser: any;
  try {
    if (spec.server) {
      let log = '';
      server = spawn(spec.server.command, {
        cwd: worktree,
        shell: true,
        windowsHide: true,
        env: { ...process.env, ...env, ...spec.server.env },
      });
      server.stdout?.on('data', (d) => (log += d));
      server.stderr?.on('data', (d) => (log += d));
      await waitForUrl(spec.server.url, (spec.server.timeout_seconds ?? 60) * 1000, server, () => log);
    }
    browser = await launchBrowser(pw);
    fs.mkdirSync(outDir, { recursive: true });
    for (const p of spec.pages) {
      const url = /^(https?|file):/.test(p.url) ? p.url : pathToFileURL(path.resolve(worktree, p.url)).href;
      const page = await browser.newPage({ viewport: { width: p.width ?? 1280, height: p.height ?? 800 } });
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', (m: any) => m.type() === 'error' && consoleErrors.push(m.text()));
      page.on('pageerror', (e: Error) => pageErrors.push(e.message));
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        const out = path.join(outDir, p.out);
        await page.screenshot({ path: out, fullPage: true });
        files.push(out);
        const notes = [
          ...pageErrors.map((e) => `page error: ${e}`),
          ...consoleErrors.map((e) => `console error: ${e}`),
        ];
        // Uncaught exceptions fail the check; console errors are reported for the reviewer.
        checks.push({ name: `screenshot ${p.out}`, ok: pageErrors.length === 0, ...(notes.length ? { detail: notes.join('; ') } : {}) });
      } catch (e) {
        checks.push({ name: `screenshot ${p.out}`, ok: false, detail: (e as Error).message });
      } finally {
        await page.close();
      }
    }
  } catch (e) {
    checks.push({ name: 'screenshots', ok: false, detail: (e as Error).message });
  } finally {
    await browser?.close().catch(() => {});
    if (server) killTree(server);
  }
  return { checks, files };
}
