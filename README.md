# 机房教学资源平台

面向学校计算机机房的局域网课程管理与教学资源分发平台。

依据《机房教学资源平台建设方案》V1.0 建设。技术栈：Rust + Axum + SQLx + SQLite，Vue 3 + TypeScript + Element Plus。

## 与旧版 CUMS 的关系

本平台的前身是仓库中的 CUMS（课堂文件上传管理系统，Rust + Actix Web + 单页 HTML）。两者功能定位不同，且技术栈差异较大，因此独立建设。旧版 CUMS 已归档至分支 `archive/legacy-cums-actix`，需要时可从该分支取回。

## 目录结构

```text
cums/
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
cd frontend
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
cd backend
$env:CLASSROOM_ROOT = "E:\WorkSpace\Code\cums"
cargo run

# 终端 2：前端（Vite 开发服务器，已配置 API 代理到 8080）
cd frontend
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

### 阶段四：学生作业提交

- 课程页课时区域提供「提交作业」按钮，点击弹出上传窗口
- 支持一次选择多个文件，视频、图片、文档、压缩包均可（单文件上限 20 GiB）
- **选中文件后立即在弹窗内预览内容**：图片直接显示、视频可播放、文本显示前若干行；
  其余类型给出类型与大小说明，不必等提交后才发现选错文件
- **上传过程中显示实时速度（MB/s）与预计剩余时间**，同时给出「已传 / 总量」，
  大文件提交时学生能判断还要等多久
- **所有时间按运行设备的本地时区显示**：后端统一存 UTC，前端换算为本地时间，
  换到任何时区的电脑上都显示正确
- 提交成功后再次弹出预览窗口，展示服务端保存的文件详情
- 上传时填写姓名，姓名保存在本地，机房电脑下次提交无需重复输入
- **提示以「当前设备」为准**：同一台机器提交过本节课作业后，再次打开弹窗会显示
  「当前设备已提交过本节课作业」及提交时间，便于学生确认自己是否已交
- 提示语不展示其他同学的姓名或提交时间，仅显示「本班已有 N 份提交」这样的背景数字
- 服务端记录提交时间、来源 IP、设备标识与 User-Agent，客户端无法伪造
- 同一课时同一班级已有提交时仍会保存本次提交，并标记为重复，由教师判断性质
- 教师端「作业提交」页可按课程/课时筛选、只看重复提交、查看详情与文件预览、标记已查看或问题

### 阶段五：学生名单与作业统计

- 教师可在「学生名单」页按班级导入名单：从 Excel 复制两列直接粘贴即可，
  支持空格 / Tab / 中英文逗号分隔，自动跳过表头、空行与注释
- 名单按班级维护：课程是模板，同一门课给不同班上课时「应缴人数」不同
- 学号是学生的稳定标识，重名也不会把两个人算成一人
- 课程详情新增「作业统计」标签页：
  - 顶部汇总「应缴 / 已交 / 待补交」份数
  - 每个课时显示 `已交 / 应缴` 与进度条，一眼看出哪节课没交齐
  - 点进课时看明细：**未交名单**（含学号，可一键复制到群里催）、
    已交名单（时间 / IP / 审核状态）、名单外提交者
- 学生端上传时可从班级名单选择自己，避免手打姓名写错导致统计不到
- 未导入名单的班级不会显示虚假的缺交数据（未交数按 0 处理并给出提示）

### 阶段六：作业批改

- 课程作业统计的每个课时新增「批改」入口，进入该课时的批改页
- 批改页顶部常驻统计：提交份数、待批改、四类标签计数、平均分、未交人数
- **按提交展开而不是按学生聚合**：同一学生交两次就是两行，可以分别批改
- 四类评价标签：**好 / 通过 / 不通过 / 其他**，点一下即保存，再点一次取消
- 列表内直接打标签，不必逐份开弹窗；少数需要细看的才展开右侧抽屉
- 抽屉内可看文件预览、打 0–100 分、写评语（500 字上限），边看列表边批
- 批量操作：勾选多份后统一打标签、统一打分、或撤销审阅
- 支持按标签筛选（含「待批改」）与按学号/姓名搜索
- 作业提交记录页同样支持打标签、按标签筛选，适合跨课时抽查

批改相关的设计取舍：

| 情形 | 处理方式 |
|------|----------|
| 只改标签 | 已打的分数保留，不会被清空 |
| 只清分数 | 标签与批改时间保留 |
| 同时清空标签与分数 | 视为撤销审阅，批改时间一并清除 |
| 打标签时的流程状态 | 从「已提交」自动推进到「已查看」，但不会覆盖「已标记问题」 |
| 未导入名单 | 未交数保持 0，不把「没名单」显示成「全班没交」 |

### 运维与监控

- 健康检查：服务状态、数据库状态、活动课堂数、进行中下载数、资源占用、运行时长
- 存储用量统计
- 关键操作审计日志

### 演示数据

仓库自带一套可直接演示的数据，不必手动建课建班：

```powershell
python scripts/make-fixtures.py                     # 生成作业素材文件池
node scripts/seed-demo-data.mjs                     # 填充班级、课程、作业与批改记录
node scripts/reset-data.mjs --yes                   # 需要重来时清空（先停服务）
```

填充后是 3 个班 90 人、4 门课 10 课时、214 份提交、121 份批改，
提交文件覆盖 docx / xlsx / pdf / png / jpg / mp4 / py / md / zip，
并刻意留出批改进度不均与未交名单，便于检查统计与批改界面。

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

### 作业提交验证

```powershell
# 接口层：46 项
node scripts/verify-homework-submission.mjs

