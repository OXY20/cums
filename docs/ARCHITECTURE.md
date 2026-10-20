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
| `homework_submissions` | 学生作业提交记录，含来源 IP、设备标识、重复标记与审阅结果（标签/分数/评语） |
| `homework_submission_files` | 提交与资源多对多关联，一次提交可含多个文件 |
| `class_students` | 班级学生名单（学号 + 姓名），用于统计未交作业 |
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

## 作业提交

### 与资源库的关系

作业文件不另建一套存储，而是复用 `resources` 表与 `/files` 下载接口：

```text
学生提交（multipart，多个 file 字段）
  ├─ 每个文件：创建 staging 资源占位 → 流式落盘 → SHA-256 校验 → 移入 objects
  ├─ 全部文件成功后：写入 homework_submissions
  └─ 写入 homework_submission_files（提交 ↔ 资源多对多）
```

这样作业文件同样具备流式传输、SHA-256 校验、Range 下载与 `ETag` 能力，无需重复实现。任何一个文件失败都会清理本次已落盘的文件与资源记录，不留孤儿数据。

### 来源 IP 的可信边界

学生端提交不要求登录，因此不能采信客户端自报的地址。`client_ip` 一律由服务端从 TCP 连接信息解析（`ConnectInfo<SocketAddr>`）。

只有在请求来自**回环地址**（即反向代理与服务同机部署）时，才信任 `X-Forwarded-For` 的第一跳。若信任任意私有网段的代理头，局域网内任何学生都能通过构造请求头伪造来源地址，使重复提交与代交核对失去意义。

### 设备识别与提示语义

学生端打开上传窗口时，需要告诉学生「这台机器是不是已经交过了」。这里刻意不用「本班谁最早交」作为提示语，原因是：

- 机房电脑多人轮用，学生关心的是**自己是否已提交**，而不是同学的进度；
- 「谁先交、几点交」属于教师核对视角的信息，展示给学生既无意义，也会暴露同学隐私。

设备识别采用「同一 IP + 同一浏览器 User-Agent」，前端再额外提供 `device_id`（首次访问时生成并存入 `localStorage` 的随机串），三者一起作为过滤条件：

```sql
SELECT COUNT(*) FROM homework_submissions
WHERE lesson_id = ?1 AND client_ip = ?2 AND device_id = ?3;
```

`device_id` 缺省时（旧记录、隐私模式）自动退化为只按 IP 判断，保证功能可用。接口同时返回 `class_total`，但前端只把它渲染成「本班已有 N 份提交」这样不含姓名的背景数字。

### 班级学生名单

「谁没交作业」必须先知道「谁应该交」。系统里原本没有学生名单，提交只记录姓名，因此无法计算应缴人数。`0006_class_students.sql` 引入名单表：

```sql
CREATE TABLE class_students (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id     INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    student_no   TEXT    NOT NULL,
    student_name TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX uniq_class_student_no ON class_students(class_id, student_no);
```

**名单挂在班级而不是课程。** 课程是模板，同一门课会被多个班级使用；「谁该交」取决于具体班级，因此名单必须按班级维护。统计时先选班级，才能算未交。

**学号是学生的稳定标识。** 重名在班级里很常见，只靠姓名会把两个人算成一个人。提交记录新增 `student_no` 字段，与名单对应。

**历史数据与临时加人靠姓名兜底。** `student_no` 允许为空字符串。判断「名单内某人是否已交」时：

```sql
WHERE (h.student_no <> '' AND h.student_no = s.student_no)
   OR (h.student_no = '' AND TRIM(h.student_name) = TRIM(s.student_name))
```

先按学号精确匹配，学号为空时退回姓名匹配。这样既不会把已交的历史记录误判成未交，也不至于因为学生没从名单选择就统计不到。

**名单导入按现实场景设计。** 教师通常从 Excel 复制两列粘贴，分隔符可能是 Tab、空格或中英文逗号，还可能带上表头。解析时统一处理这些情况，并跳过空行与 `#` 注释行；学号已存在时更新姓名而不是报错，重复导入是幂等的。解析失败的行带行号返回，让教师能直接对照修改。

