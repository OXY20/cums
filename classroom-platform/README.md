# 机房教学资源平台

面向学校计算机机房的局域网课程管理与教学资源分发平台。

本目录是依据《机房教学资源平台建设方案》V1.0 新建的独立工程，与仓库根目录下的 CUMS（课堂文件上传管理系统）并存，互不影响。

## 与 CUMS 的关系

| 项目 | 定位 | 技术栈 |
|------|------|--------|
| `cums/`（仓库根目录） | 课堂文件上传与作业提交 | Rust + Actix Web + 单页 HTML |
| `cums/classroom-platform/`（本目录） | 课程管理、课堂发布与大文件分发 | Rust + Axum + SQLx + SQLite，Vue 3 + TypeScript |

建设方案要求的技术栈（Axum、SQLx、Vue 3、Element Plus、SSE、HTTP Range）与 CUMS 现有的 Actix Web 方案差异较大，因此按方案新建独立工程，避免改造过程中影响正在使用的 CUMS 服务。

## 目录结构

```text
classroom-platform/
├─ app/
│  ├─ config/config.toml        # 运行时配置（首次启动自动生成）
│  ├─ logs/                     # 服务日志，按天滚动
│  └─ web/                      # 前端构建产物，由后端单端口托管
├─ backend/                     # Rust + Axum 后端
│  ├─ migrations/0001_init.sql  # 数据库结构
│  └─ src/
│     ├─ main.rs                # 入口、路由组装、日志、端口回退
│     ├─ config.rs              # 配置加载与目录初始化
│     ├─ db.rs                  # 连接池与迁移
│     ├─ auth.rs                # Argon2 口令哈希与 JWT
│     ├─ error.rs               # 统一错误响应
│     ├─ models.rs              # 请求与响应结构
│     ├─ state.rs               # 共享状态与事件总线
│     └─ routes/                # 各业务路由
├─ frontend/                    # Vue 3 + TypeScript + Vite
│  └─ src/
│     ├─ api/                   # 接口客户端
│     ├─ router/                # 路由与登录守卫
│     ├─ stores/                # Pinia 状态
│     ├─ views/                 # 学生端与教师端页面
│     └─ utils/                 # 格式化工具
├─ data/classroom.db            # SQLite 数据库（WAL 模式）
├─ storage/
│  ├─ objects/                  # 已校验并正式发布的资源文件
│  ├─ staging/                  # 上传中的临时文件
│  └─ manifests/                # 资源包清单
├─ backups/                     # 数据库与配置备份
├─ docs/                        # 项目文档与界面截图
└─ scripts/                     # 测试与验证脚本
```

## 快速开始

### 环境要求

- Rust 1.75 或更高（本项目在 1.97.1 上验证）
- Node.js 20 或更高（本项目在 24.19 上验证）

### 构建与启动

```powershell
# 1. 构建前端（产物输出到 app/web）
cd classroom-platform/frontend
npm install
npm run build

# 2. 构建并启动后端
cd ../backend
cargo build --release

# 3. 指定数据根目录后启动
$env:CLASSROOM_ROOT = "E:\ClassroomPlatform"
.\target\release\classroom-platform-server.exe
```

未设置 `CLASSROOM_ROOT` 时，程序使用可执行文件所在目录作为根目录。

启动后：

- 学生端：<http://localhost:8080/>
- 教师端：<http://localhost:8080/admin/console>
- 初始账号：`admin` / `admin`（**首次登录后请立即修改**）

### 开发模式

```powershell
# 终端 1：后端
cd classroom-platform/backend
$env:CLASSROOM_ROOT = "E:\WorkSpace\Code\cums\classroom-platform"
cargo run

# 终端 2：前端（Vite 开发服务器，已配置 API 代理到 8080）
cd classroom-platform/frontend
npm run dev
```

开发时访问 <http://localhost:5173>，接口与文件请求会代理到后端。

## 已实现功能

### 阶段一：工程基础与权限

