# AI Multi-Agent Orchestration — Claude + Codex + Antigravity

## 1. Mục tiêu

Xây dựng mô hình phát triển phần mềm trong đó:

- **Claude** giữ vai trò chủ đạo: CTO / Architect / Orchestrator / QA.
- **Codex** giữ vai trò Engineering Executor.
- **Antigravity (AGY)** giữ vai trò Visual / Product / Browser / Research Executor.
- Một lớp **AI Orchestrator (AIO)** đứng giữa Claude và các execution agent.
- Mục tiêu chính:
  - Giảm lượng token Claude phải tiêu thụ cho implementation.
  - Tận dụng khả năng coding của Codex.
  - Tận dụng khả năng visual, browser và image generation của AGY/Codex.
  - Chuẩn hóa việc giao task, nhận kết quả và QA.
  - Cho phép chạy agent song song.
  - Xây dựng workflow có thể mở rộng thành hệ thống multi-agent development.

> Nguyên tắc cốt lõi: **Claude owns decisions. Agents own execution.**

---

# 2. Mô hình tổng thể

Thay vì để Claude tự spawn nhiều Claude subagents:

```text
                    CLAUDE
               ORCHESTRATOR / CTO
                       │
              AI ORCHESTRATION CLI
                       │
       ┌───────────────┼────────────────┐
       │               │                │
       ▼               ▼                ▼
    CODEX             AGY            OTHER
  Engineering      Visual/UI        Specialist
    Executor        Executor          Agent
       │               │                │
       └───────────────┼────────────────┘
                       ▼
                 ARTIFACT STORE
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
        CODE          IMAGE        REPORT
          │            │            │
          └────────────┼────────────┘
                       ▼
                    QA PIPELINE
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
       Automated QA           AGY Visual QA
             │                   │
             └─────────┬─────────┘
                       ▼
                  CLAUDE REVIEW
                       │
                ┌──────┴──────┐
                ▼             ▼
              PASS          REWORK
                │             │
                ▼             └──────→ Agent
             RELEASE
```

---

# 3. Vai trò của từng AI

## 3.1 Claude — CTO / Architect / QA

Claude không nên làm phần lớn implementation.

Claude chịu trách nhiệm:

- Hiểu yêu cầu.
- Phân tích hệ thống.
- Lập architecture.
- Chia task.
- Chọn agent phù hợp.
- Viết task specification.
- Kiểm tra implementation.
- Review code.
- Kiểm tra consistency.
- Kiểm tra security.
- Kiểm tra UX.
- Kiểm tra architecture.
- Quyết định PASS / FAIL.
- Điều phối vòng tiếp theo.

Claude quyết định:

> **WHAT + WHY + WHETHER**

Không nhất thiết phải trực tiếp làm:

> **HOW**

---

## 3.2 Codex — Engineering Executor

Codex phù hợp với:

- Backend.
- API.
- Database.
- CLI.
- Automation.
- Refactoring.
- Unit tests.
- Integration tests.
- Debugging.
- DevOps.
- Repository-level coding.
- Implementation.
- Technical investigation.
- Code review cấp implementation.

Claude chỉ cần giao:

```text
Task ID
Goal
Context
Constraints
Acceptance Criteria
Files / Modules
Expected Output
```

Codex thực hiện task và trả artifact/result.

---

## 3.3 Antigravity — Visual / Product / Research Executor

AGY phù hợp với:

### UI

- Build dashboard UI.
- Implement responsive layout.
- Match screenshot.
- Improve UX.

### Browser

- Test website.
- Inspect frontend.
- Verify user flows.
- Screenshot.
- Visual QA.

### Visual

- Generate image concepts.
- Create visual assets.
- Evaluate UI visually.

### Research

- Research libraries.
- Explore unfamiliar codebase.
- Investigate implementation alternatives.

AGY đặc biệt phù hợp với những task có yếu tố browser, visual và product experience.

---

# 4. Không nên giao task trực tiếp bằng text tự do

Không nên chỉ làm:

```bash
codex "hãy làm task này..."
```

Thay vào đó nên xây một task protocol chuẩn:

```text
Claude
  ↓
task.json
  ↓
AI Orchestrator
  ↓
Codex / AGY
  ↓
result.json
  ↓
Claude Review
```

