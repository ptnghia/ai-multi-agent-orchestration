/**
 * MCP servers AIO knows how to recommend. Verified headless (2026-10-08):
 * - context7 works in `codex exec` and `agy -p` (install globally; codex needs startup_timeout_sec >= 60
 *   because the first npx download outlasts the 30 s handshake);
 * - next-devtools tools need default_tools_approval_mode = "approve" in `codex exec`, otherwise
 *   every call fails with "requires approval, but approval policy is never".
 */
export const CONTEXT7 = { command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
export const NEXT_DEVTOOLS = { command: 'npx', args: ['-y', 'next-devtools-mcp@latest'] };
export const EXPO_MCP = { url: 'https://mcp.expo.dev/mcp' };
const toml = (value) => JSON.stringify(value);
/** `-c` overrides that enable a project's MCP servers for one `codex exec` run, pre-approved. */
export function codexMcpArgs(servers) {
    const args = [];
    for (const [name, s] of Object.entries(servers ?? {})) {
        const key = `mcp_servers.${name}`;
        if (s.url)
            args.push('-c', `${key}.url=${toml(s.url)}`);
        else if (s.command) {
            args.push('-c', `${key}.command=${toml(s.command)}`, '-c', `${key}.args=${toml(s.args ?? [])}`);
            if (s.env && Object.keys(s.env).length) {
                const table = Object.entries(s.env).map(([k, v]) => `${k} = ${toml(v)}`).join(', ');
                args.push('-c', `${key}.env={ ${table} }`);
            }
        }
        else
            continue;
        args.push('-c', `${key}.startup_timeout_sec=90`, '-c', `${key}.default_tools_approval_mode="approve"`);
    }
    return args;
}
/** Entry for Claude Code's project `.mcp.json`; native Windows needs `cmd /c` to launch npx. */
export function claudeMcpEntry(s) {
    if (s.url)
        return { type: 'http', url: s.url };
    if (process.platform === 'win32' && s.command === 'npx') {
        return { command: 'cmd', args: ['/c', 'npx', ...(s.args ?? [])], ...(s.env ? { env: s.env } : {}) };
    }
    return { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) };
}
/** Shell command that installs a server globally for an agent CLI. */
export function globalAddCommand(agent, name, s) {
    if (agent === 'codex') {
        return s.url ? `codex mcp add ${name} --url ${s.url}` : `codex mcp add ${name} -- ${[s.command, ...(s.args ?? [])].join(' ')}`;
    }
    return `agy mcp add ${name} ${s.url ?? [s.command, ...(s.args ?? [])].join(' ')}`;
}
//# sourceMappingURL=mcp.js.map