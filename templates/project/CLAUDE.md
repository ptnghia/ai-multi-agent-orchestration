# Working in this project

This project delegates implementation to Codex / Antigravity through **AIO** (`aio` CLI). Project state (`.context/ACTIVE.md`, `DECISIONS.md`, recent history) is injected at session start; do not re-read it.

How to handle a request:
- **Small changes** (roughly under 100 changed lines, config, docs, quick fixes, questions): do them directly.
- **Feature or implementation work larger than that**: follow the `aio-orchestrate` skill. Plan the wave, write task specs in `docs/tasks/`, run them with `aio`, review through a subagent, then `aio approve <id> --merge`. Tell the user briefly what you are delegating before you run it.
- **The user says to do it yourself**: do it yourself.
- **A task comes back as HANDOFF** (agents out of quota): finish it in its worktree and run `aio verify <id>`.

Sources of truth: `docs/PRODUCT.md` (scope, contracts), `.context/DECISIONS.md` (settled choices; do not undo them without asking). Read `.context/HISTORY.md` only with `tail`.
