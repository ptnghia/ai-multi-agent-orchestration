import type { TaskSpec, TaskState } from './types.js';

export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'files_changed', 'notes'],
  properties: {
    status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

function section(title: string, items: string[] | undefined): string {
  if (!items?.length) return '';
  return `## ${title}\n${items.map((i) => `- ${i}`).join('\n')}\n\n`;
}

export function buildPrompt(task: TaskSpec, state: TaskState, attempt: number, previousDiffStat: string): string {
  const imageLines = task.images?.map(
    (i) => `${i.path}${i.width && i.height ? ` (${i.width}x${i.height} px)` : ''} — create it with your image generation tool, not by drawing it with code`,
  );
  let p = `You are an execution agent. Task ${task.id}, attempt ${attempt}.\n`;
  p += `You work inside a dedicated git worktree (the current directory). Do not commit, push or switch branches; the orchestrator handles git.\n\n`;
  p += `## Objective\n${task.objective}\n\n`;
  p += section('Context', task.context);
  p += section('Relevant files', task.files);
  p += section('Constraints', [
    ...(task.constraints ?? []),
    ...(task.allowed_paths?.length ? [`Only modify paths matching: ${task.allowed_paths.join(', ')}`] : []),
  ]);
  p += section('Acceptance criteria', task.acceptance_criteria);
  p += section('Files that must exist when you finish', task.expected_files);
  p += section('Images to generate', imageLines);
  if (task.verify?.length) {
    p += section('Verification (the orchestrator re-runs these independently; run them yourself before finishing)', task.verify);
  }
  if (attempt > 1) {
    p += `## Rework\nThe worktree already contains earlier attempts. Changes so far vs base:\n\`\`\`\n${previousDiffStat || '(none)'}\n\`\`\`\n\n`;
    p += section('Reviewer feedback to address', state.feedback);
  }
  p += `## Final answer\nReply with JSON matching the provided schema: status, a summary of at most 5 sentences, files_changed (paths relative to the worktree), and notes (risks, follow-ups, anything you could not do).\n`;
  p += `Every claim is verified against git and the filesystem. If something failed or a tool is unavailable, report status "failed" or "blocked" instead of claiming success.\n`;
  return p;
}
