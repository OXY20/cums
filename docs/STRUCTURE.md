# 项目结构说明

> 用途：说明仓库中每个目录、每个源文件分别属于哪个模块、承担什么职责。
> 面向读者：第一次接触本仓库的开发者，以及需要定位「某个功能写在哪个文件」的维护者。
> 与 [ARCHITECTURE.md](./ARCHITECTURE.md) 的分工：本文回答「文件在哪、干什么」，
> ARCHITECTURE.md 回答「为什么这么设计、数据怎么流动」。
>
> 对应代码版本：`develop` 分支，提交 `ed83622`。
> 规模：174 个文件，源码约 15,200 行（后端 Rust 6,437 行 / 前端 TS+Vue 8,787 行）。

---

## 一、整体架构一句话概括

**单端口部署**的校园教学资源平台：Rust + Axum 后端同时提供 API 和前端静态资源，
SQLite 存储数据，资源文件落盘到 `storage/`，教师端管理课程/课堂/作业，
学生端免登录浏览课程与提交作业。

```text
浏览器 ──► 后端 (Axum, :8080)
          ├── /api/*    业务接口（JWT 认证）
          ├── /files/*  文件下载（Range / ETag 流式）
          └── /*        前端 SPA 静态资源（app/web）
                    │
                    ├── SQLite（data/classroom.db，WAL 模式）
                    └── 文件存储（storage/{objects,staging,manifests}）
```

三处关键约定：

1. **前端构建产物由后端托管**，学生只需访问一个地址，无需额外起 Web 服务器。
2. **课程是模板，课堂是场次**：教师改课程模板不会影响已经上过的课（靠 `lesson_snapshot` 快照解耦）。
3. **学生端免登录**：学生提交作业不要求 JWT，但来源 IP 一律由服务端从连接信息解析，客户端无法伪造。

---

## 二、仓库顶层目录

| 目录 / 文件 | 作用 | 是否入库 |
|---|---|---|
| `backend/` | Rust + Axum 后端源码、数据库迁移、依赖清单 | ✅ 入库 |
| `frontend/` | Vue 3 + TypeScript + Vite 前端源码、依赖清单 | ✅ 入库 |
| `docs/` | 项目文档与界面截图 | ✅ 入库 |
| `scripts/` | 验证、巡检、截图、种子、清理脚本 | ✅ 入库 |
| `templates/` | 教学模板样例（`文字处理/学生请假条.docx`） | ✅ 入库 |
| `.github/workflows/ci.yml` | 推送 `v*` tag 时触发的跨平台构建与发布 | ✅ 入库 |
| `AGENTS.md` | 仓库级开发规范（结构约定、构建命令、提交规范） | ✅ 入库 |
| `README.md` | 项目总览、快速开始、已实现功能、验证结果、API 一览 | ✅ 入库 |
| `app/config/config.toml` | 运行时配置（含自动生成的 `jwt_secret`） | ❌ 已被 `.gitignore` 排除 |
| `app/logs/` | 服务日志，按天滚动 | ❌ 已被 `.gitignore` 排除 |
| `app/web/` | 前端构建产物 | ❌ 已被 `.gitignore` 排除 |
| `data/classroom.db` | SQLite 数据库 | ❌ 已被 `.gitignore` 排除 |
| `storage/{objects,staging,manifests}/` | 资源文件、暂存区、资源包清单 | ❌ 已被 `.gitignore` 排除 |
| `backups/` | 数据库与配置备份 | ❌ 已被 `.gitignore` 排除 |

---

## 三、后端：`backend/`

```text
backend/
├─ Cargo.toml / Cargo.lock   # 依赖与构建入口
├─ migrations/               # 数据库结构，按序号递增
└─ src/
   ├─ main.rs                # 入口、路由组装、日志、端口回退
   ├─ config.rs              # 配置加载与目录初始化
   ├─ db.rs                  # 连接池与迁移
   ├─ auth.rs                # Argon2 口令哈希与 JWT
   ├─ error.rs               # 统一错误响应
   ├─ models.rs              # 请求与响应结构
   ├─ richtext.rs            # 富文本清洗
   ├─ state.rs               # 共享状态与事件总线
   └─ routes/                # 各业务路由
```

### 3.1 入口与支撑层（8 个文件，1,034 行）