**跨班不串号。** 学生端会把上次选择的学号记在 `localStorage`，方便下次自动带出。但机房电脑轮用时，换到另一门课（属于别的班级）就会带上不属于该班的学号。因此名单加载完成后会校验：记住的学号不在本班名单里时，学号与姓名一起清空。否则下一位同学可能以别人的身份提交，统计就全乱了。

### 重复提交判定

判定口径取决于这次提交有没有带学号：

| 情形 | 判定依据 | 提示语 |
|------|----------|--------|
| 带学号（从名单选了自己） | 同一课时的**同一学号**是否已提交 | 你已提交过本节课作业，本次为再次提交，两次记录都会保留 |
| 不带学号，本设备交过 | 同课时 + 同 IP [+ 同 `device_id`] | 当前设备已提交过本节课作业，本次提交已记录并标记为重复 |
| 不带学号，本班有提交 | 同课时 + 同班级 | 本节课本班已有其他提交，本次提交已记录并标记为重复 |

**为什么带学号时不再按班级判断。** 一个班几十人，张三交完李四再交是正常流程。若仍按「本班已有提交」标记，几乎所有记录都会被标成重复，这个标记就失去意义。有了学号之后，重复的含义收窄为「同一个学生交了两次」，这才是教师真正要核对的情况。

三种情形都**仍然保存**本次提交，只置 `duplicate_flag = 1` 并把 `duplicate_of` 指向原记录。这里刻意选择"保存并标记"而不是"拒绝"：

- 学生可能是误操作，也可能是替缺勤同学补交，直接拒绝会让作业丢失；
- 教师需要看到完整事实（谁先交、谁后交、来源 IP），由人来判断性质；
- 前端在提交前会查询 `/api/student/submissions/status` 主动提醒，但不作为强制拦截。

所有提示语都不指名其他同学，避免把班里信息暴露给当前学生。

班级信息缺省时（例如没有进行中的课堂），提交仍会保存，`class_id` 为空，重复判定退化为按课时统计。

### 作业统计视图

教师需要两个粒度的信息，接口也分两级：

| 接口 | 回答的问题 |
|------|------------|
| `/api/courses/{id}/homework-overview?class_id=` | 这门课每节课收了多少、还差多少 |
| `/api/lessons/{id}/submission-board?class_id=` | 这一节课具体谁没交 |

总览按课时汇总，返回提交份数、去重人数、重复份数、未交人数。看板把学生分成三类返回：

- **已交**：名单内且已提交，带提交时间、来源 IP、审核状态；
- **未交**：名单内但没提交——教师最常用的动作是复制这份名单到群里催；
- **名单外**：提交了但不在名单里，可能是临时加人或姓名填错，单独列出便于核对。

**未交只统计名单内的人。** 没有名单时（`roster_total = 0`）未交数返回 0 而不是「全部人」，避免在没导入名单的班级上显示虚假的缺交数据。

**去重人数按学生算。** 统计提交人数时，有学号按学号、无学号按姓名做 `DISTINCT`，避免同一学生多次提交把人数虚增。

**单班课程自动选班。** 总览额外返回 `used_class_ids`——这门课实际用过的班级（授课记录与提交记录取并集）。前端拿到后发现只有一个班就自动选中，省掉「明明只教一个班还要手选一次」的重复动作；多于一个班时仍保持未选中，因为跨班汇总与某班数据是两回事，默认选中任何一个都会让人误读。

### 作业审阅

教师批改一次作业的流程是「一次看几十份，多数通过，少数细看」，因此审阅拆成两个正交维度：

| 维度 | 字段 | 表达什么 |
|------|------|----------|
| 流程状态 | `status` | 这份老师看过没有：`submitted` / `reviewed` / `flagged` |
| 评价标签 | `review_label` | 作业质量如何：`good` 好 / `pass` 通过 / `fail` 不通过 / `other` 其他 |

两者独立保存。存在「看过了但只打分没打标签」和「打了不通过但还要单独标记问题」两种真实情形，合并成一个字段会丢信息。

分数（`review_score`，0–100）与评语（`review_comment`）都是选填。多数教师只打标签不打分，强制填分只会让人随手填个 0。

#### 接口