Ví dụ task:

```json
{
  "task_id": "FE-042",
  "agent": "codex",
  "objective": "Implement authentication API",
  "context": {
    "project": "my-saas",
    "branch": "feature/auth"
  },
  "requirements": [
    "JWT authentication",
    "refresh token",
    "rate limiting"
  ],
  "acceptance_criteria": [
    "All tests pass",
    "No TypeScript errors",
    "API documented"
  ],
  "deliverables": [
    "source code",
    "tests",
    "migration",
    "summary"
  ]
}
```

Kết quả:

```json
{
  "task_id": "FE-042",
  "status": "completed",
  "agent": "codex",
  "files_changed": [
    "src/auth/auth.service.ts",
    "src/auth/auth.controller.ts"
  ],
  "tests": {
    "passed": 47,
    "failed": 0
  },
  "summary": "...",
  "warnings": []
}
```

Claude review:

```text
result.json
+
git diff
+
test report
+
architecture impact
```

---

# 5. Tại sao mô hình này giúp tiết kiệm token Claude

Workflow truyền thống:

```text
Claude
→ spawn Claude agent
→ research
→ coding
→ testing
→ debugging
→ review
```

Claude có thể phải duy trì rất nhiều context.

Workflow mới:

```text
Claude
  │
  ├── Task specification
  │
  ▼
Codex / AGY
  │
  ├── Research
  ├── Implementation
  ├── Tests
  ├── Debugging
  │
  ▼
Compact Result
  │
  ▼
Claude
  │
  └── Review
```

Claude chỉ tập trung vào **decision-making và QA**, thay vì tiêu token cho từng bước implementation.

---

# 6. Không nên để Claude review mọi dòng code

Nếu Codex tạo 5.000 dòng code rồi Claude đọc toàn bộ:

```text
Codex
   ↓
5.000 lines
   ↓
Claude review
```

thì lợi ích tiết kiệm token sẽ giảm đáng kể.

Nên dùng nhiều tầng QA.

---

# 7. Quality Gate 4 tầng

## Layer 1 — Machine QA

Không cần Claude:

```text
lint
typecheck
unit test
integration test
build
security scan
```

## Layer 2 — Agent Self Review

Codex hoặc AGY tự kiểm tra:

```text
Review your implementation against:
- requirements
- acceptance criteria
- security
- maintainability
```

## Layer 3 — AGY Visual QA

Đối với frontend:

```text
start server
↓
open browser
↓
inspect UI
↓
take screenshot
↓
compare against requirement
```

## Layer 4 — Claude Architecture QA

Claude kiểm tra:

```text
Does implementation satisfy requirements?
Does it break architecture?
Does it introduce technical debt?
Is UX acceptable?
Is security acceptable?
```

Kết quả:

```text
PASS
```

hoặc:

```text
REWORK
```

---

# 8. Image Generation Pipeline

Image generation nên được xem là một loại artifact trong project.

Ví dụ:

```text
Claude
  ↓
Creative Direction
  ↓
Image Task
  ↓
Codex / AGY
  ↓
Generate Visual Assets
  ↓
Frontend Implementation
  ↓
AGY Visual QA
  ↓
Claude Approval
```

Asset structure:

```text
/assets
   /brand
   /hero
   /products
   /social
   /icons
```

Điều này giúp hình ảnh trở thành một phần chính thức của development pipeline thay vì output rời rạc trong chat.

---

# 9. Có thể cho nhiều agent cạnh tranh

Với những vấn đề khó, có thể chạy nhiều solution song song:

```text
                    CLAUDE
                      │
                 Task Planner
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
        CODEX        AGY       CODEX-2
          │           │           │
       solution    solution    alternative
          │           │           │
          └───────────┼───────────┘
                      ▼
                 CLAUDE REVIEW
                      │
                      ▼
                  BEST SOLUTION
```

Claude đóng vai trò evaluator thay vì trực tiếp thực hiện tất cả phương án.

---

# 10. AI Orchestrator — AIO

Không nên để Claude quản lý process trực tiếp.

Nên có một lớp:

> **AI Orchestrator (AIO)**

Cấu trúc đề xuất:

