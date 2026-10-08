import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Isolated store for this test process; must be set before AIO modules load.
process.env.AIO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-unit-'));

const { isQuotaError, parseRetryAfterMinutes } = await import('../quota.js');
const { globToRegExp, normalizeClaim } = await import('../util.js');
const { imageInfo } = await import('../image.js');
const { candidateAgents, markUnavailable, pickAgent, resetAgents, isAvailable } = await import('../agents.js');
const { appendHistory, syncActive } = await import('../context.js');
const { runShell } = await import('../exec.js');
const { isProcessAlive } = await import('../util.js');

test('a timed-out shell command is killed with its whole process tree', async () => {
  const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/spawn-grandchild.mjs');
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-kill-')), 'pid');
  const r = await runShell(`node "${fixture}" "${pidFile}"`, { timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(isProcessAlive(grandchild), false, `grandchild ${grandchild} survived`);
});

test('quota errors are recognised for both CLIs, other failures are not', () => {
  assert.ok(isQuotaError("You've hit your usage limit. Try again in 2 days 5 hours."));
  assert.ok(isQuotaError('stream error: exceeded retry limit, last status: 429 Too Many Requests'));
  assert.ok(isQuotaError('RESOURCE_EXHAUSTED: quota exceeded for gemini-3.1-flash-image'));
  assert.ok(!isQuotaError('Your previous response was cut off because it exceeded the output token limit'));
  assert.ok(!isQuotaError('TypeError: m.divide is not a function'));
});

test('retry-after durations are parsed into minutes', () => {
  assert.equal(parseRetryAfterMinutes('Try again in 2 hours.'), 120);
  assert.equal(parseRetryAfterMinutes('try again in 2 days 5 hours'), 2 * 1440 + 300);
  assert.equal(parseRetryAfterMinutes('Rate limited, retry after 90s'), 2);
  assert.equal(parseRetryAfterMinutes('resets in 45 minutes'), 45);
  assert.equal(parseRetryAfterMinutes('quota exceeded'), undefined);
});

test('allowed_paths globs', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('public/').test('public/img/x.png'));
  assert.ok(globToRegExp('assets/images/diets/**').test('assets/images/diets/keto.jpg'));
  assert.ok(!globToRegExp('math.js').test('test.js'));
});

test('agent-reported paths are normalised against the worktree', () => {
  assert.equal(normalizeClaim('C:\\wt\\src\\a.ts', 'C:\\wt'), 'src/a.ts');
  assert.equal(normalizeClaim('./src/a.ts', '/wt'), 'src/a.ts');
});

test('image dimensions from PNG and JPEG headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-img-'));
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(768, 20);
  fs.writeFileSync(path.join(dir, 'a.png'), png);
  // SOI, APP0 (length 4), SOF0 with height 600 and width 800.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
  fs.writeFileSync(path.join(dir, 'b.jpg'), jpeg);
  assert.deepEqual(imageInfo(path.join(dir, 'a.png')), { format: 'png', width: 1024, height: 768 });
  assert.deepEqual(imageInfo(path.join(dir, 'b.jpg')), { format: 'jpeg', width: 800, height: 600 });
});

test('agent selection honours fallback, cool-downs and exclusions', () => {
  resetAgents();
  const task = { id: 't', agent: 'codex', repo: '.', objective: 'x' } as const;
  assert.deepEqual(candidateAgents(task), ['codex', 'agy']);
  assert.deepEqual(candidateAgents({ ...task, fallback_agent: 'none' }), ['codex']);
  assert.equal(pickAgent(task), 'codex');
  markUnavailable('codex', 30, 'usage limit');
  assert.equal(isAvailable('codex'), false);
  assert.equal(pickAgent(task), 'agy');
  assert.equal(pickAgent(task, ['agy']), undefined);
  assert.equal(pickAgent({ ...task, fallback_agent: 'none' }), undefined);
  resetAgents('codex');
  assert.equal(pickAgent(task), 'codex');
});

test('HISTORY rotates into history/<year>.md and ACTIVE keeps hand-written sections', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-ctx-'));
  for (let i = 1; i <= 160; i++) appendHistory(repo, `event ${i}`);
  const entries = fs.readFileSync(path.join(repo, '.context', 'HISTORY.md'), 'utf8').split('\n').filter((l) => l.startsWith('['));
  assert.equal(entries.length, 109); // rotated once at 151 down to 100, then 9 more appended
  assert.match(entries.at(-1)!, /event 160$/);
  const archived = fs.readdirSync(path.join(repo, '.context', 'history'));
  assert.equal(archived.length, 1);

  const active = path.join(repo, '.context', 'ACTIVE.md');
  fs.writeFileSync(active, '# ACTIVE\n\n## Focus\n- keep me\n');
  syncActive(repo);
  syncActive(repo);
  const text = fs.readFileSync(active, 'utf8');
  assert.match(text, /- keep me/);
  assert.equal(text.match(/aio:begin/g)?.length, 1);
});
