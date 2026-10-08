import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentStatusLines } from './agents.js';
import { run, runCli } from './exec.js';
import { recommendedMcp } from './init.js';
import { CONTEXT7, globalAddCommand } from './mcp.js';
import { loadPlaywright } from './screenshot.js';
import { detectStack } from './stack.js';

export type Level = 'ok' | 'warn' | 'fail';
export interface Finding {
  area: string;
  level: Level;
  message: string;
  fix?: string;
}

async function cli(bin: string, args: string[], native: boolean, timeoutMs = 30_000) {
  try {
    const r = native ? await run(bin, args, { timeoutMs }) : await runCli(bin, args, { timeoutMs });
    return { ok: r.code === 0 && !r.timedOut, out: `${r.stdout}\n${r.stderr}` };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

function codexContext7Timeout(): number | undefined {
  const file = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
  if (!fs.existsSync(file)) return undefined;
  const block = /\[mcp_servers\.context7\]([\s\S]*?)(?=\n\[|$)/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
  const m = /startup_timeout_sec\s*=\s*(\d+)/.exec(block);
  return m ? Number(m[1]) : undefined;
}

/** Machine-level readiness: tools, logins, quota and the MCP servers every project benefits from. */
export async function checkMachine(): Promise<Finding[]> {
  const f: Finding[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  f.push(major >= 20 ? { area: 'node', level: 'ok', message: `Node ${process.versions.node}` } : { area: 'node', level: 'fail', message: `Node ${process.versions.node} is too old`, fix: 'Install Node 20 or newer' });

  const git = await cli('git', ['--version'], true);
  f.push(git.ok ? { area: 'git', level: 'ok', message: git.out.trim().split('\n')[0] } : { area: 'git', level: 'fail', message: 'git not found', fix: 'Install git' });

  const codex = await cli(process.env.AIO_CODEX_BIN ?? 'codex', ['login', 'status'], false);
  if (!codex.ok && /not recognized|not found|ENOENT/i.test(codex.out)) {
    f.push({ area: 'codex', level: 'warn', message: 'codex CLI not installed (AGY will be the only execution agent)', fix: 'npm install -g @openai/codex && codex login' });
  } else {
    f.push(codex.ok ? { area: 'codex', level: 'ok', message: codex.out.trim().split('\n')[0] } : { area: 'codex', level: 'fail', message: 'codex is not logged in', fix: 'codex login' });
  }

  const agy = await cli(process.env.AIO_AGY_BIN ?? 'agy', ['models'], true);
  if (!agy.ok && /not recognized|not found|ENOENT/i.test(agy.out)) {
    f.push({ area: 'agy', level: 'warn', message: 'agy CLI not installed (Codex will be the only execution agent)', fix: 'Install Antigravity CLI, then run `agy` once to log in' });
  } else {
    f.push(agy.ok ? { area: 'agy', level: 'ok', message: 'agy logged in (models reachable)' } : { area: 'agy', level: 'fail', message: 'agy cannot list models (not logged in?)', fix: 'Run `agy` interactively once to log in' });
  }

  for (const line of agentStatusLines()) {
    f.push({ area: 'quota', level: line.includes('out of quota') ? 'warn' : 'ok', message: line, ...(line.includes('out of quota') ? { fix: 'Wait, or `aio agents reset` after topping up' } : {}) });
  }

  if (codex.ok) {
    const list = await cli(process.env.AIO_CODEX_BIN ?? 'codex', ['mcp', 'list'], false);
    if (!/^context7\s/m.test(list.out)) {
      f.push({ area: 'mcp', level: 'warn', message: 'codex has no context7 MCP (up-to-date library docs)', fix: `${globalAddCommand('codex', 'context7', CONTEXT7)}, then add startup_timeout_sec = 60 under [mcp_servers.context7] in ~/.codex/config.toml` });
    } else {
      const timeout = codexContext7Timeout();
      f.push(
        timeout !== undefined && timeout >= 60
          ? { area: 'mcp', level: 'ok', message: `codex: context7 (startup timeout ${timeout}s)` }
          : { area: 'mcp', level: 'warn', message: 'codex: context7 uses the default 30 s startup timeout; the first npx download can exceed it', fix: 'Add `startup_timeout_sec = 60` under [mcp_servers.context7] in ~/.codex/config.toml' },
      );
    }
  }
  if (agy.ok) {
    const list = await cli(process.env.AIO_AGY_BIN ?? 'agy', ['mcp', 'list'], true);
    f.push(
      /^context7\s+\S+\s+enabled/m.test(list.out)
        ? { area: 'mcp', level: 'ok', message: 'agy: context7' }
        : { area: 'mcp', level: 'warn', message: 'agy has no enabled context7 MCP', fix: globalAddCommand('agy', 'context7', CONTEXT7) },
    );
  }

  const playwright = await loadPlaywright();
  f.push(playwright ? { area: 'screenshots', level: 'ok', message: 'playwright-core available' } : { area: 'screenshots', level: 'warn', message: 'playwright-core missing: screenshot checks will be skipped', fix: 'Reinstall aio (optional dependency)' });
  return f;
}

/** Project-level readiness: scaffold, quality gates and the MCP servers the stack calls for. */
export async function checkProject(repoArg: string): Promise<Finding[]> {
  const repo = path.resolve(repoArg);
  const f: Finding[] = [];
  const has = (p: string) => fs.existsSync(path.join(repo, p));
  const read = (p: string) => fs.readFileSync(path.join(repo, p), 'utf8');

  const head = await cli('git', ['-C', repo, 'rev-parse', '--verify', 'HEAD'], true);
  f.push(head.ok ? { area: 'git', level: 'ok', message: 'repository with at least one commit' } : { area: 'git', level: 'fail', message: 'not a git repository with a commit (aio run needs one)', fix: 'git init -b main && git add -A && git commit -m "Initial commit"' });

  const scaffold = ['CLAUDE.md', 'AGENTS.md', '.claude/settings.json', '.context/ACTIVE.md', 'aio.defaults.json'];
  const missing = scaffold.filter((p) => !has(p));
  f.push(missing.length ? { area: 'scaffold', level: 'fail', message: `missing ${missing.join(', ')}`, fix: 'aio init' } : { area: 'scaffold', level: 'ok', message: 'AIO scaffold present' });
  if (has('CLAUDE.md') && !read('CLAUDE.md').includes('aio:claude:begin')) f.push({ area: 'scaffold', level: 'warn', message: 'CLAUDE.md has no AIO section', fix: 'aio init' });
  if (has('.claude/settings.json') && !read('.claude/settings.json').includes('session-context.mjs')) f.push({ area: 'scaffold', level: 'warn', message: 'SessionStart context hook not configured', fix: 'aio init' });

  const stack = detectStack(repo);
  let defaults: Record<string, any> = {};
  if (has('aio.defaults.json')) {
    defaults = JSON.parse(read('aio.defaults.json'));
    f.push(defaults.verify?.length ? { area: 'defaults', level: 'ok', message: `verify: ${defaults.verify.join(' && ')}` } : { area: 'defaults', level: 'fail', message: 'aio.defaults.json has no verify commands: tasks would pass without tests', fix: stack.install ? 'aio init (fills them from package.json scripts)' : 'Set "setup" and "verify" by hand for this stack' });
  }

  const { agents, claude, notes } = recommendedMcp(stack);
  for (const n of notes) f.push({ area: 'mcp', level: 'warn', message: n });
  const claudeMcp = has('.mcp.json') ? JSON.parse(read('.mcp.json')).mcpServers ?? {} : {};
  for (const name of Object.keys(agents)) {
    f.push(defaults.mcp?.[name] ? { area: 'mcp', level: 'ok', message: `Codex gets "${name}" per run (aio.defaults.json)` } : { area: 'mcp', level: 'warn', message: `"${name}" MCP recommended for this stack but missing in aio.defaults.json`, fix: 'aio init' });
  }
  if (Object.keys(agents).length) {
    const agyList = await cli(process.env.AIO_AGY_BIN ?? 'agy', ['mcp', 'list'], true);
    for (const [name, server] of Object.entries(agents)) {
      if (agyList.ok && !new RegExp(`^${name}\\s+\\S+\\s+enabled`, 'm').test(agyList.out)) {
        f.push({ area: 'mcp', level: 'warn', message: `agy has no global "${name}" MCP (AGY cannot take project MCP config)`, fix: globalAddCommand('agy', name, server) });
      }
    }
  }
  for (const name of Object.keys(claude)) {
    f.push(claudeMcp[name] ? { area: 'mcp', level: 'ok', message: `Claude Code: "${name}" in .mcp.json${name === 'expo' ? ' (log in once via /mcp in Claude Code)' : ''}` } : { area: 'mcp', level: 'warn', message: `"${name}" MCP recommended for Claude Code but missing in .mcp.json`, fix: 'aio init' });
  }
  return f;
}

export function formatFindings(title: string, findings: Finding[]): string {
  const mark = { ok: ' ok ', warn: 'warn', fail: 'FAIL' } as const;
  const lines = [title];
  for (const x of findings) {
    lines.push(`  [${mark[x.level]}] ${x.area.padEnd(11)} ${x.message}`);
    if (x.fix && x.level !== 'ok') lines.push(`  ${''.padEnd(19)}fix: ${x.fix}`);
  }
  return lines.join('\n');
}
