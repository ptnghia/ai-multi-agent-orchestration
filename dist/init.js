import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncActive } from './context.js';
/** Root of the AIO install (dist/ is one level below it). */
export const AIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function aioVersion() {
    return JSON.parse(fs.readFileSync(path.join(AIO_ROOT, 'package.json'), 'utf8')).version;
}
const TEMPLATE_DIR = path.join(AIO_ROOT, 'templates', 'project');
const SKILL_FILE = path.join(AIO_ROOT, 'skills', 'aio-orchestrate', 'SKILL.md');
const HOOK_SCRIPT = 'session-context.mjs';
/** Files the project may already own: AIO keeps its part between markers and never touches the rest. */
const MARKED_FILES = { 'AGENTS.md': 'agents', 'CLAUDE.md': 'claude' };
function listFiles(dir, base = dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
    });
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
/** Adds the SessionStart context hook unless an equivalent one is already configured. */
function mergeSettings(target, template) {
    const current = readJson(target);
    const hookGroup = readJson(template).hooks.SessionStart[0];
    const existing = current.hooks?.SessionStart ?? [];
    const present = existing.some((g) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes(HOOK_SCRIPT)));
    if (present)
        return 'kept';
    current.hooks = { ...(current.hooks ?? {}), SessionStart: [...existing, hookGroup] };
    writeJson(target, current);
    return 'merged';
}
/** Puts the AIO section at the top of an existing file between markers, so re-runs can refresh it. */
function mergeMarkedSection(target, template, tag) {
    const begin = `<!-- aio:${tag}:begin -->`;
    const endMarker = `<!-- aio:${tag}:end -->`;
    const section = `${begin}\n${fs.readFileSync(template, 'utf8').trim()}\n${endMarker}`;
    const text = fs.readFileSync(target, 'utf8');
    const start = text.indexOf(begin);
    const end = text.indexOf(endMarker);
    if (start !== -1 && end > start) {
        const next = text.slice(0, start) + section + text.slice(end + endMarker.length);
        if (next === text)
            return 'kept';
        fs.writeFileSync(target, next);
        return 'updated';
    }
    fs.writeFileSync(target, text.trim() ? `${section}\n\n${text}` : `${section}\n`);
    return 'merged';
}
const hasTaskSpecs = (dir) => fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.json'));
function detectStack(repo) {
    const has = (f) => fs.existsSync(path.join(repo, f));
    const pkgFile = path.join(repo, 'package.json');
    const scripts = has('package.json') ? Object.keys(readJson(pkgFile).scripts ?? {}) : [];
    if (has('pnpm-lock.yaml'))
        return { install: 'pnpm install --frozen-lockfile', run: (s) => `pnpm run ${s}`, scripts };
    if (has('yarn.lock'))
        return { install: 'yarn install --frozen-lockfile', run: (s) => `yarn ${s}`, scripts };
    if (has('bun.lock') || has('bun.lockb'))
        return { install: 'bun install --frozen-lockfile', run: (s) => `bun run ${s}`, scripts };
    if (has('package-lock.json'))
        return { install: 'npm ci --no-audit --no-fund', run: (s) => `npm run ${s}`, scripts };
    if (has('package.json'))
        return { install: 'npm install --no-audit --no-fund', run: (s) => `npm run ${s}`, scripts };
    return { run: (s) => s, scripts };
}
/** Fills setup/verify from the project's real package manager and scripts. */
function writeDefaults(target, template, stack, warnings) {
    const defaults = readJson(template);
    defaults.setup = stack.install ? [stack.install] : [];
    const gates = ['typecheck', 'lint', 'test'].filter((s) => stack.scripts.includes(s));
    defaults.verify = gates.map(stack.run);
    defaults.post_merge_verify = gates.filter((s) => s !== 'lint').map(stack.run);
    const missing = ['typecheck', 'lint', 'test'].filter((s) => !stack.scripts.includes(s));
    if (!stack.install) {
        warnings.push('No package.json found: set "setup" and "verify" in aio.defaults.json for this stack by hand.');
    }
    else if (missing.length) {
        warnings.push(`package.json has no ${missing.map((s) => `"${s}"`).join(', ')} script; add them (and make them pass) or edit "verify" in aio.defaults.json.`);
    }
    writeJson(target, defaults);
}
/** Installs the AIO orchestration scaffold into a project; safe to re-run. */
export function initProject(repoArg, force = false) {
    const repo = path.resolve(repoArg);
    if (!fs.existsSync(repo))
        throw new Error(`directory does not exist: ${repo}`);
    const report = { repo, files: [], warnings: [] };
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
        }
        else if (name.startsWith('docs/tasks/') && !exists && hasTaskSpecs(path.dirname(target))) {
            // The example is only a starting point; a project with real specs does not need it back.
            report.files.push({ file: name, action: 'kept', note: 'skipped: project already has task specs' });
        }
        else if (MARKED_FILES[name] && (exists || !force)) {
            // Fresh files get the markers too, so later runs recognise the AIO section instead of adding another.
            if (!exists)
                fs.writeFileSync(target, '');
            const action = mergeMarkedSection(target, source, MARKED_FILES[name]);
            report.files.push({ file: name, action: exists ? action : 'created', note: 'AIO section' });
        }
        else if (name === 'aio.defaults.json' && (!exists || force)) {
            writeDefaults(target, source, stack, report.warnings);
            report.files.push({ file: name, action: exists ? 'updated' : 'created', note: stack.install ? `setup: ${stack.install}` : undefined });
        }
        else if (!exists || force) {
            fs.copyFileSync(source, target);
            report.files.push({ file: name, action: exists ? 'updated' : 'created' });
        }
        else {
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
    }
    else {
        report.files.push({ file: '.claude/skills/aio-orchestrate/SKILL.md', action: 'kept' });
    }
    syncActive(repo);
    return report;
}
//# sourceMappingURL=init.js.map