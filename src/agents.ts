import fs from 'node:fs';
import path from 'node:path';
import { AIO_HOME, readJson, writeJson } from './store.js';
import type { AgentName, TaskSpec } from './types.js';

/** Default cool-down when an agent runs out of quota without saying when it resets. */
export const DEFAULT_COOLDOWN_MINUTES = 60;
export const AGENTS: AgentName[] = ['codex', 'agy'];

interface AgentStatus {
  unavailable_until?: string;
  reason?: string;
}
type AgentStatusFile = Partial<Record<AgentName, AgentStatus>>;

const file = () => path.join(AIO_HOME, 'agents.json');

function load(): AgentStatusFile {
  return fs.existsSync(file()) ? readJson<AgentStatusFile>(file()) : {};
}

export function isAvailable(agent: AgentName, now = new Date()): boolean {
  const until = load()[agent]?.unavailable_until;
  return !until || new Date(until) <= now;
}

export function markUnavailable(agent: AgentName, minutes: number, reason: string): Date {
  const status = load();
  const until = new Date(Date.now() + minutes * 60_000);
  status[agent] = { unavailable_until: until.toISOString(), reason: reason.slice(0, 300) };
  writeJson(file(), status);
  return until;
}

export function resetAgents(agent?: AgentName): void {
  const status = load();
  for (const a of agent ? [agent] : AGENTS) delete status[a];
  writeJson(file(), status);
}

export function agentStatusLines(now = new Date()): string[] {
  const status = load();
  return AGENTS.map((a) => {
    const s = status[a];
    if (!s?.unavailable_until || new Date(s.unavailable_until) <= now) return `${a}: available`;
    return `${a}: out of quota until ${s.unavailable_until.replace('T', ' ').slice(0, 16)} UTC — ${s.reason ?? ''}`;
  });
}

/** Ordered candidates for a task: its agent, then its fallback. */
export function candidateAgents(task: TaskSpec): AgentName[] {
  const fallback = task.fallback_agent === 'none' ? undefined : (task.fallback_agent ?? AGENTS.find((a) => a !== task.agent));
  return fallback && fallback !== task.agent ? [task.agent, fallback] : [task.agent];
}

/** First candidate that is not excluded and not cooling down, or undefined when all are out. */
export function pickAgent(task: TaskSpec, exclude: AgentName[] = []): AgentName | undefined {
  return candidateAgents(task).find((a) => !exclude.includes(a) && isAvailable(a));
}
