---
name: aio-orchestrate
description: Orchestrate Codex/AGY execution agents through the AIO CLI while keeping Claude's own token use low. Use in any project that has an aio.defaults.json whenever the user asks for a feature or implementation work larger than a small edit (build, add, implement, refactor, generate images), and when planning, dispatching, reviewing or merging AIO tasks (task JSON specs, aio run/show/sheet/verify/approve/reject), when a task is handed back because the agents are out of quota, or when the user asks to delegate to Codex or Antigravity.
---

# AIO orchestration playbook

Claude decides and reviews; agents execute; AIO verifies. Claude's cost is dominated by re-reading its own context on every turn, so every rule below is about keeping that context small and the number of turns low.

CLI: `aio` (installed with `npm link` from the AIO repo; store in `~/.aio`, override with `AIO_HOME`). `aio --help` lists commands.

## 1. Context hygiene
- One wave per session. Project memory lives in the repo's `.context/`: a SessionStart hook injects ACTIVE.md, DECISIONS.md and the last 5 HISTORY lines (~1k tokens), so do not re-read them. Open the project spec only for the sections the wave touches. Do not carry earlier waves' logs, diffs or screenshots.
- AIO maintains the generated part of ACTIVE.md and appends HISTORY.md on every create/run/reject/approve. Claude only edits ACTIVE.md's hand-written sections (Focus, Open follow-ups) and adds one DECISIONS.md row when a choice would surprise a newcomer. Read HISTORY with `tail`, never in full.
- Never read a large generated file in full. Sample it with a throwaway script/test that prints counts and 2-3 items.
- Never open individual screenshots or images. Open the one contact sheet (`result.contact_sheet`, or `aio sheet <ids>`).

## 2. Writing task specs
- Put shared fields (agent, setup, verify, post_merge_verify, auto_retries, timeout, env, standing context) in `<repo>/aio.defaults.json`; task files hold only what is task-specific.
- Split work so tasks touch disjoint files (`allowed_paths`); freeze shared contracts (types, API) yourself before dispatching.
- Prefer machine-checkable acceptance criteria. When quality is subjective (content, UX), encode the cheap heuristics as tests and add a `review` block so another agent checks the rubric before you do.
- Environment variables go in `env` (task or `screenshots.server.env`), never inline shell syntax like `set X=1&&`.
- If the agent-specific `model` matters, use `models: {"codex": "...", "agy": "..."}` so a failover does not pass one agent's model to the other.
- Stack MCP servers (e.g. next-devtools for Next.js 16+) live in `aio.defaults.json` under `mcp`; Codex gets them per run, pre-approved. Agents also have Context7 for current library docs — tell them to use it for version-specific APIs.
- Do not delegate tiny tasks (roughly < 100 changed lines): writing the spec and reviewing costs more than doing it.
- Route by strength: Codex for code and image generation; AGY for Vietnamese prose/content and as cross-reviewer.

## 3. Running
- Run `aio doctor` at the start of a wave (logins, quota cool-downs, MCP servers, project setup); fix any FAIL before dispatching.
- `aio create <specs>` then `aio run <ids> -j N` as ONE background Bash command. Wait for its single completion notification. Do not use Monitor or poll logs.
- AIO handles, without you: auto-retry of mechanical failures (`auto_retries`), and failover when an agent runs out of quota mid-task (the other agent continues the partial work in the same worktree; `fallback_agent: "none"` disables it).

## 4. When a task is handed back (status `handoff`)
Both agents are out of quota. The final output shows `HANDOFF <id>` and a brief path.
1. Read `~/.aio/tasks/<id>/handoff.md` (objective, worktree, work already done, link to the full instructions).
2. Do the remaining work yourself, directly in the task's worktree, not in the main checkout. Keep the scope to the task spec.
3. Run `aio verify <id>`: the same checks run on your work (verify commands, allowed_paths, files, images, screenshots, review if an agent is available).
4. Continue with step 5 as for any other task. If the remaining work is large, prefer waiting for the cool-down (`aio agents`) and `aio run <id>` again.

## 5. Reviewing — delegate it
For each finished wave, spawn one subagent (general-purpose) with this prompt, filling in the ids, and act on its short answer:

> You review AIO tasks <ids> for project <repo>. Use `aio show <id>` (compact) and open only the contact sheet image it lists. Do not read whole files; sample with small scripts if needed. For each task decide APPROVE or REJECT. APPROVE requires all checks passing (or a failing check you can show is a false positive) and no visible defect in the contact sheet. A skipped review ("no reviewer agent available") means you must review the diff sample yourself. For REJECT, write feedback the agent can act on without further context: what is wrong, where, and the expected result. Do not approve or merge yourself. Answer in at most 120 words: one line per task — `<id>: APPROVE` or `<id>: REJECT — <feedback>`.

Then run `aio approve <id> --merge` (post_merge_verify runs automatically) or `aio reject <id> -m "<feedback>"` and re-run.

## 6. After a wave
- `aio clean <id>` for merged tasks (worktrees hold node_modules); `aio delete <id>` for experiments.
- `aio costs` when deciding whether delegation is paying off.
- Record only durable lessons (agent quirks, project gotchas) in `.context/DECISIONS.md` or memory; task specs and git history hold the rest.
