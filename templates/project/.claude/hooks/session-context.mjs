// SessionStart hook: orients every new Claude session from the repo-local
// project memory in .context/, so no session depends on chat history.
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const ctx = path.join(root, '.context');
const read = (name) => {
  try {
    return fs.readFileSync(path.join(ctx, name), 'utf8').trim();
  } catch {
    return '';
  }
};

const history = read('HISTORY.md')
  .split(/\r?\n/)
  .filter((line) => line.startsWith('['))
  .slice(-5)
  .join('\n');

const parts = [
  '# Project context (auto-loaded from .context/ by the SessionStart hook)',
  read('ACTIVE.md'),
  read('DECISIONS.md'),
  history && `## Last 5 history entries\n${history}`,
].filter(Boolean);

if (parts.length > 1) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
    }),
  );
}