| 文件 | 行数 | 模块作用 | 关键内容 |
|---|---|---|---|
| `main.rs` | 180 | **服务入口与路由组装** | `build_router()` 合并 API 并挂载 SPA 回退；`bind_with_fallback()` 端口被占用时自动回退后续 20 个端口；`init_logging()` 同时输出到控制台与 `app/logs/server.log`（按天滚动）；`shutdown_signal()` 处理 Ctrl+C / SIGTERM 优雅退出；`uptime_seconds()` 供健康检查使用 |
| `config.rs` | 213 | **配置加载与目录初始化** | `AppConfig { server, database, storage, auth, limits }`；`ResolvedConfig::load()` 从 `app/config/config.toml` 读取，缺 `jwt_secret` 时自动生成 32 字节随机密钥并回写文件；`ensure_dirs()` 创建 `storage/*`、`app/logs`、`backups` 等目录 |
| `db.rs` | 62 | **连接池与迁移** | `init_pool()` 开启 WAL 模式 + `foreign_keys(true)` + 10 秒 busy_timeout；`sqlx::migrate!()` 自动应用 0001~0007 迁移；`ensure_bootstrap_admin()` 首次启动创建 `admin / admin` 账号并打日志提醒改密 |
| `auth.rs` | 92 | **口令哈希与 JWT** | `hash_password()` / `verify_password()` 使用 Argon2id；`issue_token()` / `verify_token()` 签发校验 JWT（默认 12 小时）；定义 `Role { Admin, Teacher }` 与 `Claims { sub, username, role, exp, iat }` |
| `error.rs` | 111 | **统一错误响应** | `AppError` 九个变体映射到稳定机器码（`bad_request`/`unauthorized`/`forbidden`/`not_found`/`conflict`/`range_not_satisfiable`/`database_error`/`io_error`/`internal_error`）与 HTTP 状态；5xx 对客户端只返回「服务器内部错误」，真实原因仅写日志 |
| `models.rs` | 687 | **请求与响应数据结构** | 51 个 `pub struct` / `pub enum`：`ListResponse<T>`、`CourseRow`、`LessonRow`、`SubmissionRow`、`LessonReviewBoard`、`HealthResponse` 等，路由层直接复用 |
| `richtext.rs` | 445 | **富文本 XSS 清洗** | `sanitize()` 基于 `ammonia` 白名单：只保留排版标签与内联样式；`a[href]` 仅允许 http/https/mailto；`img`/`video` 的 `src` 仅允许站内 `/files/` 路径；`referenced_resource_ids()` 提取正文引用的资源 ID；`is_effectively_empty()` 把 `<p><br></p>` 归一化为空串 |
| `state.rs` | 49 | **共享状态与事件总线** | `AppState { db, config, events }`；`broadcast::Sender<SessionEvent>` 容量 512；`publish()` / `subscribe()` 供 SSE 使用 |

### 3.2 业务路由层：`backend/src/routes/`（14 个文件）

`routes/mod.rs`（84 行）本身不注册业务端点，承担两件事：

- **模块声明与路由合并**：`api_router()` 用 `Router::merge()` 逐个合并 13 个子模块的 `routes()`。
- **认证提取器**：`AuthUser` 从 `Authorization: Bearer <token>` 解析 JWT，提供 `require_admin()` 与 `id()`。

**没有全局 auth 中间件**——权限完全由处理器签名决定，形成三级分层：

| 层级 | 判定方式 | 典型端点 |
|---|---|---|
| 公开 | 处理器不取 `AuthUser` | `/api/student/*`、`/api/events`、`/api/version`、`/files/{id}` |
| 教师 | 处理器取 `AuthUser` | `/api/courses`（写）、`/api/resources`、作业提交与审阅、名单与统计 |
| 管理员 | 处理器调用 `require_admin()` | `/api/admin/health`、`/api/admin/audit-logs`、`/api/admin/storage`、班级创建与授权 |