# 设备识别：21 项（本设备 / 其他设备 / 无标识退化）
node scripts/verify-device-hint.mjs

# 上传弹窗界面：20 项（提示语义 + 附件即时预览）
node scripts/verify-submit-dialog-ui.mjs

# 上传速度与剩余时间：16 项（脚本自动限速模拟机房网络）
node scripts/verify-upload-speed.mjs

# 时区一致性：5 项（存储 UTC → 显示本地）
node scripts/verify-timezone.mjs

# 多时区适配：10 项（东八区 / UTC / 美东 / 伦敦 / 东京）
node scripts/verify-timezone-matrix.mjs

# 时间格式化边界：14 项（无需启动服务）
node scripts/verify-format-time.mjs

# 学生端浏览器层：23 项（真实点击、选择文件、上传、预览）
node scripts/verify-homework-ui.mjs

# 学生名单与作业统计：60 项（导入解析、统计口径、未交判定）
node scripts/verify-roster-stats.mjs

# 名单与统计界面：38 项（标签页、班级选择、未交名单、导入对话框）
node scripts/verify-roster-ui.mjs

# 重复判定口径：22 项（不同学生不误标、同一学生才标记）
node scripts/verify-duplicate-logic.mjs

# 学生端从名单选人：27 项（选人 → 提交 → 教师端统计闭环）
node scripts/verify-student-roster-pick.mjs

# 真实场景冒烟：18 项（按教师操作顺序完整走一遍）
node scripts/smoke-roster-workflow.mjs

# 作业审阅接口：66 项（标签、分数、批量、统计、清除语义）
node scripts/verify-review-api.mjs

# 批改界面：44 项（统计卡片、批量打标签、筛选、抽屉打分）
node scripts/verify-review-ui.mjs

