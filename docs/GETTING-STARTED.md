# Bắt đầu một dự án mới với AIO

Hướng dẫn từng bước từ một thư mục trống đến wave đầu tiên được merge. Ví dụ dùng Git Bash; lệnh PowerShell tương đương ghi kèm ở các bước copy.

Vai trò trong suốt quá trình:

| Ai | Làm gì |
|---|---|
| **Bạn** | Nêu yêu cầu, duyệt kế hoạch, quyết định những việc cần người (đăng nhập, phát hành, chuyên gia duyệt nội dung) |
| **Claude** | Kiến trúc, spec, hợp đồng dữ liệu, chia task, review, approve/merge, làm thay khi agent hết quota |
| **Codex / AGY** | Thực thi task trong worktree riêng |
| **AIO** | Chạy agent, kiểm chứng, chuyển agent khi hết quota, ghi lịch sử |

---

## Bước 0 — Chuẩn bị máy (một lần duy nhất)

```bash
node --version          # >= 20
git --version
codex login             # đăng nhập interactive một lần
agy                     # mở một phiên interactive để đăng nhập, rồi thoát
npm install -g --install-links github:ptnghia/ai-multi-agent-orchestration
aio agents              # phải in: codex: available / agy: available
```

Nếu `aio` không chạy được: mở lại terminal (PATH của npm global). Cập nhật AIO về sau: chạy lại lệnh `npm install -g …` ở trên.

---

## Bước 1 — Tạo repo và khung dự án

1. Tạo thư mục và dựng khung bằng công cụ chuẩn của stack (ví dụ `npx create-expo-app`, `npm create vite`, `npx create-next-app`…). Việc này nhỏ và máy móc, **Claude tự làm**, không giao agent.
2. Bảo đảm repo đã là git và có commit đầu tiên:
   ```bash
   git init -b main && git add -A && git commit -m "Initial scaffold"
   ```
3. **Làm cho baseline xanh trước khi giao bất kỳ task nào.** Repo phải có 3 lệnh chạy được và đều pass: `typecheck`, `lint`, `test` (thêm một test giả nếu chưa có test nào). Nếu baseline đỏ, mọi task đều FAIL ở verify dù agent làm đúng.
   ```jsonc
   // package.json → scripts
   "typecheck": "tsc --noEmit",
   "lint": "eslint .",
   "test": "jest"            // hoặc vitest / node --test
   ```

> Bài học từ dự án đầu: template Expo ban đầu còn lỗi `tsc` và lint; phải sửa trước khi giao việc.

---

## Bước 2 — Cài bộ khung điều phối vào dự án

```bash
cd E:/app/<ten-du-an>
aio init
```

Lệnh này an toàn để chạy lại bất cứ lúc nào:

- File còn thiếu → **tạo** từ template.
- `.claude/settings.json` đã có → **gộp** thêm hook SessionStart, giữ nguyên plugin/permission sẵn có, không nhân đôi hook.
- `AGENTS.md` / `CLAUDE.md` đã có → **chèn** phần của AIO lên đầu, giữa hai marker `aio:agents` / `aio:claude`; lần chạy sau chỉ cập nhật phần đó, nội dung của bạn giữ nguyên.
- `aio.defaults.json` được sinh theo **stack thật**: nhận diện npm/pnpm/yarn/bun từ lockfile, chỉ đưa vào `verify` các script `typecheck`/`lint`/`test` thực sự có trong `package.json`, và cảnh báo script nào còn thiếu.
- Skill `aio-orchestrate` luôn được **cập nhật** lên bản AIO đang cài.
- File khác đã có → **giữ nguyên** (thêm `--force` để ghi đè bằng template).

Kết quả in ra dạng `created / merged / updated / kept` cho từng file, kèm cảnh báo (chưa phải git repo, thiếu script…).

Những gì vừa được thêm:

| File | Vai trò |
|---|---|
| `.claude/settings.json` | Hook SessionStart: mỗi phiên Claude mới tự nạp `.context/` (~1k token) |
| `.claude/hooks/session-context.mjs` | Script của hook |
| `.claude/skills/aio-orchestrate/SKILL.md` | Playbook điều phối Claude tự áp dụng |
| `.context/ACTIVE.md` | Trạng thái hiện tại; phần giữa `aio:begin/end` do AIO tự sinh |
| `.context/DECISIONS.md` | Các quyết định đã chốt, mỗi dòng một quyết định |
| `.context/HISTORY.md` | Nhật ký do AIO ghi, tự xoay vòng |
| `CLAUDE.md` | Chính sách cho Claude ở mọi phiên: việc nhỏ tự làm, việc lớn giao qua AIO, người dùng bảo tự làm thì tự làm |
| `AGENTS.md` | Quy tắc cho Codex/AGY (Codex tự đọc file này) |
| `aio.defaults.json` | Trường dùng chung cho mọi task (setup, verify, retry, timeout…) |
| `docs/PRODUCT.md` | Khung spec sản phẩm |
| `docs/tasks/EXAMPLE-01.json` | Mẫu task spec |

