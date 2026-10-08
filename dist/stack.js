import fs from 'node:fs';
import path from 'node:path';
function readPackageJson(repo) {
    const file = path.join(repo, 'package.json');
    if (!fs.existsSync(file))
        return undefined;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
function majorOf(range) {
    const m = range ? /(\d+)/.exec(range) : null;
    return m ? Number(m[1]) : undefined;
}
/** Package manager, scripts and frameworks of a project, from its lockfile and package.json. */
export function detectStack(repo) {
    const has = (f) => fs.existsSync(path.join(repo, f));
    const pkg = readPackageJson(repo);
    const scripts = Object.keys(pkg?.scripts ?? {});
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    const frameworks = { nextMajor: deps.next ? majorOf(deps.next) : undefined, hasExpo: 'expo' in deps };
    if (has('pnpm-lock.yaml'))
        return { install: 'pnpm install --frozen-lockfile', run: (s) => `pnpm run ${s}`, scripts, ...frameworks };
    if (has('yarn.lock'))
        return { install: 'yarn install --frozen-lockfile', run: (s) => `yarn ${s}`, scripts, ...frameworks };
    if (has('bun.lock') || has('bun.lockb'))
        return { install: 'bun install --frozen-lockfile', run: (s) => `bun run ${s}`, scripts, ...frameworks };
    if (has('package-lock.json'))
        return { install: 'npm ci --no-audit --no-fund', run: (s) => `npm run ${s}`, scripts, ...frameworks };
    if (pkg)
        return { install: 'npm install --no-audit --no-fund', run: (s) => `npm run ${s}`, scripts, ...frameworks };
    return { run: (s) => s, scripts, ...frameworks };
}
//# sourceMappingURL=stack.js.map