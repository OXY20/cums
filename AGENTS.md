# 语言

- 全程使用简体中文进行回复和内容显示。
- 新增文档内容使用简体中文；代码中的现有英文标识符和 API 路径保持原样。

# Repository Guidelines

## 项目概览

- 本项目是机房教学资源平台（课堂文件上传管理系统 CUMS 的新形态），使用 Rust 2021 + Axum + SQLx + SQLite 构建后端，Vue 3 + TypeScript + Element Plus 构建前端。
- 前身是仓库中的旧版 CUMS（Rust + Actix Web + 单页 HTML），已归档至分支 `archive/legacy-cums-actix`，不再在本分支维护。
- `backend/Cargo.toml` 是后端依赖与构建入口；`frontend/package.json` 是前端依赖与脚本入口。
- 运行时从 `CLASSROOM_ROOT` 环境变量指定的数据根目录（未设置时为可执行文件所在目录）读取 `app/config/config.toml`，并创建 `data/`、`storage/`、`backups/`、`app/logs/`、`app/web/` 目录。
- 当前仓库没有自动化测试模块；修改后优先运行 `cargo check` 与 `npm run typecheck`，并按 `docs/TESTING.md` 做手动验证。

## 项目结构与模块组织

```
cums/
├─ app/
│  ├─ config/config.toml        # 运行时配置（含 JWT 密钥，不入库）
│  ├─ logs/                     # 服务日志，按天滚动
│  └─ web/                      # 前端构建产物，由后端单端口托管
├─ backend/                     # Rust + Axum 后端
│  ├─ migrations/0001_init.sql  # 数据库结构，后续迁移按序号递增
│  ├─ Cargo.toml
│  └─ src/
│     ├─ main.rs                # 入口、路由组装、日志、端口回退
│     ├─ config.rs              # 配置加载与目录初始化
│     ├─ db.rs                  # 连接池与迁移
│     ├─ auth.rs                # Argon2 口令哈希与 JWT
│     ├─ error.rs               # 统一错误响应
│     ├─ models.rs              # 请求与响应结构
│     ├─ richtext.rs            # 富文本清洗
│     ├─ state.rs               # 共享状态与事件总线
│     └─ routes/                # 各业务路由（admin/auth/classes/courses/files/…）
├─ frontend/                    # Vue 3 + TypeScript + Vite
│  └─ src/
│     ├─ api/                   # 接口客户端
│     ├─ router/                # 路由与登录守卫
│     ├─ stores/                # Pinia 状态
│     ├─ views/                 # 学生端与教师端页面
│     └─ utils/                 # 格式化工具
├─ data/classroom.db            # SQLite 数据库（WAL 模式）
├─ storage/{objects,staging,manifests}  # 资源文件、暂存区与清单
├─ docs/                        # 项目文档与界面截图
└─ scripts/                     # 测试与验证脚本
```

## 构建、运行与格式化

- `cd backend && cargo check`：快速检查后端是否可编译。
- `cd backend && cargo build --release`：构建发布版本。
- `cd backend && cargo run`：启动开发服务，默认监听 `:8080`；`CLASSROOM_ROOT` 未设置时使用可执行文件所在目录。
- `cd backend && cargo fmt --all`：格式化 Rust 代码；提交前可用 `cargo fmt --all -- --check` 检查格式。
- `cd backend && cargo clippy --all-targets --all-features -- -D warnings`：静态检查。
- `cd frontend && npm install && npm run build`：构建前端，产物输出到 `app/web`。
- `cd frontend && npm run typecheck`：TypeScript + Vue 类型检查（`vue-tsc --noEmit`）。
- `cd frontend && npm run dev`：Vite 开发服务器（默认 5173），已配置 API 代理到 8080。
- 跨平台构建使用 Cargo target，例如 `cargo build --release --target x86_64-unknown-linux-gnu`。

## 开发流程与代码风格

