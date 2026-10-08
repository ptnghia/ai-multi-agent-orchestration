// Stand-in for `agy -p ... --output-format json` in tests. FAKE_AGY_MODE: ok | quota
import fs from 'node:fs';

const mode = process.env.FAKE_AGY_MODE ?? 'ok';

if (mode === 'quota') {
  console.log(JSON.stringify({ status: 'ERROR', error: '429 Too Many Requests: RESOURCE_EXHAUSTED (quota exceeded)' }));
  process.exit(1);
}
// agy works in its current directory (AIO starts it inside the worktree).
fs.writeFileSync('fake.txt', 'written by agy\n');
const report = { status: 'completed', summary: 'fake agy done', files_changed: ['fake.txt'], notes: '' };
console.log(
  JSON.stringify({
    status: 'SUCCESS',
    response: JSON.stringify(report),
    structured_output: report,
    usage: { input_tokens: 200, output_tokens: 20, cache_read_tokens: 100, total_tokens: 220 },
  }),
);
