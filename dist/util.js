/** Glob for allowed_paths: `**` spans directories, `*` and `?` stay within one segment, a trailing `/` allows the whole subtree. */
export function globToRegExp(glob) {
    const re = glob
        .replace(/\\/g, '/')
        .replace(/[.+^${}()|[\]]/g, '\\$&')
        .replace(/\*\*\/?/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '.*');
    return new RegExp(`^${re}${glob.endsWith('/') ? '.*' : ''}$`);
}
/** Agents report paths in many shapes (absolute, ./x, backslashes); compare them as repo-relative POSIX paths. */
export function normalizeClaim(file, worktree) {
    let f = file.replace(/\\/g, '/');
    const wt = worktree.replace(/\\/g, '/');
    if (f.toLowerCase().startsWith(wt.toLowerCase() + '/'))
        f = f.slice(wt.length + 1);
    return f.replace(/^\.\//, '');
}
export function isProcessAlive(pid) {
    if (!pid)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        // EPERM: the process exists but belongs to someone else.
        return e.code === 'EPERM';
    }
}
//# sourceMappingURL=util.js.map