| 文件 | 行数 | 业务模块 | 主要端点 |
|---|---|---|---|
| `mod.rs` | 84 | **路由汇总与认证提取器** | `api_router()`、`AuthUser`（`require_admin()` / `id()`） |
| `auth.rs` | 137 | **认证** | `POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/password`；同时对外提供全项目唯一的审计写入入口 `audit()` |
| `classes.rs` | 259 | **班级与教师授权** | `GET/POST /api/classes`、`GET/PUT/DELETE /api/classes/{id}`、`/api/classes/{id}/teachers`、`GET /api/teachers` |
| `courses.rs` | 365 | **课程与封面** | `GET /api/student/courses`（仅已发布）、`GET/POST /api/courses`、`GET/PUT/DELETE /api/courses/{id}`、`POST /api/courses/{id}/copy`、`POST/DELETE /api/courses/{id}/cover` |
| `lessons.rs` | 328 | **课时与课时步骤** | `GET/POST /api/courses/{course_id}/lessons`、`GET/PUT/DELETE /api/lessons/{id}`、`/api/lessons/{id}/steps`；`fetch_lesson()` 是全项目复用度最高的函数 |
| `blocks.rs` | 245 | **课时正文块** | `/api/lessons/{lesson_id}/blocks`、`/blocks/reorder`（事务内重排）、`/api/blocks/{id}`；旧版块结构，与 HTML 正文并存 |
| `resources.rs` | 509 | **资源库与上传管线** | `GET /api/resources`、`POST /api/resources/register`、`POST /api/resources/{id}/upload`、`GET/DELETE /api/resources/{id}`、`POST /api/lessons/{id}/resources/upload`；`safe_join()` 是路径穿越防护的统一入口 |
| `sessions.rs` | 341 | **课堂场次** | `GET /api/student/current-session`、`GET/POST /api/sessions`、`GET /api/sessions/{id}`、`POST /api/sessions/{id}/start\|pause\|end`；`lesson_snapshot` 内容快照保证模板修改不影响历史课堂 |
| `submissions.rs` | 1083 | **作业提交与审阅**（最大文件） | `POST /api/student/submissions`（多文件、免登录）、`/api/student/submissions/status`、`/api/admin/submissions`、`/batch-review`、`/{id}/review`；三档重复判定（学号 → 设备 → 班级级保守提醒） |
| `students.rs` | 763 | **班级名单与作业统计** | `GET/POST /api/classes/{id}/students`、`/students/import`、`/api/courses/{id}/homework-overview`、`/api/lessons/{id}/submission-board`、`/api/lessons/{id}/review-board` |
| `files.rs` | 277 | **文件下载** | `GET/HEAD /files/{id}`；支持 Range 部分内容（206）、ETag（SHA-256）、1 MiB 分块流式、`Accept-Ranges: bytes`、`inline=1` 内联预览 |
| `events.rs` | 43 | **SSE 实时事件流** | `GET /api/events`；15 秒心跳，推送 `session.started` / `session.paused` / `session.ended` |
| `admin.rs` | 147 | **运维监控** | `GET /api/admin/health`、`/api/admin/audit-logs`、`/api/admin/storage`（三者均需管理员角色） |
| `meta.rs` | 17 | **公开元信息** | `GET /api/version`（全项目唯一完全无状态依赖的处理器） |

### 3.3 路由层跨模块调用关系

`pub` 函数即 routes 层内部 API，依赖方向如下：

```text
auth::audit()                    ← 8 个写操作模块全部调用（classes/courses/lessons/blocks/
                                    resources/sessions/students/submissions）
lessons::fetch_lesson()          ← blocks、resources、sessions、submissions
resources::fetch_resource()      ← courses、blocks、files
resources::safe_join()           ← courses、files、submissions
resources::store_file_field()    ← 全项目唯一的文件落盘实现（被作业提交复用）
resources::create_staging_resource() ← submissions（作业上传占位）
blocks::fetch_blocks()           ← lessons（课时详情聚合）
classes::fetch_class()           ← students
submissions::build_detail_from() ← students（审阅看板逐份补文件）
submissions::submission_select_sql() ← students（列表与详情字段保持一致）
students::count_roster_submitters() ← submissions（未交人数统计）
                                   ◀── students ↔ submissions 是唯一一对双向依赖
```

---

## 四、数据库：`backend/migrations/`（7 个迁移，16 张表）

| 迁移文件 | 内容 |
|---|---|
| `0001_init.sql` | 基础结构 13 张表：`users`、`classes`、`teacher_classes`、`courses`、`lessons`、`lesson_steps`、`resources`、`lesson_resources`、`resource_bundles`、`classroom_sessions`、`session_events`、`download_jobs`、`audit_logs`。含「同班唯一活动课堂」的部分唯一索引 `uniq_active_session_per_class` |
| `0002_lesson_blocks.sql` | `courses.cover_resource_id`、`lesson_resources.kind`（content / attachment）、新增 `lesson_blocks` 表 |
| `0003_rich_content.sql` | `lessons.content_html` + `content_format`（`blocks` / `html`），正文从块结构转向 HTML 富文本 |
| `0004_homework_submissions.sql` | `homework_submissions` + `homework_submission_files` 表，含 `duplicate_flag` / `duplicate_of` |
| `0005_submission_device.sql` | `homework_submissions.device_id`，按设备识别「这台机器是否已交过」 |
| `0006_class_students.sql` | `class_students` 表（学号在班内唯一）、`homework_submissions.student_no` |
| `0007_submission_review.sql` | `review_label` / `review_score` / `review_comment` / `reviewed_at` / `reviewed_by` 列与筛选索引 |