```text
ai-orchestrator/
├── agents/
│   ├── claude/
│   ├── codex/
│   └── agy/
│
├── tasks/
├── workflows/
├── artifacts/
├── reports/
├── logs/
└── config/
```

CLI có thể cung cấp:

```bash
ai run
ai task create
ai task assign
ai task status
ai task retry
ai task review
ai task approve
ai task reject
```

Claude gọi:

```bash
ai task create \
  --agent codex \
  --task FE-042
```

AIO sẽ thực thi Codex CLI hoặc AGY CLI, thu kết quả và đưa về Claude.

---

# 11. Context Manager

Đây là một thành phần đặc biệt quan trọng.

Không truyền toàn bộ conversation giữa các agent.

Nên xây:

```text
Claude Context
      ↓
Task Context
      ↓
Codex / AGY Context
      ↓
Result Context
      ↓
Claude Review Context
```

Context Manager chịu trách nhiệm:

- Chọn thông tin cần truyền.
- Loại bỏ context dư thừa.
- Chuẩn hóa task.
- Tóm tắt execution result.
- Lưu trạng thái.
- Quản lý artifact references.
- Giảm token consumption.

Đây có thể là nơi tạo ra phần lớn hiệu quả tối ưu chi phí.

---

# 12. Git / Worktree Strategy

Để nhiều agent làm việc an toàn, nên sử dụng Git làm coordination layer.

Ví dụ:

```text
main
 │
 ├── task/FE-042-auth
 │       └── Codex
 │
 ├── task/UI-019-dashboard
 │       └── AGY
 │
 └── task/API-051-payment
         └── Codex
```

Có thể dùng Git worktree:

```text
/workspaces
   /project-main
   /task-FE-042
   /task-UI-019
   /task-API-051
```

Lợi ích:

- Agent ít conflict.
- Có thể chạy song song.
- Dễ rollback.
- Dễ review diff.
- Dễ retry task.

---

# 13. Khi nào dùng Claude Subagent?

Không nên loại bỏ hoàn toàn Claude Subagent.

Claude Subagent vẫn phù hợp khi task yêu cầu reasoning liên tục trong chính Claude ecosystem.

Ví dụ:

```text
Claude Main
   │
   ├── Claude Research Subagent
   │
   ├── Codex Coding
   │
   └── AGY Visual
```

Không nên biến Claude thành:

```text
Claude
 ├── Claude Coding Agent
 ├── Claude Testing Agent
 ├── Claude Frontend Agent
 ├── Claude Backend Agent
 ├── Claude Research Agent
 └── Claude Reviewer
```

Nếu execution có thể giao cho Codex hoặc AGY thì nên giao ra ngoài để tối ưu chi phí và tận dụng năng lực chuyên biệt.

---

# 14. Phân quyền đề xuất

| Công việc | Claude | Codex | AGY |
|---|---:|---:|---:|
| Product strategy | ⭐⭐⭐ | | |
| Architecture | ⭐⭐⭐ | ⭐ | |
| Task decomposition | ⭐⭐⭐ | | |
| Backend | | ⭐⭐⭐ | ⭐ |
| Frontend | ⭐ | ⭐⭐ | ⭐⭐⭐ |
| Refactor | | ⭐⭐⭐ | ⭐ |
| Testing | ⭐ | ⭐⭐⭐ | ⭐⭐ |
| Browser testing | | ⭐ | ⭐⭐⭐ |
| UI/UX | ⭐⭐ | ⭐ | ⭐⭐⭐ |
| Image generation | ⭐ | ⭐⭐ | ⭐⭐⭐ |
| Research | ⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| Final QA | ⭐⭐⭐ | | |
| Final decision | ⭐⭐⭐ | | |

---

# 15. Nguyên tắc vận hành

## Principle 1

> **Claude owns decisions. Agents own execution.**

## Principle 2

> **Every task must have explicit acceptance criteria.**

## Principle 3

> **Agents return artifacts, not long conversations.**

## Principle 4

> **Automated QA runs before Claude review.**

## Principle 5

> **Claude reviews risks and architecture, not every line by default.**

## Principle 6

> **Git is the source of truth for code state.**

## Principle 7

> **Artifacts are the source of truth for generated outputs.**

## Principle 8

> **Context should be task-scoped, not conversation-scoped.**

---

# 16. Mô hình tổ chức hoàn chỉnh

