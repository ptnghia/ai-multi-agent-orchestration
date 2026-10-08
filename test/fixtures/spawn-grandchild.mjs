// Starts a long-lived grandchild (like npx -> node dev server), records its PID, and stays alive.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
fs.writeFileSync(process.argv[2], String(grandchild.pid));
setInterval(() => {}, 1000);
