import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncActive } from './context.js';

/** Root of the AIO install (dist/ is one level below it). */
const AIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = path.join(AIO_ROOT, 'templates', 'project');
const SKILL_FILE = path.join(AIO_ROOT, 'skills', 'aio-orchestrate', 'SKILL.md');
const HOOK_SCRIPT = 'session-context.mjs';
/** Files the project may already own: AIO keeps its part between markers and never touches the rest. */
const MARKED_FILES: Record<string, string> = { 'AGENTS.md': 'agents', 'CLAUDE.md': 'claude' };

export type InitAction = 'created' | 'merged' | 'updated' | 'kept';
export interface InitReport {
  repo: string;
  files: { file: string; action: InitAction; note?: string }[];
  warnings: string[];
}

function listFiles(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  });
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
const writeJson = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

/** Adds the SessionStart context hook unless an equivalent one is already configured. */
function mergeSettings(target: string, template: string): InitAction {
  const current = readJson(target);
  const hookGroup = readJson(template).hooks.SessionStart[0];
  const existing: any[] = current.hooks?.SessionStart ?? [];
  const present = existing.some((g) => (g.hooks ?? []).some((h: any) => String(h.command ?? '').includes(HOOK_SCRIPT)));
  if (present) return 'kept';
  current.hooks = { ...(current.hooks ?? {}), SessionStart: [...existing, hookGroup] };
  writeJson(target, current);
  return 'merged';
}

/** Puts the AIO section at the top of an existing file between markers, so re-runs can refresh it. */
function mergeMarkedSection(target: string, template: string, tag: string): InitAction {
  const begin = `<!-- aio:${tag}:begin -->`;
  const endMarker = `<!-- aio:${tag}:end -->`;
  const section = `${begin}\n${fs.readFileSync(template, 'utf8').trim()}\n${endMarker}`;
  const text = fs.readFileSync(target, 'utf8');
  const start = text.indexOf(begin);
  const end = text.indexOf(endMarker);
  if (start !== -1 && end > start) {
    const next = text.slice(0, start) + section + text.slice(end + endMarker.length);
    if (next === text) return 'kept';
    fs.writeFileSync(target, next);
    return 'updated';
  }
  fs.writeFileSync(target, `${section}\n\n${text}`);
  return 'merged';
}

interface Stack {
  install?: string;
  run: (script: string) => string;
  scripts: string[];
}

function detectStack(repo: string): Stack {
  const has = (f: string) => fs.existsSync(path.join(repo, f));
  const pkgFile = path.join(repo, 'package.json');
  const scripts = has('package.json') ? Object.keys(readJson(pkgFile).scripts ?? {}) : [];
  if (has('pnpm-lock.yaml')) return { install: 'pnpm install --frozen-lockfile', run: (s) => `pnpm run ${s}`, scripts };
  if (has('yarn.lock')) return { install: 'yarn install --frozen-lockfile', run: (s) => `yarn ${s}`, scripts };
  if (has('bun.lock') || has('bun.lockb')) return { install: 'bun install --frozen-lockfile', run: (s) => `bun run ${s}`, scripts };
  if (has('package-lock.json')) return { install: 'npm ci --no-audit --no-fund', run: (s) => `npm run ${s}`, scripts };
  if (has('package.json')) return { install: 'npm install --no-audit --no-fund', run: (s) => `npm run ${s}`, scripts };
  return { run: (s) => s, scripts };
}

/** Fills setup/verify from the project's real package manager and scripts. */
function writeDefaults(target: string, template: string, stack: Stack, warnings: string[]): void {
  const defaults = readJson(template);
  defaults.setup = stack.install ? [stack.install] : [];
  const gates = ['typecheck', 'lint', 'test'].filter((s) => stack.scripts.includes(s));
  defaults.verify = gates.map(stack.run);
  defaults.post_merge_verify = gates.filter((s) => s !== 'lint').map(stack.run);
  const missing = ['typecheck', 'lint', 'test'].filter((s) => !stack.scripts.includes(s));
  if (!stack.install) {
    warnings.push('No package.json found: set "setup" and "verify" in aio.defaults.json for this stack by hand.');
  } else if (missing.length) {
    warnings.push(`package.json has no ${missing.map((s) => `"${s}"`).join(', ')} script; add them (and make them pass) or edit "verify" in aio.defaults.json.`);
  }
  writeJson(target, defaults);
}

/** Installs the AIO orchestration scaffold into a project; safe to re-run. */
export function initProject(repoArg: string, force = false): InitReport {
  const repo = path.resolve(repoArg);
  if (!fs.existsSync(repo)) throw new Error(`directory does not exist: ${repo}`);
  const report: InitReport = { repo, files: [], warnings: [] };
  if (!fs.existsSync(path.join(repo, '.git'))) {
    report.warnings.push('Not a git repository yet: run `git init -b main` and make a first commit before `aio run`.');
  }
  const stack = detectStack(repo);

  for (const rel of listFiles(TEMPLATE_DIR)) {
    const source = path.join(TEMPLATE_DIR, rel);
    const target = path.join(repo, rel);
    const name = rel.replace(/\\/g, '/');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const exists = fs.existsSync(target);

    if (name === '.claude/settings.json' && exists) {
      report.files.push({ file: name, action: mergeSettings(target, source), note: 'SessionStart hook' });
    } else if (MARKED_FILES[name] && exists) {
      report.files.push({ file: name, action: mergeMarkedSection(target, source, MARKED_FILES[name]), note: 'AIO section' });
    } else if (name === 'aio.defaults.json' && (!exists || force)) {
      writeDefaults(target, source, stack, report.warnings);
      report.files.push({ file: name, action: exists ? 'updated' : 'created', note: stack.install ? `setup: ${stack.install}` : undefined });
    } else if (!exists || force) {
      fs.copyFileSync(source, target);
      report.files.push({ file: name, action: exists ? 'updated' : 'created' });
    } else {
      report.files.push({ file: name, action: 'kept' });
    }
  }

  // The playbook belongs to AIO, so it is always refreshed to the installed version.
  const skillTarget = path.join(repo, '.claude', 'skills', 'aio-orchestrate', 'SKILL.md');
  const skill = fs.readFileSync(SKILL_FILE, 'utf8');
  const skillExists = fs.existsSync(skillTarget);
  if (!skillExists || fs.readFileSync(skillTarget, 'utf8') !== skill) {
    fs.mkdirSync(path.dirname(skillTarget), { recursive: true });
    fs.writeFileSync(skillTarget, skill);
    report.files.push({ file: '.claude/skills/aio-orchestrate/SKILL.md', action: skillExists ? 'updated' : 'created' });
  } else {
    report.files.push({ file: '.claude/skills/aio-orchestrate/SKILL.md', action: 'kept' });
  }

  syncActive(repo);
  return report;
}