**核心表职责**

| 表 | 职责 |
|---|---|
| `users` | 管理员与教师账号，`password_hash` 存 Argon2id 摘要 |
| `classes` / `teacher_classes` | 班级（机房）与教师授课授权 |
| `courses` / `lessons` / `lesson_steps` | **可复用模板**：课程、课时、课时步骤 |
| `resources` / `lesson_resources` / `resource_bundles` | 资源元数据、课时-资源多对多关联、资源包清单 |
| `classroom_sessions` / `session_events` | **真实授课场次**（含 `lesson_snapshot` 内容快照）与课堂事件流水 |
| `download_jobs` | 下载汇总，只记必要事件，不写高频进度 |
| `audit_logs` | 审计日志 |
| `class_students` | 班级学生名单（学号唯一），挂在班级而非课程上——「谁该交」取决于具体班级 |
| `homework_submissions` / `homework_submission_files` | 作业提交记录与文件关联（文件本体仍复用 `resources`） |

---

## 五、前端：`frontend/`

```text
frontend/
├─ package.json / package-lock.json   # 依赖与脚本入口
├─ index.html                         # Vite 入口 HTML
├─ vite.config.ts                     # 别名、代理、产物输出目录
├─ tsconfig.json                      # TypeScript 严格模式
├─ public/icon.svg                    # 站点图标
└─ src/
   ├─ main.ts                         # 应用入口
   ├─ App.vue                         # 应用外壳
   ├─ api/                            # 接口客户端
   ├─ router/                         # 路由与登录守卫
   ├─ stores/                         # Pinia 状态
   ├─ views/                          # 学生端与教师端页面
   ├─ components/                     # 公共组件
   ├─ utils/                          # 格式化工具
   └─ styles/main.css                 # 全局样式
```

### 5.1 基础层（7 个文件）

| 文件 | 行数 | 作用 |
|---|---|---|
| `main.ts` | 17 | 应用入口：挂载 Pinia、Router、Element Plus（中文 locale）、全局样式 |
| `App.vue` | 178 | 应用外壳：顶部导航（未登录仅显示「登录」）、路由出口、版本号、用户下拉菜单 |
| `api/index.ts` | 932 | **接口客户端**（全项目唯一 API 出口）。三个传输层函数：<br>`request()`——fetch，JSON 请求体，注入 Bearer 头，把后端 `{error:{code,message}}` 转成 `ApiError`<br>`submitWithProgress()`——XHR，**表单字段 + 多文件**，仅 `api.submitHomework` 使用<br>`uploadWithProgress()`——XHR，**单文件带进度**，用于资源 / 封面 / 课时内资源上传<br>另含 `fileUrl()` / `inlineFileUrl()`、31 个 TS 接口类型，`api` 门面聚合 40+ 个方法并按「认证 / 课堂 / 课程 / 课时 / 资源 / 名单 / 提交 / 统计 / 系统」分组 |
| `router/index.ts` | 102 | 路由表：学生端 4 个 + 登录 1 个 + 教师端 8 个（嵌套在 `AdminLayout` 下，父级 `meta.requiresAuth` 由 vue-router 的 meta 合并规则自动下发给所有子路由）；`beforeEach` 守卫检查 `meta.requiresAuth`。**守卫只校验令牌是否存在**（读 localStorage），有效性由 `App.vue → auth.restore() → api.me()` 校验 |
| `stores/auth.ts` | 53 | Pinia 认证状态：`login` / `logout` / `restore`；令牌存 localStorage（键 `classroom.token`）；`ready` 标志避免刷新时闪烁 |
| `utils/format.ts` | 160 | 格式化：`formatBytes`、`formatTime`（UTC → 本地时区）、各状态文案、`formatSpeed`、`formatRemaining` |
| `styles/main.css` | 496 | 全局样式：布局、卡片、课程网格、状态标签、富文本展示、Quill 排版类补充、窄屏适配 |

### 5.2 公共组件 `components/`（5 个）