- 教师/管理员登录，Argon2id 口令哈希 + JWT 令牌
- 首次启动自动创建管理员账号
- 统一错误格式 `{ "error": { "code", "message" } }`
- SQLite + WAL、数据库迁移、`tracing` 日志
- 端口占用时自动回退到后续端口
- 单端口托管前端构建产物，SPA 路由回退

### 阶段二：课程、课时与课堂控制

- 课程 CRUD、复制模板、草稿/发布/归档状态
- 课时 CRUD、排序、结构化内容（学习目标、教学说明、操作步骤、注意事项、练习任务、完成标准）
- 班级与机房管理、教师授课授权
- 课堂发布、开始、暂停、恢复、结束
- **同一班级同一时间只允许一个活动课堂**，由数据库部分唯一索引保证，不依赖前端按钮禁用
- 课堂创建时保存课时内容快照，模板后续修改不影响历史课堂
- SSE 推送课堂状态变化，前端断线重连并定期刷新兜底

### 阶段三：资源库与大文件传输

- 资源两步式导入：先登记元数据，再上传内容
- 上传先写入 `staging`，SHA-256 校验通过后才原子移动到 `objects`
- 客户端摘要与服务端计算结果不一致时拒绝入库
- `storage_key` 由服务端生成，客户端无法指定服务器路径
- 文件接口完整支持：`HEAD` 元信息、`GET` 下载、`Range` 部分请求、`206`、`416`、`Accept-Ranges`、`ETag`、`Content-Range`
- `If-Range` 不匹配时回退为完整下载，避免拼接出损坏内容
- 流式传输，内存占用与文件大小无关
- 相同内容识别（按 SHA-256 提示复用）
- 资源与课时多对多关联

### 运维与监控

- 健康检查：服务状态、数据库状态、活动课堂数、进行中下载数、资源占用、运行时长
- 存储用量统计
- 关键操作审计日志

## 验证结果

以下验证均在本机实际执行，脚本位于 `scripts/`。

### 端到端冒烟测试

```powershell
node scripts/smoke-test.mjs
```

覆盖认证权限、班级机房、课程课时、课堂控制、资源与大文件传输、审计监控、SSE 事件共 **68 项**，全部通过。

### 大文件流式验证

```powershell
node scripts/verify-largefile.mjs 200
```

上传 200 MiB 文件并验证 Range 下载：

| 指标 | 结果 |
|------|------|
| 上传状态 | 200 |
| 服务端 SHA-256 与客户端一致 | 是 |
| `Content-Length` | 209715200（与文件大小一致） |
| 尾部 Range 请求 | 206，内容正确 |
| **服务端内存峰值增量** | **2.6 MB** |

内存峰值增量远小于文件体积，确认服务端采用流式处理，未将整个文件读入内存。

### 浏览器界面验证

```powershell
node scripts/verify-admin-ui.mjs
```

使用无头 Chrome 实际渲染 6 个页面（课堂控制台、课程管理、资源库、系统状态、学生端首页、下载中心），检查关键内容与控制台错误，全部通过，无控制台报错。

界面截图见 `docs/screenshots/`。

## 关键设计说明

### 课堂与课程分离

课程和课时是可复用模板；课堂是某位教师面向某个班级的一次实际授课。创建课堂时把课时内容写入 `lesson_snapshot`，因此教师后续修改课程模板不会改变已结束课堂的历史展示。

### 并发控制不依赖前端

同一班级的活动课堂唯一性由数据库部分唯一索引保证：

```sql
CREATE UNIQUE INDEX uniq_active_session_per_class
    ON classroom_sessions(class_id)
    WHERE status IN ('running', 'paused');
```

即使两个教师同时点击"开始上课"，也只有一个请求能成功，另一个收到 `409 Conflict`。

### 资源路径安全

`storage_key` 完全由服务端用 UUID 生成，客户端无法参与构造。`safe_join` 做两层防御：

