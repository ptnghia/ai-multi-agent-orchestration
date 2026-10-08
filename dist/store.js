import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/** One store for every project, so `aio` behaves the same from any directory. */
export const AIO_HOME = path.resolve(process.env.AIO_HOME ?? path.join(os.homedir(), '.aio'));
export const taskDir = (id) => path.join(AIO_HOME, 'tasks', id);
export const attemptDir = (id, n) => path.join(taskDir(id), `attempt-${n}`);
export const worktreePath = (id) => path.join(AIO_HOME, 'worktrees', id);
export function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
export function taskExists(id) {
    return fs.existsSync(path.join(taskDir(id), 'task.json'));
}
export function loadTask(id) {
    if (!taskExists(id))
        throw new Error(`Unknown task ${id}`);
    return readJson(path.join(taskDir(id), 'task.json'));
}
export function saveTask(task) {
    writeJson(path.join(taskDir(task.id), 'task.json'), task);
}
export function loadState(id) {
    return readJson(path.join(taskDir(id), 'state.json'));
}
export function saveState(state) {
    state.updated_at = new Date().toISOString();
    writeJson(path.join(taskDir(state.id), 'state.json'), state);
}
export function setStatus(state, status, note) {
    state.status = status;
    state.history.push({ at: new Date().toISOString(), status, ...(note ? { note } : {}) });
    saveState(state);
}
export function newState(id) {
    return { id, status: 'queued', attempts: 0, feedback: [], updated_at: '', history: [] };
}
export function listTaskIds() {
    const dir = path.join(AIO_HOME, 'tasks');
    if (!fs.existsSync(dir))
        return [];
    return fs.readdirSync(dir).filter(taskExists).sort();
}
export function appendCost(entry) {
    const file = path.join(AIO_HOME, 'costs.jsonl');
    fs.mkdirSync(AIO_HOME, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}
//# sourceMappingURL=store.js.map