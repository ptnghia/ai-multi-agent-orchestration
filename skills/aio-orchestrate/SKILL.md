---
name: aio-orchestrate
description: Orchestrate Codex/AGY execution agents through the AIO CLI while keeping Claude's own token use low. Use when planning, dispatching, reviewing or merging AIO tasks (task JSON specs, aio run/show/sheet/approve/reject), or when the user asks to delegate implementation to Codex or Antigravity.
---

# AIO orchestration playbook

Claude decides and reviews; agents execute; AIO verifies. Claude's cost is dominated by re-reading its own context on every turn, so every rule below is about keeping that context small and the number of turns low.

CLI: `node E:/app/AI-Multi-Agent-Orchestration/dist/cli.js` (below: `aio`), with `AIO_HOME=E:/app/AI-Multi-Agent-Orchestration/.aio`.

## 1. Context hygiene
- One wave per session. Project memory lives in the repo's `.context/`: a SessionStart hook injects ACTIVE.md, DECISIONS.md and the last 5 HISTORY lines (~1k tokens), so do not re-read them. Open `docs/PRODUCT.md` only for the sections the wave touches. Do not carry earlier waves' logs, diffs or screenshots.
- AIO maintains the generated part of ACTIVE.md and appends HISTORY.md on every create/run/reject/approve. Claude only edits ACTIVE.md's hand-written sections (Focus, Open follow-ups) and adds one DECISIONS.md row when a choice would surprise a newcomer. Read HISTORY with `tail`, never in full.
- Never read a large generated file in full. Sample it with a throwaway script/test that prints counts and 2-3 items.
- Never open individual screenshots or images. Open the one contact sheet (`result.contact_sheet`, or `aio sheet <ids>`).

## 2. Writing task specs
- Put shared fields (agent, setup, verify, post_merge_verify, auto_retries, timeout, standing context) in `<repo>/aio.defaults.json`; task files hold only what is task-specific.
- Split work so tasks touch disjoint files (`allowed_paths`); freeze shared contracts (types, API) yourself before dispatching.
- Prefer machine-checkable acceptance criteria. When quality is subjective (content, UX), encode the cheap heuristics as tests (uniqueness, coverage, counts) and add a `review` block so another agent checks the rubric before you do.
- Do not delegate tiny tasks (roughly < 100 changed lines): writing the spec and reviewing costs more than doing it.
- Route by strength: Codex for code and image generation; AGY for Vietnamese prose/content and as cross-reviewer.

## 3. Running
- `aio create <specs>` then `aio run <ids> -j N` as ONE background Bash command. Wait for its single completion notification.
- Do not use Monitor or poll logs: each wake-up re-reads the whole context.
- AIO auto-retries mechanical failures (`auto_retries`), so a FAIL line in the final output already includes one self-correction attempt.

## 4. Reviewing — delegate it
For each finished wave, spawn one subagent (general-purpose) with this prompt, filling in the ids, and act on its short answer:

> You review AIO tasks <ids> for project <repo>. Use `aio show <id>` (compact) and open only the contact sheet image it lists. Do not read whole files; sample with small scripts if needed. For each task decide APPROVE or REJECT. APPROVE requires all checks passing (or a failing check you can show is a false positive) and no visible defect in the contact sheet. For REJECT, write feedback the agent can act on without further context: what is wrong, where, and the expected result. Do not approve or merge yourself. Answer in at most 120 words: one line per task — `<id>: APPROVE` or `<id>: REJECT — <feedback>`.

Then run `aio approve <id> --merge` (post_merge_verify runs automatically) or `aio reject <id> -m "<feedback>"` and re-run.

## 5. After a wave
- `aio clean <id>` for merged tasks (worktrees hold node_modules).
- Record only durable lessons (agent quirks, project gotchas) in memory; the task specs and git history hold the rest.
