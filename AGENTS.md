# 语言

- 全程使用简体中文进行回复和内容显示。
- 新增文档内容使用简体中文；代码中的现有英文标识符和 API 路径保持原样。

# Repository Guidelines

## 项目概览

- 本项目是 CUMS（课堂文件上传管理系统），使用 Rust 2021 和 Actix Web 构建。
- `Cargo.toml` 是依赖和构建入口，当前版本为 `2.3.3`；`Cargo.lock` 应与依赖变更保持同步。
- 运行时从程序工作目录（开发环境）或可执行文件所在目录（部署环境）读取 `config.json`，并创建 `uploads/`、`logs/`、`templates/`、`lessons/`、`lesson_media/` 目录。
- 当前仓库没有自动化 Rust 测试模块；修改后优先运行编译检查，并按 `docs/TESTING.md` 和 `test_api.ps1` 做手动/API 验证。

## 项目结构与模块组织

- `src/main.rs`：应用入口、日志初始化、端口探测、Actix Web 服务和路由注册。
- `src/handlers.rs`：学生端名单登录、密码修改、配置、文件上传、模板下载，以及管理端认证、名单、配置、模板、文件、统计、提交记录、密码和日志 API。
- `src/models.rs`：配置、学生名单、请求、响应和统计数据结构；作业配置兼容字符串数组和对象数组格式。
- `src/config.rs`：配置加载/保存、应用状态、上传目录初始化、管理员令牌、学生令牌和操作日志。
- `src/utils.rs`：文件扩展名白名单、文件名清理、模板路径校验、日志写入、客户端 IP、局域网 IP 和端口工具。
- `static/index.html`：学生端页面；`static/admin.html`：管理后台页面。页面由后端处理器直接返回。
- `config.json`：端口、版本、管理端开关/密码、学生名单及科目、班级、作业配置。学生名单存储在 `students` 对象中，密码以 `sha256:` 摘要保存。
- `templates/`：教师上传或预置的作业模板；`uploads/`：学生文件，按 `科目/班级/作业/` 分类保存；`lessons/`：课时 Markdown 正文，按 `科目/作业/课时.md` 保存；`lesson_media/`：课时图片、视频和附件；`logs/`：运行日志。
- `test_api.ps1`：针对本地服务的 PowerShell API 冒烟测试脚本，默认请求 `http://localhost:3000`。
- `docs/`：架构、API、配置、开发、部署和测试说明；`docs/archive/` 为历史归档文档。

## 构建、运行与格式化

- `cargo check`：快速检查当前代码是否可以编译。
- `cargo build`：构建开发版本；`cargo build --release`：构建发布版本。
- `cargo run`：启动开发服务，默认监听 `:3000`；启动前确保工作目录包含有效的 `config.json`。
- `cargo fmt --all`：格式化 Rust 代码；提交前可使用 `cargo fmt --all -- --check` 检查格式。
- `cargo clippy --all-targets --all-features -- -D warnings`：在本地依赖完整时执行静态检查。
- `cargo test`：执行 Cargo 测试命令；当前项目暂无自动化测试，因此主要用于确认测试目标仍可编译。
- `./test_api.ps1`：服务启动后运行 API 冒烟测试；该脚本会导入临时学生、验证默认密码和首次改密、验证学生令牌上传、管理端配置和模板上传/删除，并在结束时清理临时数据。
- 跨平台构建使用 Cargo target，例如 `cargo build --release --target x86_64-unknown-linux-gnu`；不要使用旧的 Go 构建命令。

## 开发流程与代码风格

- 修改前先查看相关处理器、模型和配置逻辑，优先修复根因，避免无关重构。
- Rust 代码遵循 `rustfmt`；函数和变量使用 `snake_case`，类型和导出项使用 `PascalCase`，常量使用 `SCREAMING_SNAKE_CASE`。
- 保持现有模块划分和 Actix Web 路由风格；新增 API 时同步更新 `src/main.rs`、`docs/API.md`，必要时更新 `test_api.ps1`。
- 前端 JavaScript 保持简洁，CSS 类名使用 kebab-case（如 `upload-form`）；学生端和管理端分别维护在对应 HTML 文件中。
- 不要添加无必要的行内注释、版权头或格式化无关文件；不提交构建产物、上传文件和运行日志。

