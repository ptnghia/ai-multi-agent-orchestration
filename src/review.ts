import fs from 'node:fs';
import path from 'node:path';
import { adapters } from './adapters.js';
import { writeJson } from './store.js';
import type { AgentRun, Check, ReviewVerdict, TaskSpec } from './types.js';

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'description'],
        properties: {
          severity: { type: 'string', enum: ['major', 'minor'] },
          description: { type: 'string' },
        },
      },
    },
  },
};

function buildReviewPrompt(task: TaskSpec, base: string, filesChanged: string[]): string {
  const list = (items: string[] | undefined) => (items ?? []).map((i) => `- ${i}`).join('\n');
  return `You are a strict, independent reviewer. Another agent completed task ${task.id} in this git worktree.
Do NOT modify any file. Only read, and run read-only commands.

## Task objective
${task.objective}

## Acceptance criteria
${list(task.acceptance_criteria) || '(none)'}

## Review rubric (fail the work if any item is violated in a way a user would notice)
${list(task.review!.rubric)}

## What changed
Run \`git diff ${base} HEAD\` to see the changes. Files changed:
${filesChanged.map((f) => `- ${f}`).join('\n')}
For large data or content files, read a representative sample of at least 8 items spread across the file, not just the start.

## Answer
Reply with JSON matching the provided schema: verdict ("fail" if there is at least one major issue), a summary of at most 3 sentences, and issues (each with severity "major" or "minor" and a concrete description that names the file and item, so a fix can be made without re-reviewing).
`;
}

export async function runReview(
  task: TaskSpec,
  worktree: string,
  base: string,
  filesChanged: string[],
  attemptDir: string,
): Promise<{ check: Check; verdict?: ReviewVerdict; run: AgentRun }> {
  const spec = task.review!;
  const dir = path.join(attemptDir, 'review');
  fs.mkdirSync(dir, { recursive: true });
  const schemaPath = path.join(dir, 'review.schema.json');
  writeJson(schemaPath, REVIEW_SCHEMA);
  const prompt = buildReviewPrompt(task, base, filesChanged);
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);

  const reviewerTask: TaskSpec = {
    ...task,
    agent: spec.agent,
    model: spec.model,
    codex: { sandbox: 'read-only' },
    agy: { skip_permissions: true },
  };
  const run = await adapters[spec.agent](reviewerTask, {
    worktree,
    attemptDir: dir,
    prompt,
    schemaPath,
    timeoutMs: 20 * 60 * 1000,
  });
  const verdict = run.report as unknown as ReviewVerdict | undefined;
  if (!verdict?.verdict) {
    return { check: { name: `review by ${spec.agent}`, ok: false, detail: `no verdict: ${run.error ?? 'empty report'}` }, run };
  }
  const majors = verdict.issues.filter((i) => i.severity === 'major');
  const ok = verdict.verdict === 'pass' && majors.length === 0;
  const detail = [verdict.summary, ...verdict.issues.map((i) => `${i.severity}: ${i.description}`)].join(' | ');
  return { check: { name: `review by ${spec.agent}`, ok, detail }, verdict, run };
}
