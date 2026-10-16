# 架构说明

本文说明机房教学资源平台的架构设计与关键决策，对应《机房教学资源平台建设方案》第三章与第六章。

## 总体架构

采用**单机部署、前后端分离、资源独立服务**的结构。

```text
学生浏览器 ─┐
            ├─► 后端服务（Axum）─┬─► SQLite（元数据）
教师浏览器 ─┘                    ├─► storage/objects（大文件）
                                 └─► SSE 事件推送
```

| 组成 | 实现 |
|------|------|
| 学生端 Web 页面 | Vue 3 + TypeScript，路由 `/student/*` |
| 教师管理端 | Vue 3 + Element Plus，路由 `/admin/*` |
| 应用后端 | Rust + Axum，处理 API、权限与并发 |
| 数据访问 | SQLx，编译期可校验的 SQL 与迁移管理 |
| 数据库 | SQLite + WAL，适合单机部署 |
| 实时更新 | SSE（`/api/events`），断线重连 + 轮询兜底 |
| 大文件传输 | HTTP Range + 流式读取 |
| 文件校验 | SHA-256 |
| 日志 | `tracing` + 按天滚动文件 |

### 为什么选择单端口部署

后端直接托管前端构建产物（`app/web`），学生只需访问一个地址，无需额外配置反向代理。SPA 的前端路由通过 `ServeDir` 的 `fallback` 回退到 `index.html`。

注意：`tower-http` 的 `not_found_service` 会把回退响应强制标记为 `404`，导致前端路由无法正常渲染，因此必须使用 `fallback`。这是实际联调中发现的问题。

## 数据模型

### 表结构总览

```text
users ──┬── teacher_classes ──── classes
        │                            │
        ├── courses ── lessons ──────┼── classroom_sessions
        │                │           │         │
        │                │           │         └── session_events
        │                │           │         └── download_jobs
        │                └── lesson_resources ── resources
        │                └── lesson_steps
        └── audit_logs
```

### 核心表职责

| 表 | 用途 |
|----|------|
| `users` | 管理员与教师账号，口令以 Argon2id 哈希保存 |
| `classes` | 班级与机房 |
| `teacher_classes` | 教师授课班级授权（多对多） |
| `courses` | 课程模板，状态为 `draft` / `published` / `archived` |
| `lessons` | 课程下的课时，含 `sort_order` 与结构化 `content_json` |
| `lesson_steps` | 课时内的操作步骤 |
| `resources` | 资源元数据，不保存文件本体 |
| `lesson_resources` | 课时与资源多对多关联 |
| `resource_bundles` | 资源包与清单 |
| `classroom_sessions` | 实际授课场次，含内容快照 |
| `session_events` | 课堂事件，用于 SSE 补偿与审计 |
| `download_jobs` | 必要的下载汇总，不写高频进度 |
| `audit_logs` | 关键操作审计 |

### 设计要点

**课程与课堂分离。** 课程和课时是可复用模板；课堂是一次实际授课。`classroom_sessions.lesson_snapshot` 保存创建课堂时的课时内容，因此教师后续修改模板不会改变历史课堂的展示。

**资源与课时多对多。** 同一资源可被多个课时引用，不必复制文件。

**资源路径不由用户指定。** 数据库保存服务端生成的 `storage_key`（UUID 形式），服务端将其安全映射到实际路径。

**下载记录控制频率。** 只记录开始、完成、失败等必要事件，不把每次进度变化写入数据库。

## 并发控制

### 同一班级的活动课堂唯一性

方案 6.1 要求"同一班级同一时间只能存在一个活动课堂，应通过事务和数据库约束实现，不能仅依靠前端按钮禁用"。

实现方式为部分唯一索引：

```sql
CREATE UNIQUE INDEX uniq_active_session_per_class
    ON classroom_sessions(class_id)
    WHERE status IN ('running', 'paused');
```

即使两个教师并发点击"开始上课"，数据库也只会接受一个写入，另一个返回 `409 Conflict`。已结束（`ended`）的场次不参与约束，因此历史记录可以保留任意多条。

### 应用层预检查

创建课堂前还会先查询一次是否存在活动课堂，以便返回更友好的错误信息。该检查仅用于改善提示，正确性由数据库约束保证。

## 大文件传输

### 上传流程

```text
1. POST /api/resources/register   登记元数据，返回 resource_id
2. POST /api/resources/{id}/upload 上传内容
   ├─ 写入 storage/staging/<key>
   ├─ 流式计算 SHA-256
   ├─ 与登记时的摘要比对
   └─ 校验通过 → 原子移动到 storage/objects/<key>，状态置为 ready
```

任何一步失败都会清理临时文件，不会留下半成品。校验不通过的文件不会进入 `objects`，因此不会被下载。

**请求体上限。** Axum 默认限制请求体为 2 MiB。大文件上传接口显式禁用该限制（`DefaultBodyLimit::disable()`），实际大小由处理器按 `storage.max_file_bytes` 流式校验，内存占用恒定。

### 下载流程

