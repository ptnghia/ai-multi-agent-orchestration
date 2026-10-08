# AIO — AI Orchestrator MVP

Claude lên kế hoạch và review. Codex/AGY thực thi trong git worktree riêng. **AIO tự kiểm chứng** (không tin lời agent tự báo).

Thiết kế gốc: [AI-Multi-Agent-Orchestration-Claude-Codex-Antigravity.md](AI-Multi-Agent-Orchestration-Claude-Codex-Antigravity.md).

## Cài đặt

```bash
npm install && npm run build
node dist/cli.js --help        # hoặc: npm link  →  aio --help
```

Yêu cầu: Node ≥ 20, git, `codex` và/hoặc `agy` đã đăng nhập (chạy interactive một lần).
Screenshot dùng `playwright-core` + Edge/Chrome có sẵn trên máy (không cần tải browser).

## Luồng làm việc

```bash
aio create tasks/T-001.json          # đăng ký task → queued
aio run -j 3                         # chạy mọi task queued/rework song song
aio show T-001 [--diff] [--json]     # gói review gọn cho Claude
aio reject T-001 -m "feedback"       # → rework; aio run T-001 chạy lần tiếp (cùng worktree)
aio approve T-001 --merge            # merge branch aio/T-001 vào repo
aio clean T-001 --delete-branch
aio status
```

Mỗi lần chạy:

1. Tạo/tái sử dụng worktree `.aio/worktrees/<id>` trên branch `aio/<id>`.
2. Gọi agent với prompt chuẩn hoá + JSON schema cho báo cáo.
3. Snapshot commit công việc của agent.
4. **Checks do AIO tự chạy**: process exit, agent có báo `completed`, file agent khai báo có thực sự đổi, thay đổi nằm trong `allowed_paths`, lệnh `verify`, `expected_files`, kích thước `images`, screenshot (lỗi JS trên trang = fail).
5. Ghi `result.json`, `diff.patch`, log, screenshot vào `.aio/tasks/<id>/attempt-N/`; token/thời gian vào `.aio/costs.jsonl`.
6. Tất cả check ok → `review`, ngược lại → `failed`.

## Task spec

```jsonc
{
  "id": "UI-019",                    // [A-Za-z0-9._-]+
  "agent": "codex",                  // "codex" | "agy"
  "repo": "../my-app",               // tương đối với file task
  "base": "main",                    // mặc định HEAD
  "objective": "…",
  "context": ["…"],
  "files": ["src/…"],
  "constraints": ["…"],
  "acceptance_criteria": ["…"],
  "verify": ["npm ci", "npm test", "npm run build"],
  "expected_files": ["…"],
  "allowed_paths": ["src/dashboard/**", "public/"],
  "images": [{ "path": "public/hero.png", "width": 1536, "height": 1024 }],
  "screenshots": {
    "server": { "command": "npm run dev -- --port 5180", "url": "http://localhost:5180", "timeout_seconds": 90 },
    "pages": [{ "url": "http://localhost:5180", "out": "home.png", "width": 390, "height": 844 }]
  },
  "model": "…",                      // tuỳ chọn
  "timeout_minutes": 20,
  "codex": { "sandbox": "workspace-write" },
  "agy": { "skip_permissions": true }
}
```

## Phân vai (theo spike 2026-10-07)

| Việc | Agent |
|---|---|
| Code, test, refactor | `codex` (nhanh, rẻ hơn) |
| Sinh ảnh | `codex` (image_gen thật; AGY CLI hết quota/khai man) |
| Phương án thứ hai, research, khi Codex hết quota | `agy` |
| Browser / visual QA | AIO (`screenshots`) → Claude xem ảnh |

## Tiết kiệm token cho Claude (v0.2)

| Tính năng | Cách dùng | Tác dụng |
|---|---|---|
| Auto-retry | `"auto_retries": 1` (mặc định) | Lỗi verify được tự gửi lại cho agent, Claude không phải can thiệp |
| Review chéo | `"review": {"agent": "agy", "rubric": [...]}` | Agent khác chấm theo rubric sau khi check máy đã xanh; Claude chỉ đọc verdict |
| Contact sheet | tự động / `aio sheet <ids>` | Gộp mọi screenshot + ảnh thành 1 hình (~1,6k token thay vì ~1,6k × N) |
| Output gọn | `aio run` in 1 dòng/task; `show` ẩn check pass | Ít token mỗi lượt đọc kết quả |
| Defaults | `<repo>/aio.defaults.json` | Spec task ngắn hơn |
| Post-merge verify | `"post_merge_verify": [...]` | Bắt lỗi tích hợp ngay khi merge |

Playbook điều phối cho Claude Code: [skills/aio-orchestrate/SKILL.md](skills/aio-orchestrate/SKILL.md) — copy vào `<project>/.claude/skills/`.

## Lưu ý

- `agy` mặc định chạy `--dangerously-skip-permissions` (không thì không chạy được lệnh). Tắt bằng `"agy": {"skip_permissions": false}` và cấu hình allowlist trong `~/.gemini/antigravity-cli/settings.json`.
- Store mặc định là `./.aio` của thư mục hiện tại; đổi bằng `AIO_HOME`. Đường dẫn CLI: `AIO_CODEX_BIN`, `AIO_AGY_BIN`; browser: `AIO_BROWSER_CHANNEL`.
- Hai task sửa cùng file sẽ conflict khi merge — chia task theo module.