**Kiểm tra lại sau `aio init`:**
- Đọc các cảnh báo; thêm script còn thiếu vào `package.json` (và làm cho chúng pass), hoặc sửa `verify` trong `aio.defaults.json`.
- Stack không dùng Node (Python, Go…): tự điền `setup`/`verify` (ví dụ `pip install -r requirements.txt`, `pytest`).
- Thêm `env` nếu các lệnh cần biến môi trường (ví dụ `"env": {"CI": "1"}`).

Commit:

```bash
git add -A && git commit -m "Add AIO orchestration scaffold"
```

---

## Bước 3 — Mở phiên Claude Code trong dự án và kiểm tra

```bash
cd E:/app/<ten-du-an> && claude
```

Hỏi: *"Trạng thái dự án đang thế nào?"* → Claude phải trả lời được ngay từ `.context/` mà không cần đọc file. Nếu không: chạy `/hooks` để kiểm tra hook SessionStart.

Sau đó **làm việc với Claude như bình thường**. Nhờ `CLAUDE.md` + skill, Claude tự chọn cách làm: yêu cầu nhỏ (sửa lỗi, đổi cấu hình, tài liệu) thì tự làm; tính năng lớn thì nói trước rằng sẽ giao qua AIO rồi lập task. Muốn Claude tự làm một việc lớn, chỉ cần nói "bạn tự làm".

---

## Bước 4 — Claude viết spec và hợp đồng (CTO làm, không giao agent)

Gửi Claude yêu cầu sản phẩm, ví dụ:

> Đây là dự án mới: <mô tả sản phẩm, người dùng, nền tảng>. Hãy dùng skill aio-orchestrate. Trước tiên viết `docs/PRODUCT.md` (phạm vi v1, quy tắc nghiệp vụ kiểm tra được bằng máy, kiến trúc thư mục, màn hình/endpoint), viết các kiểu dữ liệu dùng chung làm hợp đồng, ghi các quyết định vào `.context/DECISIONS.md`, rồi đề xuất danh sách task cho wave 1. Chưa chạy gì cho đến khi tôi duyệt.

Những gì Claude cần ra ở bước này:

1. **`docs/PRODUCT.md`** — đủ để agent làm mà không phải hỏi lại.
2. **Hợp đồng dữ liệu** (ví dụ `src/types/domain.ts`) — đóng băng; nhờ đó nhiều agent làm song song không giẫm chân nhau.
3. **`DECISIONS.md`** — vài dòng đầu tiên (stack, lý do).
4. **Kế hoạch wave 1** — để bạn duyệt.

---

## Bước 5 — Chia task cho một wave

Nguyên tắc (Claude áp dụng, bạn kiểm tra khi duyệt):

- **Không giao tác vụ nhỏ** (dưới ~100 dòng thay đổi): Claude tự làm rẻ hơn.
- **Mỗi task một vùng file riêng** (`allowed_paths` không giao nhau) → chạy song song an toàn, merge không conflict.
- **Phụ thuộc thì chia wave**: dữ liệu + logic trước, UI sau (UI cần id và kiểu dữ liệu thật).
- **Tiêu chí nghiệm thu kiểm tra được bằng máy**: "test X bao phủ A, B, C", "ảnh 1024x768 ≤ 200 KB", không phải "làm cho đẹp".
- **Nội dung/UX chủ quan** → thêm `review` (AGY chấm rubric) và biến các tiêu chí dễ đo thành test (không trùng lặp, đủ số lượng, có đề cập nguyên liệu…).
- **Phân vai**: code + sinh ảnh → `codex`; văn bản tiếng Việt, review chéo → `agy`. Agent còn lại tự động là dự phòng khi hết quota.
- **UI** → thêm `screenshots` (server + các trang ở viewport mobile) để có contact sheet.

Mẫu task tối thiểu (phần chung đã nằm trong `aio.defaults.json`):

```json
{
  "id": "W1-02-search",
  "repo": "../..",
  "objective": "Implement src/lib/search.ts as specified in docs/PRODUCT.md section 3.",
  "constraints": ["Pure TypeScript, no new dependencies."],
  "acceptance_criteria": ["Tests in src/lib/__tests__/search.test.ts cover each filter and the empty query."],
  "allowed_paths": ["src/lib/search.ts", "src/lib/__tests__/search.test.ts"]
}
```

Đặt file vào `docs/tasks/` và commit, để spec được lưu cùng code.