| 组件 | 行数 | 作用 |
|---|---|---|
| `RichTextEditor.vue` | 345 | Quill 2 论坛式编辑器：字号 / 标题 / 加粗 / 颜色 / 对齐 / 列表 / 引用 / 代码块 / 链接 / 图片 / 视频；`onUpload` 回调直传并插入 `/files/{id}` |
| `HomeworkSubmitDialog.vue` | 980 | 作业上传弹窗：打开时先查「本设备是否已提交过」→ 填写姓名、选多个文件 → 弹窗内即时预览 → 上传进度 / 实时速度 / 预计剩余时间 |
| `CourseHomeworkPanel.vue` | 561 | 课程作业统计：上层课时看板（一眼看全班进度），下层已交 / 未交明细，未交名单可一键复制 |
| `SubmissionPreview.vue` | 288 | 文件预览分流：图片内嵌、视频 `<video>`、PDF `<iframe>`、其他类型给下载入口 |
| `SubmissionResultDialog.vue` | 177 | 提交成功预览弹窗：展示提交人、时间、来源 IP、重复标记 |

### 5.3 学生端页面 `views/`（5 个）

| 页面 | 路由 | 行数 | 作用 |
|---|---|---|---|
| `StudentHome.vue` | `/student` | 138 | 当前课堂卡片 + 全部课程网格；SSE 订阅 + 30 秒轮询兜底；**未登录也可浏览** |
| `CourseHome.vue` | `/student/courses/:courseId` | 366 | 课时列表 + 资源下载 + 作业上传入口（触发 `HomeworkSubmitDialog`） |
| `SessionDetail.vue` | `/student/sessions/:id` | 254 | 课堂详情：文字取自**课堂快照**，媒体与附件取自课时资源 |
| `DownloadCenter.vue` | `/student/downloads` | 97 | 下载中心（浏览器无法跨会话保留下载进度，本页只记录本次会话） |
| `LoginView.vue` | `/login` | 124 | 教师 / 管理员共用登录入口，支持 `?redirect=` 回跳 |

### 5.4 教师端页面 `views/admin/`（9 个）

| 页面 | 路由 | 行数 | 作用 |
|---|---|---|---|
| `AdminLayout.vue` | `/admin` | 125 | 左侧导航（6 项）+ 内容区，窄屏折叠为图标条 |
| `ConsoleView.vue` | `/admin/console` | 293 | **课堂控制台**：选班级 → 课程 → 课时 → 开始 / 暂停 / 结束，可预览学生页 |
| `CourseListView.vue` | `/admin/courses` | 301 | 课程管理：新建、封面上传、复制、停用、删除 |
| `CourseDetailView.vue` | `/admin/courses/:courseId` | 519 | **课时编辑器**：富文本正文 + 附件管理 + 作业统计面板 |
| `ResourceView.vue` | `/admin/resources` | 212 | 资源库：两步上传（登记 → 上传）、SHA-256 去重提示、删除 |
| `SubmissionView.vue` | `/admin/submissions` | 651 | 提交记录：按课程 / 课时 / 审阅标签筛选、「仅看重复提交」、逐条预览 |
| `LessonReviewView.vue` | `/admin/lessons/:id/review` | 905 | **批量批改**：顶部统计与筛选 → 中部可多选列表 → 右侧抽屉逐份打分写评语 |
| `RosterView.vue` | `/admin/roster` | 387 | 班级名单：粘贴文本批量导入（学号 + 姓名）、增删条目 |
| `SystemView.vue` | `/admin/system` | 126 | 系统状态：健康检查、存储占用、审计日志 |

---

## 六、脚本：`scripts/`（58 个文件：57 个 `.mjs` + 1 个 `.py`）

**技术特点**：三类实现，**没有引入第三方测试框架依赖**。

| 技术 | 用途 |
|---|---|
| Chrome DevTools Protocol（CDP over WebSocket，连 `http://127.0.0.1:9222`） | 真实浏览器交互验证与截图；支持 `Emulation.setTimezoneOverride`（多时区）、`Network.emulateNetworkConditions`（限速） |
| `node:sqlite` 的 `DatabaseSync`（只读） | 直接查库巡检数据状态 |
| 纯 HTTP `fetch` + Bearer Token | 接口层回归验证 |

