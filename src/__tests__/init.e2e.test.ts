import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'dist', 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-init-home-'));

function aio(args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, AIO_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const read = (repo: string, f: string) => fs.readFileSync(path.join(repo, f), 'utf8');

test('init merges into an existing project and detects its stack', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-init-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest' } }));
  fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), '');
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'expo@x': true } }));
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'This is an Expo app.\n\nExisting rules.\n');
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Team notes\n\nUse tabs.\n');

  const r = aio(['init', repo]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /merged\s+\.claude\/settings\.json/);
  assert.match(r.out, /merged\s+AGENTS\.md/);
  assert.match(r.out, /created\s+aio\.defaults\.json\s+\(setup: pnpm install --frozen-lockfile\)/);
  assert.match(r.out, /no "lint" script/);

  const settings = JSON.parse(read(repo, '.claude/settings.json'));
  assert.equal(settings.enabledPlugins['expo@x'], true);
  assert.equal(settings.hooks.SessionStart.length, 1);
  const agents = read(repo, 'AGENTS.md');
  assert.match(agents, /aio:agents:begin[\s\S]*Agent instructions[\s\S]*aio:agents:end -->\n\nThis is an Expo app\./);
  assert.match(r.out, /merged\s+CLAUDE\.md/);
  assert.match(read(repo, 'CLAUDE.md'), /aio:claude:begin[\s\S]*aio-orchestrate[\s\S]*aio:claude:end -->\n\n# Team notes\n\nUse tabs\./);
  const defaults = JSON.parse(read(repo, 'aio.defaults.json'));
  assert.deepEqual(defaults.verify, ['pnpm run typecheck', 'pnpm run test']);
  assert.deepEqual(defaults.post_merge_verify, ['pnpm run typecheck', 'pnpm run test']);
  assert.ok(fs.existsSync(path.join(repo, '.claude/skills/aio-orchestrate/SKILL.md')));
  assert.match(read(repo, '.context/ACTIVE.md'), /No open tasks\./);

  // Second run changes nothing and does not duplicate the hook or the rules.
  const again = aio(['init', repo]);
  assert.match(again.out, /Already up to date\./);
  assert.equal(JSON.parse(read(repo, '.claude/settings.json')).hooks.SessionStart.length, 1);
  assert.equal(read(repo, 'AGENTS.md').match(/aio:agents:begin/g)?.length, 1);
  assert.equal(read(repo, 'CLAUDE.md').match(/aio:claude:begin/g)?.length, 1);

  // A deleted example task is not recreated once the project has its own specs.
  fs.rmSync(path.join(repo, 'docs/tasks/EXAMPLE-01.json'));
  fs.writeFileSync(path.join(repo, 'docs/tasks/W1-01.json'), '{}');
  assert.match(aio(['init', repo]).out, /Already up to date\./);
  assert.ok(!fs.existsSync(path.join(repo, 'docs/tasks/EXAMPLE-01.json')));

  // A stale skill copy is refreshed even without --force.
  fs.writeFileSync(path.join(repo, '.claude/skills/aio-orchestrate/SKILL.md'), 'old');
  assert.match(aio(['init', repo]).out, /updated\s+\.claude\/skills\/aio-orchestrate\/SKILL\.md/);
});

test('init on a bare folder creates everything and warns about git and the stack', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-init-bare-'));
  const r = aio(['init', repo]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Not a git repository yet/);
  assert.match(r.out, /No package\.json found/);
  for (const f of ['.claude/settings.json', '.claude/hooks/session-context.mjs', '.context/DECISIONS.md', 'docs/PRODUCT.md', 'AGENTS.md', 'CLAUDE.md']) {
    assert.ok(fs.existsSync(path.join(repo, f)), f);
  }
  // Re-running on files init itself created must not stack a second AIO section.
  assert.match(aio(['init', repo]).out, /Already up to date\./);
  for (const [f, tag] of [['CLAUDE.md', 'claude'], ['AGENTS.md', 'agents']]) {
    assert.equal(read(repo, f).match(new RegExp(`aio:${tag}:begin`, 'g'))?.length, 1, f);
  }
});
