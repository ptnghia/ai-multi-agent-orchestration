# AIO — AI Orchestrator

Claude lên kế hoạch và review. Codex/AGY thực thi trong git worktree riêng. **AIO tự kiểm chứng** (không tin lời agent tự báo). Khi một agent hết quota, agent kia làm tiếp; khi cả hai hết, việc được trả lại cho Claude.

Thiết kế gốc: [AI-Multi-Agent-Orchestration-Claude-Codex-Antigravity.md](AI-Multi-Agent-Orchestration-Claude-Codex-Antigravity.md).

## Cài đặt

```bash
npm install && npm run build && npm link   # → lệnh `aio` dùng được ở mọi thư mục
npm test                                   # unit + end-to-end (agent giả lập, không tốn quota)
```

Yêu cầu: Node ≥ 20, git, `codex` và/hoặc `agy` đã đăng nhập (chạy interactive một lần).
Screenshot dùng `playwright-core` + Edge/Chrome có sẵn trên máy (không cần tải browser).
Store: `~/.aio` (đổi bằng `AIO_HOME`).

## Lệnh

```bash
aio create tasks/T-001.json          # đăng ký task → queued (gộp <repo>/aio.defaults.json)
aio run [ids] -j 3                   # chạy song song; mỗi task 1 dòng kết quả
aio status                           # trạng thái + kết quả gần nhất (phát hiện task "running (stale)")
aio show T-001 [--diff] [--json]     # gói review gọn
aio sheet T-001 T-002                # 1 contact sheet cho mọi screenshot/ảnh
aio reject T-001 -m "feedback"       # → rework
aio verify T-001                     # chạy toàn bộ check trên worktree (sau handoff / sửa tay)
aio approve T-001 --merge            # merge + post_merge_verify + commit .context
aio agents [reset [codex|agy]]       # quota: agent nào đang "nghỉ" đến khi nào
aio costs                            # số lần chạy, thời gian, token theo agent/vai trò
aio clean T-001 [--delete-branch]    # xoá worktree
aio delete T-001                     # xoá hẳn task (thử nghiệm)
aio context [repo]                   # sinh lại <repo>/.context/ACTIVE.md
```

## Mỗi lần chạy

1. Chọn agent: agent chính, nếu đang hết quota thì agent dự phòng (`fallback_agent`, mặc định là agent còn lại); nếu cả hai hết → **handoff**.
2. Tạo/tái sử dụng worktree `~/.aio/worktrees/<id>` trên branch `aio/<id>` (chạy `setup` lần đầu).
3. Gọi agent với prompt chuẩn hoá + JSON schema; commit snapshot công việc (kể cả dở dang).
4. Agent hết quota giữa chừng → đánh dấu nghỉ (theo "try again in …" hoặc 60 phút) → agent kia **làm tiếp trên cùng worktree**.
5. **Checks do AIO tự chạy**: process, báo cáo agent, file khai báo có thật, `allowed_paths`, `verify`, `expected_files`, kích thước `images`, screenshot, contact sheet, review chéo.
6. Check lỗi nhưng agent chạy được → auto-retry với lỗi làm feedback.
7. Kết quả: `review` (pass) · `failed` · `handoff` (cả hai agent hết quota → `~/.aio/tasks/<id>/handoff.md` cho Claude, làm xong thì `aio verify <id>`).
8. Ghi `result.json`, `diff.patch`, log vào `~/.aio/tasks/<id>/attempt-N/`; chi phí vào `~/.aio/costs.jsonl`; sự kiện vào `<repo>/.context/HISTORY.md`.

## Task spec

```jsonc
{
  "id": "UI-019",                    // [A-Za-z0-9._-]+
  "agent": "codex",                  // "codex" | "agy"
  "fallback_agent": "agy",           // mặc định: agent còn lại; "none" = không chuyển
  "repo": "../my-app",               // tương đối với file task
  "base": "main",                    // mặc định HEAD
  "objective": "…",
  "context": ["…"], "files": ["src/…"], "constraints": ["…"], "acceptance_criteria": ["…"],
  "setup": ["npm ci"],               // chạy 1 lần khi tạo worktree
  "verify": ["npm test", "npm run build"],
  "post_merge_verify": ["npm test"], // chạy trên repo sau approve --merge
  "env": { "CI": "1" },              // cho setup/verify/server/post-merge
  "expected_files": ["…"],
  "allowed_paths": ["src/dashboard/**", "public/"],
  "images": [{ "path": "public/hero.png", "width": 1536, "height": 1024 }],
  "screenshots": {
    "server": { "command": "npx expo start --web --port 8090", "url": "http://localhost:8090", "timeout_seconds": 240 },
    "pages": [{ "url": "http://localhost:8090", "out": "home.png", "width": 390, "height": 844 }]
  },
  "review": { "agent": "agy", "rubric": ["…"] },
  "models": { "codex": "…", "agy": "…" },  // model theo agent (an toàn khi failover)
  "auto_retries": 1,
  "timeout_minutes": 20,
  "codex": { "sandbox": "workspace-write", "network": false },
  "agy": { "skip_permissions": true }
}
```

Các trường dùng chung đặt trong `<repo>/aio.defaults.json`.

## Phân vai (theo spike 2026-10-07)

| Việc | Agent |
|---|---|
| Code, test, refactor | `codex` |
| Sinh ảnh | `codex` |
| Văn bản tiếng Việt, review chéo, dự phòng khi Codex hết quota | `agy` |
| Browser / visual QA | AIO (`screenshots` + contact sheet) → Claude/subagent xem 1 ảnh |
| Khi cả hai hết quota | Claude (handoff → `aio verify`) |

## Tiết kiệm token cho Claude

| Tính năng | Tác dụng |
|---|---|
| Auto-retry, failover | Lỗi máy và hết quota được xử lý không cần Claude |
| Review chéo (`review`) | Agent khác chấm rubric; Claude chỉ đọc verdict |
| Contact sheet | Gộp N ảnh thành 1 (~1,6k token thay vì ~1,6k × N) |
| Output gọn | `aio run` 1 dòng/task; `show` ẩn check pass |
| `.context/` + hook SessionStart | Phiên mới định hướng với ~1k token, không cần lịch sử chat |

Playbook cho Claude Code: [skills/aio-orchestrate/SKILL.md](skills/aio-orchestrate/SKILL.md) — copy vào `<project>/.claude/skills/`.

## Lưu ý

- `agy` mặc định chạy `--dangerously-skip-permissions`. Tắt bằng `"agy": {"skip_permissions": false}` và cấu hình allowlist trong `~/.gemini/antigravity-cli/settings.json`.
- Phát hiện quota dựa trên thông báo lỗi của CLI (usage limit, 429, RESOURCE_EXHAUSTED…), chỉ đọc phần lỗi, không đọc output bình thường.
- Biến môi trường: `AIO_HOME`, `AIO_CODEX_BIN`, `AIO_AGY_BIN` (nhận cả script `.mjs`), `AIO_BROWSER_CHANNEL`.
- Hai task sửa cùng file sẽ conflict khi merge — chia task theo module.