## API 与手动验证

- 学生端主要入口为 `/`；管理端入口为 `/admin`。
- 学生端 API 包括 `/api/v1/login`、`/api/v1/student/password`、`/api/v1/config`、`/api/v1/upload`、`/api/v1/version`、`/api/v1/changelog` 和 `/api/v1/template`。登录使用后台名单中的学号和密码；新导入学生默认密码为 `000000`，首次登录必须修改密码。上传和改密使用 `X-Student-Token` 请求头。
- 管理端 API 使用 `X-Admin-Token` 请求头，包含登录、名单查询/导入/重置密码/删除、科目表格导入、配置、课时 Markdown 读取/保存、课时媒体上传、模板上传/删除、文件列表/删除、统计、提交记录、密码修改和操作日志接口；完整路径以 `src/main.rs` 和 `docs/API.md` 为准。名单导入支持 JSON、CSV/TSV 和管理页面 XLSX 文件；管理后台提供 XLSX 模板下载，科目导入支持 JSON、CSV/TSV 按行处理。
- 手动验证至少覆盖：配置加载、启动及端口占用回退、名单导入（JSON、CSV/TSV、XLSX）、默认密码登录、错误密码、首次改密、重置密码、学生令牌上传、课时 Markdown 读取/保存、课时媒体上传、合法/非法文件上传、上传目录创建、管理端正确/错误密码、未授权请求、模板路径校验和管理操作。
- API 测试前在一个终端运行 `cargo run`，另一个 PowerShell 终端运行 `./test_api.ps1`；不要在共享或生产数据目录直接运行会上传/删除文件的测试。

## 配置与安全

- `config.json` 中的 `admin_password` 仍为明文，仅应在可信网络中启用管理端；学生密码使用 `sha256:` 摘要保存。默认密码只用于新名单或管理员重置，首次登录后应立即修改；不要把真实密码写入提交或测试输出。
- 修改 `server_addr`（例如 `:8080`）后需重启服务；程序会在配置端口被占用时尝试后续端口。
- 学生文件上传扩展名受 `src/utils.rs` 白名单限制；课时媒体使用更小的图片、音视频、文档和压缩附件白名单。路径相关修改必须保留文件名清理和模板路径遍历防护；课时 Markdown 前端渲染必须继续限制 URL 协议，禁止 `javascript:` 等危险链接。
- 不要提交 `uploads/`、运行日志、密码、令牌或本地配置备份；这些内容已由 `.gitignore` 覆盖（`config.json` 本身是版本库文件，修改时注意不要写入敏感值）。

## 文档与已知过时文件

- 功能或接口变更时同步更新 `README.md`、相关 `docs/*.md` 和必要的手动测试说明。
- `build_and_run.bat` 仍是旧版 Go 流程，并且包含本机绝对路径；不要将其作为 Rust 构建入口，若要修复应单独提交针对该脚本的变更。
- `.github/workflows/ci.yml` 当前仍使用 Go toolchain 和 `go build`，与现有 Rust 项目不一致；修改 CI 前先确认发布目标和交叉编译方案，不要据此判断本地 Rust 构建失败。

## Git 与提交规范

- 不要在未明确要求时提交、创建分支或重置用户改动。
- 提交信息使用 Conventional Commits，例如 `feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`。
- 分支名沿用仓库现状；新分支优先使用 `feature/xxx`、`fix/xxx`、`docs/xxx`、`refactor/xxx`、`test/xxx` 或 `chore/xxx`。
- Pull Request 目标分支通常为 `develop`，应包含变更说明、关联 Issue（如有）和验证结果。
