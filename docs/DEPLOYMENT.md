# 部署与运维说明

## 环境要求

| 组件 | 版本 | 说明 |
|------|------|------|
| Windows | 10 / 11 / Server 2019+ | 方案推荐的部署平台 |
| Rust | 1.75+ | 仅构建阶段需要；验证环境为 1.97.1 |
| Node.js | 20+ | 仅构建前端需要；验证环境为 24.19 |

生产环境只需可执行文件与前端产物，无需安装 Rust 或 Node.js。

## 部署目录

方案 6.3 推荐的目录结构：

```text
D:\ClassroomPlatform\
├─ classroom-platform-server.exe
├─ app\
│  ├─ config\config.toml        # 首次启动自动生成
│  ├─ logs\server.log.YYYY-MM-DD
│  └─ web\                      # 前端构建产物
├─ data\classroom.db            # SQLite（含 -wal、-shm）
├─ storage\
│  ├─ objects\                  # 已发布的资源文件
│  ├─ staging\                  # 上传中的临时文件
│  └─ manifests\                # 资源包清单
└─ backups\                     # 数据库与配置备份
```

程序启动时自动创建上述目录。未设置 `CLASSROOM_ROOT` 时，根目录取可执行文件所在目录。

## 构建步骤

### 构建前端

```powershell
cd frontend
npm install
npm run build
```

产物输出到 `../app/web`。该目录由后端托管，无需额外 Web 服务器。

### 构建后端

```powershell
cd backend
cargo build --release
```

产物位于 `backend/target/release/classroom-platform-server.exe`。

### 打包发布

```powershell
$dest = "D:\ClassroomPlatform"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Copy-Item backend\target\release\classroom-platform-server.exe $dest\
Copy-Item -Recurse app\web $dest\app\web -Force
```

首次启动会生成配置、创建数据库与初始管理员账号。

## 配置

配置文件 `app/config/config.toml`：

```toml
[server]
bind = "0.0.0.0:8080"       # 监听地址；0.0.0.0 表示允许局域网访问
static_dir = "app/web"      # 前端产物目录；留空则只提供 API

[database]
path = "data/classroom.db"
max_connections = 16        # SQLite 建议 8-16
wal = true                  # WAL 提升并发读性能

[storage]
objects_dir = "storage/objects"
staging_dir = "storage/staging"
manifests_dir = "storage/manifests"
max_file_bytes = 21474836480  # 单文件上限，默认 20 GiB

[auth]
jwt_secret = "..."          # 首次启动随机生成，请妥善保管
token_ttl_hours = 12

[limits]
max_concurrent_downloads = 64
per_client_rate_kib = 0     # 0 表示不限速
```

修改 `bind` 后需重启服务。

**端口回退。** 若配置端口被占用，程序会依次尝试后续端口，最多 20 次，并在日志中记录实际监听地址。

## 开机自启动

### 方式一：任务计划程序（推荐）

以管理员身份运行：

```powershell
$action = New-ScheduledTaskAction `
    -Execute "D:\ClassroomPlatform\classroom-platform-server.exe" `
    -WorkingDirectory "D:\ClassroomPlatform"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

Register-ScheduledTask `
    -TaskName "ClassroomPlatform" `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal
```

### 方式二：Windows 服务