文件接口完整实现方案 7.2 的要求：

| 要求 | 实现 |
|------|------|
| `HEAD` 获取元信息 | 返回 `Content-Length`、`ETag`、`Accept-Ranges`，不传输内容 |
| `GET` 正常下载 | `200 OK`，流式传输 |
| `Range` 部分请求 | 支持 `bytes=start-end`、`bytes=start-`、`bytes=-suffix` |
| `206 Partial Content` | 附带正确的 `Content-Range` |
| `416 Range Not Satisfiable` | 无效范围、格式错误、多区间请求 |
| `Accept-Ranges: bytes` | 始终声明 |
| `ETag` | 使用资源 SHA-256，避免续传时混合新旧版本 |
| `Content-Length` | 按实际返回字节数设置 |
| 流式传输 | 1 MiB 分块读取，内存与文件大小无关 |

**If-Range 处理。** 客户端携带的 `If-Range` 与当前 `ETag` 不匹配时，服务端忽略 `Range` 并按完整文件返回 `200`。这样可避免客户端把旧版本的部分内容与新版本内容拼接成损坏文件。

**多区间请求。** 第一版不支持多区间，收到时明确返回 `416` 而不是静默降级为单区间或完整文件，避免客户端误判。

**续传边界。** 服务端支持 Range 不代表浏览器关闭后会自动续传。第一版明确这一边界，可靠续传留给阶段五的 Windows 客户端。

## 实时同步

教师开始、暂停、恢复或结束课堂时：

```text
1. 校验权限与状态
2. 更新 classroom_sessions
3. 写入 session_events
4. 通过 broadcast 通道推送给所有 SSE 订阅者
```

前端订阅 `/api/events`，收到事件后重新请求当前课堂数据（而不是直接使用事件负载），保证数据一致性。

**兜底机制。** SSE 可能断线，或订阅者处理过慢导致事件被丢弃（`broadcast` 通道容量 512，滞后时收到 `Lagged`）。因此前端同时按 30 秒间隔轮询，确保课堂状态不会长期停留在旧值。

## 安全设计

| 风险 | 措施 |
|------|------|
| 口令泄露 | Argon2id 哈希存储，不保存明文 |
| 令牌伪造 | JWT 签名，密钥首次启动随机生成 |
| 账号枚举 | 用户不存在与口令错误返回同一错误 |
| 越权操作 | 教师只能操作被授权的班级和自己的课堂；管理操作要求管理员角色 |
| 路径穿越 | `storage_key` 由服务端生成；`safe_join` 做组件级与目录级双重校验 |
| 上传损坏 | SHA-256 校验通过后才发布 |
| 越权下载 | 资源状态非 `ready` 时拒绝下载；不开放数据库与配置目录 |
| 缺少审计 | 关键操作写入 `audit_logs` |

### 路径校验实现

```rust
// 组件级：拒绝绝对路径、.. 与盘符前缀
let has_unsafe_component = relative.components().any(|component| {
    matches!(component,
        Component::ParentDir | Component::RootDir | Component::Prefix(_))
});

// 目录级：父目录存在时比较规范化路径，防止符号链接逃逸
let canonical_root = root.canonicalize()?;
let canonical_parent = parent.canonicalize()?;
if !canonical_parent.starts_with(&canonical_root) {
    return Err(AppError::Forbidden);
}
```

Windows 上 `canonicalize` 返回 `\\?\` 前缀路径，因此比较双方都必须规范化，否则会误判为越界。

## 模块划分

### 后端

| 模块 | 职责 |
|------|------|
| `main.rs` | 入口、路由组装、日志初始化、端口回退、优雅退出 |
| `config.rs` | 配置加载/保存、目录初始化、密钥生成 |
| `db.rs` | 连接池、迁移、初始管理员创建 |
| `auth.rs` | Argon2 口令哈希、JWT 签发与校验、角色定义 |
| `error.rs` | 统一错误类型与响应格式 |
| `models.rs` | 请求与响应数据结构 |
| `state.rs` | 共享状态与事件广播通道 |
| `routes/` | 按业务拆分：认证、班级、课程、课时、课堂、资源、文件、事件、监控 |

### 前端

| 模块 | 职责 |
|------|------|
| `api/index.ts` | 接口客户端、认证头注入、错误转换、上传进度 |
| `router/index.ts` | 路由定义与登录守卫 |
| `stores/auth.ts` | 登录状态持久化与恢复 |
| `views/` | 学生端 4 个页面 + 教师端 5 个页面 |
| `utils/format.ts` | 文件大小、时间、状态文案格式化 |

## 后续扩展方向

方案 3.4 指出，扩展到多机房、多服务器或多校区时，可逐步：

1. 将 SQLite 迁移到 PostgreSQL（SQLx 支持，SQL 需少量调整）；
2. 将资源文件迁移到 NAS 或对象存储（替换 `storage/objects` 的读写实现）；
3. 引入集中式资源同步与设备管理。

第一版不引入微服务集群或 Kubernetes，以控制复杂度和运维成本。
