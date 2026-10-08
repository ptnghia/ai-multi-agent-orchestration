import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'dist', 'cli.js');
const fixtures = path.join(root, 'test', 'fixtures');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-e2e-home-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-e2e-'));

function aio(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AIO_HOME: home,
      AIO_CODEX_BIN: path.join(fixtures, 'fake-codex.mjs'),
      AIO_AGY_BIN: path.join(fixtures, 'fake-agy.mjs'),
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const state = (id: string) => JSON.parse(fs.readFileSync(path.join(home, 'tasks', id, 'state.json'), 'utf8'));

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(work, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'check.js'), "process.exit(require('fs').existsSync('fake.txt') ? 0 : 1);\n");
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return repo;
}

function createTask(id: string, repo: string): void {
  const file = path.join(work, `${id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      id,
      agent: 'codex',
      repo,
      objective: 'Create fake.txt',
      verify: ['node check.js'],
      expected_files: ['fake.txt'],
      auto_retries: 0,
    }),
  );
  const r = aio(['create', file]);
  assert.equal(r.code, 0, r.err);
}

test('codex out of quota mid-task: agy continues in the same worktree and the task passes', () => {
  const repo = makeRepo();
  createTask('F1', repo);
  const r = aio(['run', 'F1'], { FAKE_CODEX_MODE: 'quota', FAKE_AGY_MODE: 'ok' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /PASS F1 — attempt 2 by agy/);
  assert.match(r.err, /failover: codex -> agy/);
  const s = state('F1');
  assert.equal(s.status, 'review');
  // codex's partial work was committed and is still there for agy.
  assert.ok(fs.existsSync(path.join(s.worktree, 'partial-codex.txt')));
  assert.match(aio(['agents']).out, /codex: out of quota until/);
  // The fallback agent was told about the takeover.
  const prompt = fs.readFileSync(path.join(home, 'tasks', 'F1', 'attempt-2', 'prompt.md'), 'utf8');
  assert.match(prompt, /ran out of quota in the middle of this task/);
});

test('both agents out of quota: task is handed back, then verified after manual work', () => {
  aio(['agents', 'reset']);
  const repo = makeRepo();
  createTask('F2', repo);
  const r = aio(['run', 'F2'], { FAKE_CODEX_MODE: 'quota', FAKE_AGY_MODE: 'quota' });
  assert.equal(r.code, 1);
  assert.match(r.out, /HANDOFF F2/);
  const s = state('F2');
  assert.equal(s.status, 'handoff');
  const brief = fs.readFileSync(path.join(home, 'tasks', 'F2', 'handoff.md'), 'utf8');
  assert.match(brief, /aio verify F2/);

  // The orchestrator finishes the work by hand in the worktree.
  fs.writeFileSync(path.join(s.worktree, 'fake.txt'), 'written by claude\n');
  const v = aio(['verify', 'F2']);
  assert.equal(v.code, 0, v.out + v.err);
  assert.match(v.out, /PASS F2 — attempt \d+ by manual/);
  assert.equal(state('F2').status, 'review');
});

test('with every agent still cooling down, a new task is handed back without running any agent', () => {
  // Cool-downs from the previous test are still active.
  const repo = makeRepo();
  createTask('F3', repo);
  const r = aio(['run', 'F3'], { FAKE_CODEX_MODE: 'ok', FAKE_AGY_MODE: 'ok' });
  assert.match(r.out, /HANDOFF F3 — no execution agent is available/);
  assert.equal(state('F3').attempts, 0);

  aio(['agents', 'reset']);
  const again = aio(['run', 'F3'], { FAKE_CODEX_MODE: 'ok' });
  assert.equal(again.code, 0, again.out + again.err);
  assert.match(again.out, /PASS F3 — attempt 1 by codex/);
});

test('a task left "running" by a dead process is detected as stale and can be re-run', () => {
  aio(['agents', 'reset']);
  const repo = makeRepo();
  createTask('F4', repo);
  const file = path.join(home, 'tasks', 'F4', 'state.json');
  const s = state('F4');
  fs.writeFileSync(file, JSON.stringify({ ...s, status: 'running', pid: 999999 }));
  assert.match(aio(['status']).out, /F4\s+codex\s+running \(stale\)/);
  const r = aio(['run', 'F4'], { FAKE_CODEX_MODE: 'ok' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /PASS F4/);
});

test('costs aggregates execution runs and quota stops per agent', () => {
  const r = aio(['costs']);
  assert.match(r.out, /codex execute/);
  assert.match(r.out, /agy execute/);
});