- 修改前先查看相关处理器、模型和配置逻辑，优先修复根因，避免无关重构。
- Rust 代码遵循 `rustfmt`；函数和变量使用 `snake_case`，类型和导出项使用 `PascalCase`，常量使用 `SCREAMING_SNAKE_CASE`。
- 保持现有模块划分和 Axum 路由风格；新增 API 时同步更新 `backend/src/routes/mod.rs`、`docs/ARCHITECTURE.md` 与接口文档。
- 前端 TypeScript 保持严格模式；CSS 类名使用 kebab-case（如 `submission-board`）；学生端和管理端分别维护在 `frontend/src/views/` 下的对应文件。
- 数据库结构变更必须新增 `backend/migrations/00XX_*.sql` 迁移文件，不得直接修改已发布的迁移。
- 不要添加无必要的行内注释、版权头或格式化无关文件；不提交构建产物、上传文件和运行日志。

## API 与手动验证

- 学生端入口为 `/`；教师端入口为 `/admin/console`。
- 统一错误格式 `{ "error": { "code", "message" } }`；认证使用 JWT（`Authorization: Bearer <token>`）。
- 业务路由按领域分模块，完整路径以 `backend/src/routes/mod.rs` 与 `backend/src/routes/*.rs` 为准。
- 脚本目录 `scripts/` 下有大量验证脚本（`verify-*.mjs`）与巡检脚本（`inspect-*.mjs`），改动相关功能后应运行对应脚本回归。
- 手动验证至少覆盖：登录与令牌、课程/课时浏览、作业多文件上传、提交记录、名单导入、审阅看板、权限边界（未授权请求、越权访问他人班级）。
- 演示数据可由 `scripts/seed-demo-data.mjs` 生成，`scripts/reset-data.mjs` 与 `scripts/cleanup-*.mjs` 用于清理；不要在生产数据目录运行会写库的测试。

## 配置与安全

- `app/config/config.toml` 中的 `jwt_secret` 属敏感值，该文件已被 `.gitignore` 排除；不要把真实密钥写入提交或测试输出。
- 口令使用 Argon2id 哈希（`backend/src/auth.rs`），禁止明文存储或比较。
- 富文本内容经 `ammonia` 清洗（`backend/src/richtext.rs`），修改时不得放宽为允许 `javascript:` 等危险协议。
- 上传文件受 `backend/src/routes/files.rs` 的类型与大小白名单限制；路径相关修改必须保留文件名清理与目录穿越防护。
- 资源文件先写入 `storage/staging/`，校验后再发布到 `storage/objects/`，并更新 `storage/manifests/`；不要跳过暂存直接写正式目录。
- 不要提交 `data/`、`storage/`、`backups/`、`app/logs/`、`app/web/`、`app/config/config.toml`；这些内容已由 `.gitignore` 覆盖。

## 文档与已知过时文件

- 功能或接口变更时同步更新 `README.md`、`docs/ARCHITECTURE.md`、`docs/TESTING.md` 和必要的手动测试说明。
- 根目录 `docs/` 中仍保留部分旧版 CUMS 的历史文档（如 `API.md`、`CONFIG.md`、`DEVELOPMENT.md`），描述的是已归档的 Actix 实现，修改新平台时请勿以它们为准。
- `docs/REQUIREMENTS.md`、`docs/界面重新设计需求说明.md`、`docs/画板原型与实际页面差异清单.md` 是需求与设计资料，不是运行说明。

## Git 与提交规范

- 不要在未明确要求时提交、创建分支或重置用户改动。
- 提交信息使用 Conventional Commits，例如 `feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`。
- 分支名沿用仓库现状；新分支优先使用 `feature/xxx`、`fix/xxx`、`docs/xxx`、`refactor/xxx`、`test/xxx` 或 `chore/xxx`。
- 归档分支使用 `archive/xxx` 前缀（如 `archive/legacy-cums-actix`），只读用途，不再维护。
- Pull Request 目标分支通常为 `develop`，应包含变更说明、关联 Issue（如有）和验证结果。
