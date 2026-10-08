import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskSpec, TaskState, TaskStatus } from './types.js';

/** One store for every project, so `aio` behaves the same from any directory. */
export const AIO_HOME = path.resolve(process.env.AIO_HOME ?? path.join(os.homedir(), '.aio'));

export const taskDir = (id: string) => path.join(AIO_HOME, 'tasks', id);
export const attemptDir = (id: string, n: number) => path.join(taskDir(id), `attempt-${n}`);
export const worktreePath = (id: string) => path.join(AIO_HOME, 'worktrees', id);

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function taskExists(id: string): boolean {
  return fs.existsSync(path.join(taskDir(id), 'task.json'));
}

export function loadTask(id: string): TaskSpec {
  if (!taskExists(id)) throw new Error(`Unknown task ${id}`);
  return readJson<TaskSpec>(path.join(taskDir(id), 'task.json'));
}

export function saveTask(task: TaskSpec): void {
  writeJson(path.join(taskDir(task.id), 'task.json'), task);
}

export function loadState(id: string): TaskState {
  return readJson<TaskState>(path.join(taskDir(id), 'state.json'));
}

export function saveState(state: TaskState): void {
  state.updated_at = new Date().toISOString();
  writeJson(path.join(taskDir(state.id), 'state.json'), state);
}

export function setStatus(state: TaskState, status: TaskStatus, note?: string): void {
  state.status = status;
  state.history.push({ at: new Date().toISOString(), status, ...(note ? { note } : {}) });
  saveState(state);
}

export function newState(id: string): TaskState {
  return { id, status: 'queued', attempts: 0, feedback: [], updated_at: '', history: [] };
}

export function listTaskIds(): string[] {
  const dir = path.join(AIO_HOME, 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(taskExists).sort();
}

export function appendCost(entry: Record<string, unknown>): void {
  const file = path.join(AIO_HOME, 'costs.jsonl');
  fs.mkdirSync(AIO_HOME, { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}