可使用 [NSSM](https://nssm.cc/) 等工具将可执行文件注册为服务：

```powershell
nssm install ClassroomPlatform "D:\ClassroomPlatform\classroom-platform-server.exe"
nssm set ClassroomPlatform AppDirectory "D:\ClassroomPlatform"
nssm start ClassroomPlatform
```

## 日常运维

### 查看日志

```powershell
# 最近 50 行
Get-Content D:\ClassroomPlatform\app\logs\server.log.* | Select-Object -Last 50

# 只看错误
Select-String -Path D:\ClassroomPlatform\app\logs\*.log -Pattern "ERROR|WARN"
```

日志按天滚动。可通过环境变量调整级别：

```powershell
$env:RUST_LOG = "info,classroom_platform_server=debug"
```

### 备份

**必须同时备份数据库与资源文件**，只备份数据库无法完整恢复平台（方案 12.1 风险 6）。

```powershell
$date = Get-Date -Format "yyyyMMdd"
$backup = "E:\ClassroomBackup\$date"     # 建议放在不同磁盘
New-Item -ItemType Directory -Force -Path $backup | Out-Null

# 1. 数据库（使用 SQLite 在线备份，避免复制到写入中的文件）
sqlite3 D:\ClassroomPlatform\data\classroom.db ".backup '$backup\classroom.db'"

# 2. 资源文件
robocopy D:\ClassroomPlatform\storage\objects "$backup\objects" /MIR /R:1 /W:1

# 3. 配置
Copy-Item D:\ClassroomPlatform\app\config\config.toml $backup\
```

若无 `sqlite3` 命令，可先停止服务再复制 `classroom.db`、`classroom.db-wal`、`classroom.db-shm` 三个文件。

### 恢复

```powershell
# 1. 停止服务
Stop-Service ClassroomPlatform

# 2. 恢复数据库（三个文件需一起处理）
Copy-Item E:\ClassroomBackup\20261016\classroom.db D:\ClassroomPlatform\data\ -Force
Remove-Item D:\ClassroomPlatform\data\classroom.db-wal, D:\ClassroomPlatform\data\classroom.db-shm -ErrorAction SilentlyContinue

# 3. 恢复资源文件
robocopy E:\ClassroomBackup\20261016\objects D:\ClassroomPlatform\storage\objects /MIR

# 4. 启动服务并验证
Start-Service ClassroomPlatform
Invoke-WebRequest http://localhost:8080/api/version
```

**建议定期演练恢复流程**，确认备份可用，而不是只在故障时才第一次尝试。

### 磁盘空间监控

通过管理端查看：

```powershell
# 需要先获取令牌
$login = Invoke-RestMethod -Uri http://localhost:8080/api/auth/login `
    -Method POST -ContentType "application/json" `
    -Body '{"username":"admin","password":"admin"}'
Invoke-RestMethod -Uri http://localhost:8080/api/admin/health `
    -Headers @{ Authorization = "Bearer $($login.token)" }
```

返回的 `objects_bytes` 为资源占用字节数。也可直接查看磁盘剩余空间：

```powershell
Get-PSDrive D | Select-Object Used,Free
```

磁盘空间不足时，上传会返回明确错误而不是静默失败。

## 安全加固

1. **立即修改初始口令**：登录后进入教师端，或调用 `/api/auth/password`。
2. **限制管理端访问**：方案 9.1 要求管理接口必须认证。如需进一步限制，可在防火墙中只允许教师机访问 `/admin/*`。
3. **保护配置文件**：`app/config/config.toml` 含 JWT 密钥，不要提交到版本库，也不要让学生网络可访问。
4. **不要开放数据目录**：`data/`、`storage/`、`app/` 不应通过任何 Web 服务器暴露。
5. **不可信网络启用 HTTPS**：局域网内如存在不可信设备，应在反向代理层启用 HTTPS。
6. **定期检查审计日志**：`/api/admin/audit-logs` 记录关键操作。

## 性能与容量

方案第八章给出的容量估算（80 台电脑下载 12 GB 资源包）：

| 链路 | 理想传输时间 |
|------|-------------|
| 1 Gbps | 约 2.1 小时 |
| 2.5 Gbps | 约 51 分钟 |
| 10 Gbps | 约 13 分钟 |

以上为理论值，未考虑协议开销、磁盘速度与其他流量。

**不要仅根据理论数据采购网络设备。** 应先用真实文件做 10、40、80 台并发测试，记录服务器网卡吞吐、磁盘读取、CPU、内存和失败率，再决定是否升级。

### 建议的服务器配置

| 部件 | 建议 |
|------|------|
| 服务器 | SSD；优先评估 2.5GbE 或 10GbE 网卡 |
| 交换机 | 千兆接入端口；重点检查上联带宽 |
| 学生电脑 | 优先有线千兆网络 |
| 地址配置 | 固定 IP 或 DHCP 地址保留 |
| 资源准备 | 尽可能在上课前导入并校验大型资源 |

### 教师机资源竞争

方案 12.1 风险 2 指出：教师机若同时承担视频剪辑、录屏和资源分发，可能出现磁盘或 CPU 争用。建议：

- 条件允许时使用独立资源服务器；
- 或将 `storage/objects` 放在独立磁盘上。

## 故障排查

| 现象 | 排查方向 |
|------|----------|
| 服务无法启动 | 查看 `app/logs/` 最新日志；确认端口未被占用（程序会自动回退并记录） |
| 学生端显示"无进行中的课堂" | 确认教师端课堂状态为"进行中"；检查是否已结束 |
| 上传失败并提示校验错误 | 文件在传输中损坏，重试上传 |
| 下载中断后无法续传 | 浏览器行为限制，见"续传边界"；确认服务端返回 `Accept-Ranges: bytes` |
| 下载返回 409 | 资源状态不是 `ready`（可能仍在上传或文件缺失） |
| 资源提示"文件缺失" | `storage/objects` 下文件被移动或删除，需重新上传 |
| 课堂无法开始，返回 409 | 该班级已有活动课堂，需先结束 |
| 课程无法删除，返回 409 | 该课程已有授课记录，应改为"停用" |
| 磁盘空间不足 | 清理 `storage/staging` 中的残留文件；确认 `storage/objects` 所在磁盘剩余空间 |

### 手动检查数据库

```powershell
sqlite3 D:\ClassroomPlatform\data\classroom.db

sqlite> .tables
sqlite> SELECT id, title, status FROM courses;
sqlite> SELECT id, class_id, status, started_at FROM classroom_sessions ORDER BY id DESC LIMIT 10;
sqlite> SELECT id, name, status, size_bytes FROM resources;
sqlite> .quit
```

## 验收清单对照

方案第十一章的 MVP 验收项与当前实现状态：

### 课堂与课程

- [x] 教师可以登录
- [x] 可以创建课程和课时
- [x] 可以选择班级、课程和课时并开始上课
- [x] 学生打开固定网址即可看到当前课堂
- [x] 课堂切换、暂停和结束状态正确
- [x] 课堂历史记录不会因模板修改而意外改变

### 资源下载

- [x] 可以导入并登记大文件
- [x] 文件大小与 SHA-256 信息正确
- [x] 支持 HTTP Range 请求
- [x] 下载失败有明确提示
- [x] 服务器不会一次性把大文件读入内存（200 MiB 上传内存峰值增量 2.6 MB）
- [x] 学生无法访问未授权资源或任意服务器路径
- [ ] 并发下载期间教师后台仍能正常使用（需在真实机房验证）

### 运维与安全

- [x] 服务可以开机启动（提供任务计划与服务两种方式）
- [x] 数据库和资源文件有明确的存储位置
- [ ] 数据库备份与恢复经过验证（流程已提供，需现场演练）
- [x] 磁盘空间不足时能够提示
- [x] 有基本日志和故障排查说明
- [ ] 完成至少 10、40 台并发测试（需在真实机房进行）

未勾选项需要在真实机房环境中完成，属于阶段四的工作内容。
