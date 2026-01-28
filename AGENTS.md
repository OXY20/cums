# Repository Guidelines

## 项目结构与模块组织

- `main.go` 为 Go 后端入口，`embed.go` 负责静态资源嵌入。
- `static/` 包含前端页面（`index.html` 学生端、`admin.html` 管理端）。
- `templates/` 存放模板文件（例如 `templates/文字处理/`）。
- `config.json` 为核心配置（端口、科目、班级、管理端开关等）。
- 运行时会生成 `uploads/` 与 `logs/` 数据目录。
- 详细说明见 `docs/`（架构、API、开发、测试、部署）。

## 构建、测试与本地运行

- `go run main.go`：本地启动服务（默认 http://localhost:3000）。
- `go build -o cums.exe .`：编译 Windows 可执行文件。
- `build_and_run.bat`：Windows 一键检查 Go、构建并运行。
- `gofmt -s -w .`：格式化所有 Go 代码。
- 跨平台编译示例：`GOOS=linux GOARCH=amd64 go build -o cums-linux .`

## 代码风格与命名规范

- Go：强制 `gofmt`；局部变量用 camelCase，导出项用 PascalCase。
- 包名：小写、简短；常量使用 `SCREAMING_SNAKE_CASE`。
- 前端：保持 JS 简洁；CSS 类名用 kebab-case（如 `upload-form`）。

## 测试指南

- 当前仓库暂无自动化 Go 测试。
- 变更后请按 `docs/TESTING.md` 的手动清单验证。
- 重点验证配置生成、上传路径创建、管理端登录流程。

## 提交与 Pull Request 规范

- 使用 Conventional Commits：`feat:`、`fix:`、`docs:`、`refactor:`、`chore:` 等。
- 分支命名：`feature/xxx`、`fix/xxx`、`docs/xxx`、`refactor/xxx`、`test/xxx`、`chore/xxx`。
- PR 目标分支为 `develop`，需包含清晰描述、关联 Issue（如有）与测试说明。

## 安全与配置提示

- `config.json` 中的 `admin_password` 为明文，仅在可信网络启用管理端。
- 端口被占用时请修改 `server_addr`（例如 `:8080`）并重启。

## 语言

- 全程使用简体中文进行回复和内容显示
