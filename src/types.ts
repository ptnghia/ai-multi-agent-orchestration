export type AgentName = 'codex' | 'agy';

export interface ImageSpec {
  path: string;
  width?: number;
  height?: number;
}

export interface ScreenshotPage {
  /** http(s)/file URL, or a path relative to the worktree. */
  url: string;
  /** File name inside the attempt's screenshots dir. */
  out: string;
  width?: number;
  height?: number;
}

export interface ScreenshotSpec {
  /** Optional dev server started in the worktree before screenshots. */
  server?: { command: string; url: string; timeout_seconds?: number };
  pages: ScreenshotPage[];
}

export interface TaskSpec {
  id: string;
  agent: AgentName;
  /** Absolute path of the git repository the task works on. */
  repo: string;
  /** Ref the task branch starts from (default HEAD). */
  base?: string;
  objective: string;
  context?: string[];
  /** Files/modules the agent should focus on. */
  files?: string[];
  constraints?: string[];
  acceptance_criteria?: string[];
  /** Shell commands run once when the worktree is created (e.g. "npm ci"). */
  setup?: string[];
  /** Shell commands AIO runs itself in the worktree after the agent finishes. */
  verify?: string[];
  expected_files?: string[];
  /** Glob patterns; changes outside them fail the task. */
  allowed_paths?: string[];
  images?: ImageSpec[];
  screenshots?: ScreenshotSpec;
  model?: string;
  timeout_minutes?: number;
  codex?: {
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    /** Allow network access inside the workspace-write sandbox (docs, package installs). */
    network?: boolean;
  };
  agy?: { skip_permissions?: boolean };
  /** Extra attempts AIO starts by itself, feeding failed checks back to the agent (default 1). */
  auto_retries?: number;
  /** Cross-review by another agent after all machine checks pass. */
  review?: ReviewSpec;
  /** Commands run in the repo right after `approve --merge`. */
  post_merge_verify?: string[];
}

export interface ReviewSpec {
  agent: AgentName;
  /** Concrete, checkable criteria. The reviewer fails the work on any major issue. */
  rubric: string[];
  model?: string;
}

export interface ReviewVerdict {
  verdict: 'pass' | 'fail';
  summary: string;
  issues: { severity: 'major' | 'minor'; description: string }[];
}

export type TaskStatus = 'queued' | 'running' | 'review' | 'failed' | 'rework' | 'approved';

export interface TaskState {
  id: string;
  status: TaskStatus;
  attempts: number;
  branch?: string;
  worktree?: string;
  base_commit?: string;
  feedback: string[];
  updated_at: string;
  history: { at: string; status: TaskStatus; note?: string }[];
}

export interface AgentReport {
  status: 'completed' | 'failed' | 'blocked';
  summary: string;
  files_changed: string[];
  notes: string;
}

export interface Usage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

export interface AgentRun {
  /** Process exited cleanly and in time. Says nothing about the work itself. */
  ok: boolean;
  exit_code: number | null;
  timed_out: boolean;
  duration_seconds: number;
  report?: AgentReport;
  error?: string;
  usage?: Usage;
}

export interface Check {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail?: string;
}

export interface CommandResult {
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_seconds: number;
  output_tail: string;
}

export interface TaskResult {
  task_id: string;
  attempt: number;
  agent: AgentName;
  status: 'passed' | 'failed';
  finished_at: string;
  agent_run: AgentRun;
  checks: Check[];
  commands: CommandResult[];
  /** Cumulative changes vs the base commit, as computed by git. */
  files_changed: string[];
  diff_stat: string;
  screenshots: string[];
  /** One image combining all screenshots and generated images, for cheap visual review. */
  contact_sheet?: string;
  review?: ReviewVerdict;
  artifacts_dir: string;
}