| 类别 | 数量 | 文件与用途 |
|---|---|---|
| **验证** `verify-*.mjs` | 26 | `verify-homework-submission`（接口层 46 项）、`verify-review-api`（66 项）、`verify-roster-stats`（60 项）、`verify-duplicate-logic`（22 项）、`verify-device-hint`（21 项）、`verify-richtext`（HTML 清洗）、`verify-quill-classes`（Quill 排版 class 保留）、`verify-session-snapshot`（快照存富文本）、`verify-inline-upload` / `verify-inline-ui`（课程管理内直接上传）、`verify-largefile`（200 MiB 流式 + Range）、`verify-format-time`（直接读 `format.ts` 源码执行，避免复刻逻辑造成假结论）；界面层：`verify-homework-ui`、`verify-review-ui`、`verify-roster-ui`、`verify-submit-dialog-ui`、`verify-student-roster-pick`、`verify-seeded-ui`、`verify-admin-ui`、`verify-richtext-ui`、`verify-upload-speed`、`verify-timezone`、`verify-timezone-matrix`；远端校验：`verify-remote`（分支与提交信息逐字比对）、`verify-remote-files`（文件存在性 + 运行时数据泄露检查） |
| **巡检** `inspect-*.mjs` | 8 | **全部只读**（`readOnly: true`），是排查数据状态的首选入口：`inspect-schema`（全部表结构与行数）、`inspect-db`（迁移记录与数据量）、`inspect-course-stats`、`inspect-lessons`、`inspect-submission`、`inspect-storage`（占用与可清理文件）、`inspect-dangling`（库中有、磁盘无的失效资源）、`inspect-titles`（区分测试数据与演示数据） |
| **截图** `capture-*.mjs` | 7 | `capture`（基础工具，CDP 显式等待后截图，避免 SSE 长连接导致 `--virtual-time-budget` 无法结束）、`capture-all`、`capture-admin`、`capture-homework`、`capture-roster`、`capture-review`、`capture-submit-dialog`、`capture-upload-speed`（CDP 限速才能截到中间帧） |
| **种子** `seed-*.mjs` | 4 | `seed-demo-data`（主，702 行：3 个班 × 30 人、4 门课程、10 个课时、214 条提交、121 份批改，并用 `node:sqlite` 事务把时间摊到合理区间）、`seed-demo`、`seed-inline-demo`、`seed-richtext-demo` |
| **清理** `cleanup-*.mjs` | 4 | `cleanup-test-data`（按标题匹配删除，遇 409 改为置 `archived`）、`cleanup-roster-data`、`cleanup-storage`（孤立文件/失效记录/大文件，支持 `--min-mb`）、`cleanup-staging` |
| **冒烟** `smoke-*.mjs` | 2 | `smoke-test`（8 组 69 项：认证权限、班级、课程课时、课堂控制含并发 409 与快照稳定、资源库与大文件含 Range 六种边界与路径穿越防护、审计监控、SSE、清理）、`smoke-roster-workflow`（按教师真实操作顺序走一遍名单/统计链路） |
| **工具** | 6 | `reset-data.mjs`（按外键依赖顺序清空 16 张表并清空 storage，**需先停服务**）、`status-check.mjs`（服务与数据概览）、`check-autopick.mjs`（作业统计面板班级自动选中行为）、`page-text.mjs` / `peek-page.mjs`（CDP 提取页面可见文本）、`make-fixtures.py`（见下） |

### `scripts/make-fixtures.py`（776 行，唯一 Python 脚本）

生成演示用作业文件池到 `scripts/fixtures/`（已被 `.gitignore` 忽略），再由 `seed-demo-data.mjs` 上传。依赖 Pillow、python-docx、openpyxl，以及 PATH 中的 `ffmpeg`（缺失时只跳过视频）。

产出 31 个文件：3 个 docx、2 个 xlsx、9 张模拟应用截图（Word / Excel / PowerPoint / 代码编辑器界面）、2 张照片、2 个 PDF 实验报告、4 个 .py、2 个 .md、1 个 zip 素材包、4 张课程封面、2 个 mp4。

> **写库脚本约定**：`cleanup-*`、`reset-data`、`seed-demo-data` 默认只预演打印，需 `--yes` 才真正执行；`inspect-*` 全部只读。**不要在生产数据目录运行任何脚本。**

---

## 七、文档：`docs/`

### 7.1 现行文档（有效）

| 文档 | 面向读者 | 内容主题 |
|---|---|---|
| `../README.md`（仓库根） | 全体 | 项目总览、目录结构、快速开始、六阶段已实现功能、验证结果、关键设计说明、配置说明、API 一览 |
| `ARCHITECTURE.md` | 开发 / 运维 | 总体架构、数据模型、并发控制、大文件传输、作业提交与审阅口径、时区、实时同步、安全设计、模块划分 |
| `STRUCTURE.md`（本文） | 开发 / 维护 | **文件与模块职责对照表** |
| `DEPLOYMENT.md` | 运维 | 环境要求、部署步骤、备份与恢复 |
| `TESTING.md` | 测试 / 开发 | 手动验证清单与前置准备 |
| `REQUIREMENTS.md` | 产品 | 需求功能文档 v2.0（**需求资料，不是运行说明**） |
| `画板原型与实际页面差异清单.md` | 设计 | 画板原型与实际页面的差异对照 |
| `界面重新设计需求说明.md` | 设计 | 在其他设计软件重做界面时的参考依据 |

