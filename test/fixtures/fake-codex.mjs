// Stand-in for `codex exec` in tests. FAKE_CODEX_MODE: ok | quota
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => args[args.indexOf(name) + 1];
const worktree = opt('-C');
const reportFile = opt('-o');
const mode = process.env.FAKE_CODEX_MODE ?? 'ok';

process.stdin.resume();
process.stdin.on('end', () => {
  if (mode === 'quota') {
    // Leave partial work behind, as a real agent cut off mid-task would.
    fs.writeFileSync(path.join(worktree, 'partial-codex.txt'), 'half done\n');
    const message = "You've hit your usage limit. Try again in 2 hours.";
    console.log(JSON.stringify({ type: 'error', message }));
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(worktree, 'fake.txt'), 'written by codex\n');
  fs.writeFileSync(reportFile, JSON.stringify({ status: 'completed', summary: 'fake codex done', files_changed: ['fake.txt'], notes: '' }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } }));
});