| 接口 | 用途 |
|------|------|
| `POST /api/admin/submissions/{id}/review` | 单份审阅 |
| `POST /api/admin/submissions/batch-review` | 批量审阅（一次最多 500 份） |
| `GET /api/lessons/{id}/review-board?class_id=` | 批改看板：按提交展开，含统计与文件 |

#### 审阅看板与提交看板的分工

两个看板口径不同，不能互相替代：

| 看板 | 粒度 | 回答的问题 |
|------|------|------------|
| `submission-board` | 按学生聚合 | 谁没交 |
| `review-board` | 按提交展开 | 这一份打什么标签 |

一个学生交两次，在提交看板里是一行，在审阅看板里是两行——教师需要分别批改。若审阅看板也做聚合，第二次提交就永远无法被打分。

#### 部分更新的语义

审阅请求的四个字段都是选填，**字段缺席表示不修改**：

| 请求 | 效果 |
|------|------|
| `{"label":"good"}` | 只改标签，已打的 95 分保留 |
| `{"score":null}` | 只清分数，标签与审阅时间保留 |
| `{"label":"","score":null}` | 撤销审阅，清空标签、分数与审阅时间 |

「清除分数」用显式 `null` 表达，需要 `Option<Option<f64>>` 才能与「字段缺席」区分。serde 默认会把 JSON `null` 折叠成外层 `None`，导致清除操作被当成「不修改」而静默失败，因此 `score` 使用自定义反序列化。

#### 状态推进规则

打了标签或分数时，`status` 从 `submitted` 自动推进到 `reviewed`，省掉「打标签后再点一次已查看」。

但**只从 `submitted` 推进**：

```sql
status = CASE WHEN status = 'submitted' THEN 'reviewed' ELSE status END
```

这样教师先前标记为 `flagged`（有问题）的提交，后续补个标签不会把问题标记冲掉。教师显式传 `status` 时始终以显式值为准。

#### 审阅时间的两步写入

`reviewed_at` / `reviewed_by` 在第二步按**更新后的最终值**判定：

```sql
SET reviewed_at = CASE
        WHEN review_label = '' AND review_score IS NULL THEN NULL
        ELSE datetime('now')
    END
```

不能与内容字段合并成一条 SQL，因为 SQLite 的 SET 右侧引用的是**更新前**的旧值。「只清分数、保留标签」在旧值语义下会被误判成「撤销审阅」，把审阅时间抹掉。

#### 统计口径

`review-board` 返回的 `stats` 包含各标签计数、`unreviewed`（交了但没批）、`scored` 与 `average_score`、`missing`（名单内未交）。

`missing` 复用提交看板的名单匹配口径（有学号按学号、无学号按姓名），且只在指定班级且该班有名单时才计算；无名单时保持 0，不把「没导入名单」显示成「全班都没交」。

### 预览的实现边界

预览分两个阶段，都在浏览器内完成，不依赖服务端转换。

**提交前（本地预览）**：选中文件后立刻用 `URL.createObjectURL` 渲染，学生提交前就能确认文件没选错。

**提交后（服务端预览）**：走 `/files/{id}?inline=1`，服务端把 `Content-Disposition` 从 `attachment` 改为 `inline`。

| 类型 | 预览方式 |
|------|----------|
| 图片 | `<img>` 内嵌 |
| 视频 | `<video controls>` 播放 |
| 音频 | `<audio controls>` 播放 |
| PDF | `<iframe>` 内嵌浏览器阅读器 |
| 文本 | 提交前直接读内容，提交后 `<iframe>` 内嵌 |
| 其他（docx/xlsx/zip 等） | 不做伪预览，提供下载入口 |

本地预览的 object URL 在文件移除、弹窗关闭与组件卸载时都会 `revokeObjectURL`，避免长时间使用后内存累积。

Office 文档的页内预览需要额外的转换服务，第一版明确不实现，避免给出"看起来能预览但实际打不开"的假象。

### 上传速度与剩余时间

上传进度用 XHR 的 `upload.onprogress` 获取。该事件只给出「已传字节 / 总字节」，速度需要前端自己推算。