### 7.2 归档文档（`docs/archive/`，仅供追溯）

- `legacy-cums/` —— 旧版 Actix Web 单页实现的文档：`API.md`、`CONFIG.md`、`DEVELOPMENT.md`、`CONTRIBUTING.md`、`ISSUES.md`、`README.md`、`INDEX.md`
- 重构与评审历史 —— `REFACTORING_2026_01_21.md`、`REFACTOR_DESIGN.md`、`PROJECT_REVIEW.md`、`REQUIREMENTS-master-docs-base.md`
- 重复入口与实验方案 —— `README_CENTER.md`、`TAURI_GUI.md`、`TAURI_QUICKSTART.md`
- 历史问题清单 —— `待修复问题清单.md`

归档索引见 [ARCHIVE.md](./ARCHIVE.md)。**旧版 CUMS（Actix）文档描述的是已归档的实现，修改新平台时不要以它们为准。**

---

## 八、构建配置

| 文件 | 作用 |
|---|---|
| `backend/Cargo.toml` | 后端依赖：`axum 0.8`（multipart）、`tokio`、`sqlx 0.8`（sqlite/chrono/migrate）、`argon2 0.5`、`jsonwebtoken 9`、`ammonia 4.2`、`tracing` + `tracing-appender`、`sha2`、`mime_guess`、`toml` |
| `frontend/package.json` | 前端依赖：`vue 3.5`、`vue-router 4.5`、`pinia 2.3`、`element-plus 2.9`、`quill 2.0`；脚本 `dev` / `build` / `build:only` / `typecheck` |
| `frontend/vite.config.ts` | 别名 `@` → `src`；构建产物输出 `../app/web`；开发时把 `/api` 与 `/files` 代理到 `127.0.0.1:8080` |
| `frontend/tsconfig.json` | TypeScript 严格模式 |
| `.github/workflows/ci.yml` | 推送 `v*` tag 触发：前端 `npm ci && npm run build:only` → 后端 `cargo build --release` → 打包 Linux(x86_64) 与 Windows(msvc) 双平台 zip → 上传 GitHub Release |
| `.gitignore` | 排除运行时数据（`data/`、`storage/`、`backups/`、`app/logs/`、`app/web/`）、含密钥的 `app/config/config.toml`、构建产物（`backend/target/`、`frontend/node_modules/`）、演示素材（`scripts/fixtures/`） |

---

## 九、值得关注的架构特征

1. **单一上传管线**：`resources::store_file_field()` 被「资源库上传」「课时内直传」「课程封面上传」「作业多文件提交」四处复用，大小上限、SHA-256 校验、空文件拒绝、staging → objects 原子改名只实现一次。
2. **路径安全双保险**：`safe_join()` 同时做组件级校验（拒绝 `..`、绝对路径、盘符前缀）与目录级校验（`canonicalize` 后比较，防符号链接逃逸），是所有磁盘读写的统一入口。
3. **模板与场次分离**：`lesson_snapshot` 保存上课时的内容快照，模板后续修改不影响历史课堂；`build_view()` 兼容新旧两种快照格式。
4. **名单口径统一**：「学号优先、姓名兜底」贯穿三个统计接口，兼容没有学号的历史提交数据。
5. **双看板视角互补**：`submission-board` 按学生聚合回答「谁没交」，`review-board` 按提交展开回答「这一份打什么分」。
6. **不可伪造的来源 IP**：仅当 TCP 对端是回环地址（反向代理与服务同机）时才信任 `X-Forwarded-For` / `X-Real-Ip`。
7. **审阅补丁语义精确**：用 `Option<Option<f64>>` 区分「字段缺失 = 不改」与「显式 null = 清除分数」；更新后二次判断 `reviewed_at`，避免 SQLite `SET` 读到旧值。

## 十、可清理项与已发现的不一致

### 10.1 后端：定义但无人使用的配置与表