1. 组件级校验：拒绝绝对路径、`..` 与盘符前缀；
2. 目录级校验：父目录存在时比较规范化后的路径，防止符号链接逃逸。

Windows 上 `canonicalize` 会返回 `\\?\` 前缀，因此比较双方都必须规范化——这是实际测试中发现并修复的问题。

### 大文件传输边界

仅支持 HTTP Range 不等于浏览器关闭后必然自动续传。第一版明确这一边界：

- 服务端提供完整的 Range 支持，客户端可自行实现续传；
- 浏览器无法指定任意本地保存目录，也无法保证页面关闭后恢复下载；
- 这些能力留给阶段五的 Windows 辅助客户端。

## 配置说明

配置文件位于 `app/config/config.toml`，首次启动自动生成：

```toml
[server]
bind = "0.0.0.0:8080"
static_dir = "app/web"

[database]
path = "data/classroom.db"
max_connections = 16
wal = true

[storage]
objects_dir = "storage/objects"
staging_dir = "storage/staging"
manifests_dir = "storage/manifests"
max_file_bytes = 21474836480   # 20 GiB

[auth]
jwt_secret = "..."             # 首次启动随机生成
token_ttl_hours = 12

[limits]
max_concurrent_downloads = 64
per_client_rate_kib = 0        # 0 表示不限速
```

`jwt_secret` 在首次启动时随机生成并写回配置。**该文件包含密钥，不应提交到版本库。**

## API 一览

| 方法 | 接口 | 用途 |
|------|------|------|
| POST | `/api/auth/login` | 登录 |
| GET | `/api/auth/me` | 当前用户 |
| POST | `/api/auth/password` | 修改口令 |
| GET | `/api/version` | 公开版本信息 |
| GET | `/api/student/current-session` | 学生端当前课堂 |
| GET | `/api/student/courses` | 学生端课程列表（仅已发布） |
| GET/POST | `/api/classes` | 班级列表 / 创建 |
| GET/POST | `/api/courses` | 课程列表 / 创建 |
| POST | `/api/courses/{id}/copy` | 复制课程模板 |
| GET/POST | `/api/courses/{id}/lessons` | 课时列表 / 创建 |
| PUT/DELETE | `/api/lessons/{id}` | 编辑 / 删除课时 |
| GET/POST | `/api/sessions` | 课堂列表 / 创建场次 |
| POST | `/api/sessions/{id}/start` | 开始或恢复课堂 |
| POST | `/api/sessions/{id}/pause` | 暂停课堂 |
| POST | `/api/sessions/{id}/end` | 结束课堂 |
| GET | `/api/lessons/{id}/resources` | 课时关联资源 |
| POST | `/api/resources/register` | 登记资源元数据 |
| POST | `/api/resources/{id}/upload` | 上传资源内容 |
| HEAD/GET | `/files/{id}` | 文件元信息 / 下载（支持 Range） |
| GET | `/api/events` | SSE 实时事件流 |
| GET | `/api/admin/health` | 服务健康状态 |
| GET | `/api/admin/audit-logs` | 审计日志 |

除 `/api/version`、`/api/auth/login`、`/api/student/*` 与 `/files/*` 外，其余接口需要 `Authorization: Bearer <token>`。

## 尚未实现

以下内容属于建设方案后续阶段，当前版本未包含：

- 学生个人身份识别与下载统计（方案 4.4 指出不能仅凭 IP 判断学生身份）
- 资源包清单与批量下载打包
- 下载并发限制与限速的实际生效逻辑（配置项已预留）
- 断点续传的客户端实现
- 数据库与资源文件的自动备份与恢复验证
- 机房 10/40/80 台并发压力测试
- Windows 辅助客户端（阶段五）

## 文档

- `docs/ARCHITECTURE.md`：架构与数据模型说明
- `docs/API.md`：接口详细说明
- `docs/DEPLOYMENT.md`：部署与运维说明
- `docs/TESTING.md`：测试与验证说明
- `docs/screenshots/`：界面截图