```text
                         USER
                           │
                           ▼
                    ┌─────────────┐
                    │    CLAUDE   │
                    │    CTO      │
                    └──────┬──────┘
                           │
                    TASK PLANNER
                           │
                           ▼
                  ┌─────────────────┐
                  │ AI ORCHESTRATOR │
                  └───────┬─────────┘
                          │
          ┌───────────────┼────────────────┐
          │               │                │
          ▼               ▼                ▼
       CODEX             AGY            OTHER
    Engineering       Visual/UI        Specialist
          │               │                │
          └───────────────┼────────────────┘
                          │
                          ▼
                    ARTIFACT STORE
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
       CODE             IMAGE           REPORT
          │               │               │
          └───────────────┼───────────────┘
                          ▼
                     QA PIPELINE
                          │
                   ┌──────┴──────┐
                   ▼             ▼
               Automated       AGY
                   │          Visual QA
                   └──────┬──────┘
                          ▼
                       CLAUDE
                       REVIEW
                          │
                    ┌─────┴─────┐
                    ▼           ▼
                  PASS        REWORK
                    │           │
                    ▼           └──────→ Agent
                 RELEASE
```

---

# 17. Đánh giá tính khả thi

| Thành phần | Đánh giá |
|---|---:|
| Claude gọi Codex CLI | ✅ Khả thi |
| Claude gọi AGY CLI | ✅ Khả thi |
| Task protocol bằng JSON | ✅ |
| Codex / AGY cùng repo | ✅ |
| Git-based handoff | ✅ |
| Parallel execution | ✅ |
| Image generation pipeline | ✅ |
| Automated QA | ✅ |
| Claude final review | ✅ |
| Retry / rework loop | ✅ |
| Cost optimization | ✅ Rất đáng làm |
| Full autonomous development | ⚠️ Cần guardrails |

---

# 18. Kiến trúc AIO v1 đề xuất

```text
AIO
│
├── Claude Adapter
│
├── Codex Adapter
│
├── Antigravity Adapter
│
├── Task Manager
│
├── Workflow Engine
│
├── Context Manager
│
├── Git Manager
│
├── Artifact Manager
│
├── QA Engine
│
├── Cost Tracker
│
└── Logger / Observability
```

### Claude Adapter

Nhận yêu cầu từ Claude và chuyển thành task chuẩn.

### Codex Adapter

Quản lý:

- Codex CLI.
- Input.
- Workspace.
- Timeout.
- Output.
- Exit status.
- Artifact collection.

### Antigravity Adapter

Quản lý:

- AGY CLI.
- Browser workflows.
- Visual tasks.
- Image tasks.
- Output collection.

### Task Manager

Theo dõi:

```text
queued
assigned
running
completed
failed
review
approved
rework
cancelled
```

### Workflow Engine

Cho phép định nghĩa:

```text
Plan
→ Execute
→ QA
→ Review
→ Rework
→ Approve
```

### Context Manager

Quản lý context tối thiểu cần thiết cho từng agent.

### Artifact Manager

Quản lý:

```text
code
images
screenshots
reports
logs
builds
test reports
```

### Cost Tracker

Theo dõi:

```text
agent
model
task
input tokens
output tokens
execution time
estimated cost
```

Điều này cho phép đo được Claude có thực sự tiết kiệm chi phí hay không.

---

# 19. Kết luận

Mô hình:

```text
Claude = CTO / Orchestrator / Reviewer

Codex = Engineering Executor

AGY = Visual / Product / Browser Executor

AIO = Infrastructure / Coordination Layer
```

là một hướng kiến trúc khả thi và có tiềm năng lớn.

Điểm quan trọng nhất không phải đơn giản là:

> "Claude gọi Codex và AGY."

Mà là xây dựng một **chuẩn giao tiếp giữa các agent**:

```text
Task
→ Context
→ Execution
→ Artifact
→ QA
→ Review
→ Decision
```

Nếu làm đúng, Claude sẽ không còn là agent làm mọi thứ mà trở thành **AI CTO điều phối một đội ngũ AI agents**.

Đây cũng là hướng phù hợp để phát triển các project lớn như SaaS, hosting panel, automation system, POD automation, mobile app và các hệ thống có cả code + visual asset + browser testing.