| 项 | 状态 |
|---|---|
| `resource_bundles` 表 | 迁移 0001 创建，无任何路由读写 |
| `config.manifests_dir` | 目录会被创建，但无代码写入 |
| `limits.max_concurrent_downloads` / `limits.per_client_rate_kib` | 未在 `files.rs` 生效，下载未做并发与限速控制 |
| `download_jobs.status = 'downloading'` | 健康检查统计该状态，但写入方只写 `'completed'`，该计数恒为 0 |
| `lessons.content_format` 默认值 `'blocks'` | 保留旧数据兼容，当前主编辑方式已是 HTML |

### 10.2 前端：定义但无人调用的 API 封装

以下 `api` 方法在 `frontend/src` 中零调用（后端路由仍然存在）：

`changePassword`、`createClass`、`addClassStudent`、`attachResource`、`studentSubmission`，以及整组旧版正文块接口 `blocks` / `createBlock` / `updateBlock` / `deleteBlock` / `reorderBlocks`；工具函数 `isVideoFile` 也无人引用——富文本编辑器已完全取代「正文块」模式。

### 10.3 其他可清理点

| 项 | 状态 |
|---|---|
| `stores/auth.ts` 的 `isAdmin` getter | 定义了但全仓库无消费方；而 `/api/admin/health` 后端要求 admin 角色，`/admin/system` 路由只要求登录 → `role:'teacher'` 账号进入系统状态页会 403 |
| `stores/auth.ts` 的 `ready` 状态 | 只在 store 内部读写，无消费方 |
| `views/StudentHome.vue` | `import { useAuthStore }` 并实例化 `auth`，但模板与逻辑均未使用 |
| `api/index.ts` 的 `request()` | `JSON.parse(text)` 未包 `try/catch`，若后端返回非 JSON（如代理 502 HTML 页）会抛 `SyntaxError` 而非 `ApiError` |
| `templates/文字处理/学生请假条.docx` | 旧版 CUMS「科目模板文件」约定的遗留物；新代码全库零引用，但文件仍被 git 跟踪（`.gitignore` 第 59 行 `/templates/` 虽匹配它，已跟踪文件不受忽略规则影响） |

### 10.4 文档引用不一致

| 问题 | 说明 |
|---|---|
| `README.md:455` 引用 `docs/API.md` | 该文件已随旧版 CUMS 一起移入 `docs/archive/legacy-cums/API.md`，`docs/` 根目录下并不存在 |
| `docs/ARCHIVE.md` 与 `README.md` 文档清单 | 两处「现行文档」列表不完全一致 |
| 三份需求类文档 | `docs/REQUIREMENTS.md`、`docs/界面重新设计需求说明.md`、`docs/画板原型与实际页面差异清单.md` 描述的是**旧版单页 HTML / Actix 实现**，不是当前 Axum + Vue 3 架构，不宜作为当前实现的依据 |

---

## 附：按需求查文件

| 我想改…… | 去这些文件 |
|---|---|
| 登录 / 令牌策略 | `backend/src/auth.rs`、`backend/src/routes/auth.rs`、`frontend/src/stores/auth.ts` |
| 课程与课时的增删改查 | `backend/src/routes/courses.rs`、`lessons.rs`、`backend/src/models.rs` |
| 富文本编辑器能力 | `frontend/src/components/RichTextEditor.vue`、`backend/src/richtext.rs`、`frontend/src/styles/main.css`（Quill 排版类） |
| 文件上传 / 下载 / 大文件 | `backend/src/routes/resources.rs`、`files.rs`、`frontend/src/api/index.ts`（XHR 上传） |
| 作业提交链路 | `backend/src/routes/submissions.rs`、`frontend/src/components/HomeworkSubmitDialog.vue`、`SubmissionResultDialog.vue` |
| 作业批改与统计 | `backend/src/routes/students.rs`、`submissions.rs`、`frontend/src/views/admin/LessonReviewView.vue`、`components/CourseHomeworkPanel.vue` |
| 班级名单导入 | `backend/src/routes/students.rs`（`parse_roster()`）、`frontend/src/views/admin/RosterView.vue` |
| 课堂控制与实时推送 | `backend/src/routes/sessions.rs`、`events.rs`、`backend/src/state.rs`、`frontend/src/views/admin/ConsoleView.vue`、`views/StudentHome.vue` |
| 路由与登录守卫 | `frontend/src/router/index.ts`、`backend/src/routes/mod.rs`（`AuthUser`） |
| 数据库结构 | `backend/migrations/00XX_*.sql`（**新增迁移，不改已发布迁移**） |
| 错误码与响应格式 | `backend/src/error.rs`、`frontend/src/api/index.ts`（`ApiError`） |