**滑动窗口而非平均值。** 速度取**最近 3 秒**窗口首尾的字节差除以时间差，而不是「总字节 ÷ 总耗时」。后者会把连接建立、TLS 握手、首包等待的时间平摊到整个传输上，速度显示偏低且长时间几乎不动，学生无法判断网络是正常还是卡住了。

采样点按时间窗口裁剪时保留窗口外的最后一个点作为基准，否则刚裁剪完就没有参考点，速度会瞬间归零。

**单位统一为 MB/s。** 与 `formatBytes` 保持 1 MB = 1024 × 1024 字节的同一进制，避免出现「进度显示 10 MB、速度显示 9.5 MB/s」这种自相矛盾。

**剩余时间的分档与抖动处理。**

| 条件 | 显示 |
|------|------|
| 采样不足 300 ms 或增量非正 | `计算中…`（不给出夸张数字） |
| 已传满 | `即将完成`（不再显示 0 秒倒计时） |
| < 60 秒 | `约 N 秒` |
| < 60 分 | `约 N 分 M 秒` |
| ≥ 60 分 | `约 N 小时 M 分` |

剩余时间基于瞬时速度推算，开头几秒抖动较大，因此宁可显示「计算中…」也不给出误导性的估计。

## 时间与时区

**存储一律用 UTC。** 所有 `created_at` / `updated_at` / `started_at` 等字段由 SQLite 的 `datetime('now')` 生成，写入的是 UTC 时间，格式为 `YYYY-MM-DD HH:MM:SS`（**不带时区标记**）。少数由 Rust 直接生成的时间（如 `chrono::Utc::now().to_rfc3339()`）也是 UTC，但带 `+00:00` 后缀。

**显示一律转本地时区。** 前端 `formatTime` 负责换算：

```ts
// 没有时区标记时补 Z，否则会被当成当地时间
const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)
const iso = hasZone ? text : `${text.replace(' ', 'T')}Z`
const date = new Date(iso)
// 用 getFullYear / getHours 取本地值，而不是 toISOString（那还是 UTC）
```

这个细节是必须的：`new Date('2026-10-19 17:28:13')` 在 JavaScript 里被解析为**本地时间**，在东八区就会凭空多出 8 小时。学生看到的「提交时间」比实际早 8 小时，正是漏了补 `Z` 这一步。

**为什么不在后端直接存本地时间。** 服务器可能部署在 UTC 时区的容器里，而学生和教师在不同的机房、可能跨时区访问。存 UTC 让数据有唯一解释，显示时再按运行设备的时区换算，换时区不改数据。

**数据库中的历史数据不需要迁移。** 修正点在前端换算逻辑而非存储格式，旧记录的 UTC 值在修复后同样显示正确。

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
| 伪造来源 IP | 作业提交的 `client_ip` 由服务端从连接信息解析，仅在回环代理时采信 `X-Forwarded-For` |
| 学生端信息泄露 | 提交状态接口只返回本设备记录与本班份数，不返回其他学生姓名与时间 |
| 名单数据隔离 | 学生端只能读取所属班级的名单（用于选择自己），完整名单仅教师可见 |
| 缺少审计 | 关键操作写入 `audit_logs`，名单导入单独记录 |

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
| `routes/` | 按业务拆分：认证、班级、课程、课时、课堂、资源、作业提交、文件、事件、监控 |

### 前端

| 模块 | 职责 |
|------|------|
| `api/index.ts` | 接口客户端、认证头注入、错误转换、上传进度、多文件提交 |
| `router/index.ts` | 路由定义与登录守卫 |
| `stores/auth.ts` | 登录状态持久化与恢复 |
| `components/` | 富文本编辑器、作业上传弹窗、提交预览弹窗、文件预览组件 |
| `views/` | 学生端 4 个页面 + 教师端 6 个页面 |
| `utils/format.ts` | 文件大小、时间、状态文案格式化 |

## 后续扩展方向

方案 3.4 指出，扩展到多机房、多服务器或多校区时，可逐步：

1. 将 SQLite 迁移到 PostgreSQL（SQLx 支持，SQL 需少量调整）；
2. 将资源文件迁移到 NAS 或对象存储（替换 `storage/objects` 的读写实现）；
3. 引入集中式资源同步与设备管理。

第一版不引入微服务集群或 Kubernetes，以控制复杂度和运维成本。
