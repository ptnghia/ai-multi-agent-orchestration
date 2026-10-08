import fs from 'node:fs';
import { run } from './exec.js';
async function git(cwd, args) {
    // core.longpaths: worktrees with node_modules exceed Windows' 260-char path limit.
    const r = await run('git', ['-c', 'core.quotepath=off', '-c', 'core.longpaths=true', ...args], { cwd });
    if (r.code !== 0)
        throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
}
export const resolveCommit = (repo, ref) => git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
export const headCommit = (wt) => git(wt, ['rev-parse', 'HEAD']);
export async function addWorktree(repo, wt, branch, base) {
    const exists = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo });
    if (exists.code === 0)
        await git(repo, ['worktree', 'add', wt, branch]);
    else
        await git(repo, ['worktree', 'add', '-b', branch, wt, base]);
}
export async function removeWorktree(repo, wt) {
    try {
        await git(repo, ['worktree', 'remove', '--force', wt]);
    }
    catch {
        // A failed removal can leave the directory behind but unregistered; finish the job.
        fs.rmSync(wt, { recursive: true, force: true });
        await git(repo, ['worktree', 'prune']);
    }
}
export const deleteBranch = (repo, branch) => git(repo, ['branch', '-D', branch]);
export const stageAll = (wt) => git(wt, ['add', '-A']);
/** `git status --porcelain` lines of a checkout, for spotting writes made outside an agent's worktree. */
export async function statusLines(dir) {
    const out = await git(dir, ['status', '--porcelain']);
    return out ? out.split(/\r?\n/) : [];
}
// The --cached diffs compare the index against a commit, so they work whether
// or not the snapshot commit succeeded.
export async function diffNames(wt, from) {
    const out = await git(wt, ['diff', '--cached', '--name-only', from]);
    return out ? out.split(/\r?\n/) : [];
}
export const diffStat = (wt, from) => git(wt, ['diff', '--cached', '--stat', from]);
export const diffPatch = (wt, from) => git(wt, ['diff', '--cached', from]);
/** Commits staged changes; returns false when there was nothing to commit. */
export async function commitStaged(wt, message) {
    const dirty = await run('git', ['diff', '--cached', '--quiet'], { cwd: wt });
    if (dirty.code === 0)
        return false;
    await git(wt, ['-c', 'user.name=aio', '-c', 'user.email=aio@localhost', 'commit', '-m', message]);
    return true;
}
/** Drops whatever the verify commands left behind (ignored files are kept). */
export async function discardUnstaged(wt) {
    const status = await git(wt, ['status', '--porcelain']);
    const leftovers = status ? status.split(/\r?\n/).filter((l) => l[1] !== ' ').map((l) => l.slice(3)) : [];
    if (leftovers.length) {
        await git(wt, ['checkout', '--', '.']);
        await git(wt, ['clean', '-fd']);
    }
    return leftovers;
}
/** Merges as the user when git knows who they are; on a machine without an identity, as "aio". */
export async function mergeBranch(repo, branch, message) {
    const email = await run('git', ['config', 'user.email'], { cwd: repo });
    const identity = email.code === 0 && email.stdout.trim() ? [] : ['-c', 'user.name=aio', '-c', 'user.email=aio@localhost'];
    return git(repo, [...identity, 'merge', '--no-ff', branch, '-m', message]);
}
//# sourceMappingURL=git.js.map