# 演示数据在界面可见：47 项（课程列表 → 详情 → 批改 → 提交记录 → 学生端）
node scripts/verify-seeded-ui.mjs
```

接口层覆盖提交前状态查询、多文件提交、用途推断、参数校验、重复标记、
教师端列表/筛选/详情/审核、`inline` 预览与 Range 下载的兼容性。

设备识别层覆盖同一设备二次提交、不同设备互不干扰、缺少 `device_id` 时退化为按 IP 识别。

上传弹窗层验证提示语只提「当前设备」、不含他人姓名与时间，以及选中文件后立即渲染预览。

上传速度层用 CDP 把带宽限制到 2 MB/s，验证速度以 MB/s 显示、数值随进度变化、
剩余时间随进度递减（本地回环太快，不限速观察不到中间状态）。

时区层验证「数据库存 UTC、界面显示运行设备本地时间」这条链路：
后端用 `datetime('now')` 写入的是不带时区标记的 UTC 字符串，
前端必须补 `Z` 再解析，否则会被当成当地时间而差 8 小时。

浏览器层通过 CDP 驱动真实页面，验证按钮出现、弹窗打开、多文件选择、
选中即预览、进度与提交成功、预览窗口内容、设备提醒与重复标记，并检查无控制台报错。

名单与统计层验证「谁没交」这条链路：名单导入的各种分隔符与异常行、
未交判定（含无学号时按姓名兜底）、名单外提交者的归类、无名单时的降级行为。
重复判定层专门验证「带学号时按学生判断」——同一班级不同学生提交不应被标成重复。
学生选人层把整条链路串起来跑：从下拉选中自己 → 提交 → 教师端统计正确显示为「已交」，
并覆盖重名按学号区分、跨班级不串号两种易错场景。

审阅接口层验证标签 / 分数 / 评语的部分更新语义：只改标签不清分数、只清分数保留标签、
两者都清才撤销审阅时间。批量层验证重复 ID 只算一次、不存在的 ID 被忽略而非整批失败。
批改界面层通过 CDP 走完整流程：统计卡片 → 行内打标签 → 全选批量 → 筛选搜索 →
抽屉预览打分写评语，并确认统计数字随操作实时变化。
演示数据层确认填充出来的内容真能在页面上看到：课程封面与名称、课时正文、
批改页的 27 行提交与标签分布、提交记录里的学号与来源 IP、学生端课程卡片、
以及附件下载可用——接口有数据但页面空白这类问题只有这一层能挡住。

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
| POST | `/api/student/submissions` | 提交作业（multipart，多文件） |
| GET | `/api/student/submissions/status` | 课时提交状态（`lesson_id`、可选 `class_id` 与 `device_id`；返回本设备记录与本班份数） |
| GET | `/api/student/submissions/{id}` | 学生端回读提交（用于预览） |
| GET | `/api/admin/submissions` | 教师端提交记录列表（可按 `review_label` 筛选，`unreviewed` 表示待批改） |
| GET | `/api/admin/submissions/{id}` | 教师端提交详情 |
| POST | `/api/admin/submissions/{id}/review` | 审阅单份：状态 / 标签 / 分数 / 评语，字段缺席表示不修改 |
| POST | `/api/admin/submissions/batch-review` | 批量审阅（一次最多 500 份） |
| GET | `/api/classes/{id}/students` | 班级学生名单 |
| POST | `/api/classes/{id}/students` | 添加单个学生 |
| POST | `/api/classes/{id}/students/import` | 批量导入名单（粘贴文本） |
| DELETE | `/api/classes/{id}/students/{student_id}` | 移除学生 |
| GET | `/api/courses/{id}/homework-overview` | 课程作业总览（按课时汇总，`?class_id=` 指定班级） |
| GET | `/api/lessons/{id}/submission-board` | 课时提交看板（已交 / 未交 / 名单外，按学生聚合） |
| GET | `/api/lessons/{id}/review-board` | 课时审阅看板（按提交展开，含统计与文件，供批量批改） |
| HEAD/GET | `/files/{id}` | 文件元信息 / 下载（支持 Range，`?inline=1` 内嵌预览） |
| GET | `/api/events` | SSE 实时事件流 |
| GET | `/api/admin/health` | 服务健康状态 |
| GET | `/api/admin/audit-logs` | 审计日志 |

除 `/api/version`、`/api/auth/login`、`/api/student/*` 与 `/files/*` 外，其余接口需要 `Authorization: Bearer <token>`。

## 尚未实现

以下内容属于建设方案后续阶段，当前版本未包含：

- 学生个人身份识别与下载统计（方案 4.4 指出不能仅凭 IP 判断学生身份）
- 作业提交的学生账号绑定（当前按姓名 + 学号 + IP + 设备标识记录，未与 `users` 账号关联；
  设备标识可识别「这台机器已提交」，学号可对应到名单，但都无法证明操作者是谁）
- 学生名单与教务系统对接（当前靠教师粘贴导入）
- 名单与课程/课时的选课关系（当前同一班级所有课时都按同一份名单统计）
- Office 文档（docx/xlsx/pptx）的页内预览，需额外的转换服务
- 作业截止时间与批注回传（评分已实现，尚未回传给学生端）
- 资源包清单与批量下载打包
- 下载并发限制与限速的实际生效逻辑（配置项已预留）
- 断点续传的客户端实现
- 数据库与资源文件的自动备份与恢复验证
- 机房 10/40/80 台并发压力测试
- Windows 辅助客户端（阶段七）

## 文档

- `docs/ARCHITECTURE.md`：架构与数据模型说明
- `docs/API.md`：接口详细说明
- `docs/DEPLOYMENT.md`：部署与运维说明
- `docs/TESTING.md`：测试与验证说明
- `docs/screenshots/`：界面截图