---

## Bước 6 — Chạy wave

Claude chạy (một lệnh, chạy nền, chờ một thông báo duy nhất):

```bash
aio agents                                   # ai đang hết quota?
aio create docs/tasks/W1-*.json
aio run -j 3                                 # in 1 dòng/task khi xong
```

Kết quả có thể là:

| Dòng kết quả | Nghĩa | Việc tiếp theo |
|---|---|---|
| `PASS <id> … by codex` | Mọi check (và review chéo nếu có) đã qua | Review (bước 7) |
| `FAIL <id>` + danh sách check lỗi | Đã auto-retry mà vẫn lỗi | Reject với feedback cụ thể, hoặc sửa spec |
| `PASS … by agy` sau `failover` | Codex hết quota, AGY làm tiếp | Review như bình thường |
| `HANDOFF <id>` | Cả hai agent hết quota | Bước 8 |

---

## Bước 7 — Review và merge

Claude giao việc review cho một subagent (prompt mẫu trong skill), subagent đọc `aio show <id>` + **một** contact sheet và trả lời ≤120 chữ. Sau đó:

```bash
aio approve <id> --merge        # merge + post_merge_verify + commit .context
aio reject <id> -m "Cụ thể: sai gì, ở đâu, kết quả mong đợi"
aio run <id>                    # chạy lại sau reject
```

Những gì máy **không** bắt được, reviewer phải nhìn:
- Nội dung sinh theo khuôn mẫu (câu mô tả giống nhau, các bước chung chung).
- Ảnh/giao diện "đúng kích thước nhưng sai ý".
- Dung lượng file (ảnh PNG vài MB cho app mobile).

---

## Bước 8 — Khi task bị trả về (handoff)

```bash
cat ~/.aio/tasks/<id>/handoff.md      # mục tiêu, worktree, phần đã làm
# Claude làm tiếp ngay trong worktree ghi trong handoff.md
aio verify <id>                       # chạy toàn bộ check trên phần việc đó
aio approve <id> --merge
```

Nếu phần còn lại lớn: chờ hết thời gian nghỉ (`aio agents`) rồi `aio run <id>`. Khi đã nạp thêm quota: `aio agents reset`.

---

## Bước 9 — Kết thúc wave

```bash
aio clean <id>                 # xoá worktree (mỗi cái chứa node_modules riêng)
aio costs                      # xem việc giao agent có đáng không
```

- Cập nhật phần viết tay của `.context/ACTIVE.md` (Focus, Open follow-ups).
- Thêm dòng vào `DECISIONS.md` nếu có quyết định mới.
- **Wave tiếp theo: mở phiên Claude mới** (`/clear` hoặc phiên mới). Hook tự nạp lại context; phiên cũ dài làm mỗi lượt đắt hơn nhiều lần.

---

## Xử lý sự cố thường gặp

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| Mọi task FAIL ở verify ngay lần đầu | Baseline đỏ (bước 1.3) hoặc `setup` sai trong `aio.defaults.json` |
| `setup "npm ci" failed` | Thiếu `package-lock.json` đã commit, hoặc lỗi mạng |
| `tsc` lỗi typed routes sau merge (Expo Router) | `.expo/types` cũ: chạy `npx expo start` một lần rồi `tsc` lại |
| `Filename too long` khi clean | Đã xử lý trong AIO (core.longpaths + xoá dự phòng); nếu còn, `git worktree prune` |
| Task `running (stale)` | Tiến trình AIO đã chết; `aio run <id>` chạy lại được ngay |
| Agent báo hết quota nhưng AIO không chuyển | Thông báo lỗi khác mẫu: thêm mẫu vào `src/quota.ts` + một dòng test |
| Screenshot bị `skip` | Thiếu `playwright-core` trong AIO hoặc không có Edge/Chrome; đặt `AIO_BROWSER_CHANNEL` |
| Hai task conflict khi merge | `allowed_paths` giao nhau — chia lại task theo module |

---

## Checklist nhanh

- [ ] Bước 0: `aio agents` → cả hai available
- [ ] Repo git + baseline typecheck/lint/test xanh
- [ ] `aio init`, xử lý cảnh báo, kiểm tra `aio.defaults.json`
- [ ] Phiên Claude mới trả lời được "trạng thái dự án" ngay
- [ ] `PRODUCT.md` + hợp đồng dữ liệu + `DECISIONS.md` đã có
- [ ] Task của wave: vùng file riêng, tiêu chí đo được, có `review`/`screenshots` khi cần
- [ ] `aio run` một lệnh chạy nền → review qua subagent → approve/reject
- [ ] Dọn worktree, cập nhật ACTIVE/DECISIONS, wave sau mở phiên mới
