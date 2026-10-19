# 测试与验证说明

本项目提供多个自动化脚本，覆盖功能正确性、大文件传输、作业提交和界面渲染。

## 前置准备

```powershell
# 1. 构建
cd frontend; npm install; npm run build
cd ../backend; cargo build

# 2. 使用独立的测试根目录启动服务
$env:CLASSROOM_ROOT = "E:\WorkSpace\Code\cums\classroom-platform"
.\target\debug\classroom-platform-server.exe
```

**注意：** 冒烟测试会创建并删除数据。请勿指向生产数据目录。

测试会清理自己创建的副本课程与资源，但**会保留**主测试课程及其授课记录。这是有意为之：方案要求"有授课记录的课程禁止删除"，测试正好验证了这一点，因此该课程无法被清理。多次运行会累积若干 `自动化测试课程-*` 记录，属于预期行为。需要干净数据时删除 `data/classroom.db` 后重启服务。

## 1. 端到端冒烟测试

```powershell
node scripts/smoke-test.mjs
# 或指定地址
node scripts/smoke-test.mjs http://127.0.0.1:8080
```

### 覆盖范围（69 项）

| 分组 | 项数 | 验证内容 |
|------|------|----------|
| 认证与权限 | 6 | 错误口令拒绝、登录成功、未认证 401、伪造令牌拒绝、用户信息、公开版本接口 |
| 班级与机房 | 3 | 创建、同名唯一约束、列表 |
| 课程与课时 | 9 | 创建、默认草稿、草稿不出现在学生端、发布、发布后可见、创建课时、排序递增、复制模板、复制含课时 |
| 课堂控制 | 15 | 空状态、创建场次、初始暂停、开始、学生端显示、快照内容、并发冲突、暂停、恢复、再次暂停、模板修改、历史快照稳定、结束、结束后不可见、已结束不可重启、有记录课程禁删 |
| 资源与大文件 | 24 | 登记、服务端生成 storage_key、上传、SHA-256 一致、状态可用、摘要不匹配拒绝、HEAD 元信息、ETag、完整下载、中间/后缀/开放式 Range、Content-Range、416 边界、多区间拒绝、If-Range 两种分支、路径穿越防护、关联资源 |
| 审计与监控 | 5 | 健康检查、资源占用、活动课堂数、审计日志查询、关键操作已记录 |
| SSE 事件 | 1 | 课堂开始事件可达 |
| 清理 | 3 | 结束课堂、删除副本课程、删除测试资源 |

### 关键验证点

**并发控制。** 同一班级创建第二个活动课堂必须返回 `409`：

```javascript
const conflict = await api('/api/sessions', { method: 'POST', token,
  body: { class_id: classId, lesson_id: lessonId } })
check('同班级并发活动课堂被拒绝', conflict.status === 409)
```

**历史快照稳定性。** 修改课时模板后，已结束课堂的内容不应改变：

```javascript
await api(`/api/lessons/${lessonId}`, { method: 'PUT', token,
  body: { content_json: JSON.stringify({ goal: '被修改后的目标' }) } })
const snapshot = await api(`/api/sessions/${sessionId}`)
check('历史课堂保留原始快照', snapshot.json.lesson_content.goal === '掌握图文混排的基本方法')
```

**Range 边界。** 覆盖中间区间、后缀区间、开放式区间、超范围、格式错误、多区间六种情况。

**If-Range 两个分支。** 匹配时返回 `206`，不匹配时回退完整文件返回 `200`。

## 2. 大文件流式验证

```powershell
node scripts/verify-largefile.mjs 200
# 参数：文件大小（MiB），默认 200
```

验证内容：

| 项目 | 期望 |
|------|------|
| 流式上传 200 MiB | 状态 200 |
| 服务端 SHA-256 | 与客户端一致 |
| `Content-Length` | 等于文件字节数 |
| 尾部 Range 请求 | 206，内容正确 |
| 服务端内存峰值增量 | 远小于文件体积 |

### 实测结果

```text
准备上传 200 MiB，sha256=570d87b0f046cfe1…
登记完成 resource_id = 2
上传状态 200，耗时 5.54s
SHA-256 校验： 一致
HEAD： 200 content-length = 209715200 accept-ranges = bytes
尾部 Range 下载：206，1024 字节，耗时 0.00s，内容 一致
RESULT: 大文件流式上传与 Range 下载正常

上传前工作集: 20.7 MB
上传/下载期间峰值工作集: 23.3 MB
峰值增量: 2.6 MB
```

内存峰值增量仅 2.6 MB，确认服务端采用流式处理。这是方案第十一章"服务器不会一次性把大文件读入内存"验收项的直接证据。

### 测量方法

```powershell
$proc = Get-Process -Name 'classroom-platform-server'
$before = $proc.WorkingSet64
# 在上传期间持续采样
$peak = $before
while ($job.State -eq 'Running') {
  Start-Sleep -Milliseconds 700
  $p = Get-Process -Name 'classroom-platform-server' -ErrorAction SilentlyContinue
  if ($p -and $p.WorkingSet64 -gt $peak) { $peak = $p.WorkingSet64 }
}
Write-Output "峰值增量: $([math]::Round(($peak-$before)/1MB,1)) MB"
```

## 3. 界面渲染验证

需要先启动带调试端口的 Chrome：

```powershell
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = Join-Path $env:TEMP "cums-chrome-$(Get-Random)"
Start-Process $chrome -ArgumentList @(
  "--headless=new", "--remote-debugging-port=9222", "--user-data-dir=$profile",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu"
) -WindowStyle Hidden
```

然后运行：

```powershell
node scripts/verify-admin-ui.mjs
```

### 覆盖范围（6 项）

| 页面 | 验证内容 |
|------|----------|
| `/admin/console` | 含"课堂控制台"、"发布课堂" |
| `/admin/courses` | 含"课程管理"、"新建课程" |
| `/admin/resources` | 含"资源库"、"将文件拖到此处" |
| `/admin/system` | 含"系统状态"、"审计日志" |
| `/student` | 含"全部课程"、课程标题 |
| `/student/downloads` | 含"下载中心" |

同时检查控制台错误，要求为零。

### 实测结果

```text
PASS  课堂控制台（/admin/console）
PASS  课程管理（/admin/courses）
PASS  资源库（/admin/resources）
PASS  系统状态（/admin/system）
PASS  学生端首页（/student）
PASS  下载中心（/student/downloads）

合计 6 项：通过 6，失败 0
```

### 页面文本提取

用于人工检查渲染内容：

```powershell
node scripts/page-text.mjs http://127.0.0.1:8080/student
```

学生端首页实际输出：

```text
机房教学资源平台
全部课程
登录
课程封面
文字处理 · 图文混排 进行中
班级：25计应1班 ｜ 教师：系统管理员
进入课程 →
全部课程
文字
文字处理
计算机应用 · 文字录入、排版与表格制作
共 3 课时
...
课堂状态最后同步：13:18:30
机房教学资源平台 · v0.1.0
=== 控制台错误 ===
（无）
```

### 界面截图

```powershell
node scripts/capture-all.mjs      # 学生端页面
node scripts/capture-admin.mjs    # 教师端页面（自动登录注入令牌）
```

截图保存在 `docs/screenshots/`。

**令牌注入说明。** 直接访问 `/admin/*` 时前端路由守卫会重定向到登录页。`capture.mjs` 因此先导航到同源页面写入 `localStorage`，再重新导航到目标地址。令牌通过环境变量传递，不出现在命令行参数中。

## 4. 作业提交验证

作业提交分三层验证，全部可在本地执行。

### 4.1 接口层（45 项）

```powershell
node scripts/verify-homework-submission.mjs http://127.0.0.1:8090
```

| 分组 | 验证内容 |
|------|----------|
| 准备数据 | 管理员登录、创建班级 / 课程 / 课时 |
| 提交前状态 | 课时提交状态查询、初始为 0 |
| 多文件提交 | 图片 + 视频 + 文档一次提交、返回 3 个文件、记录姓名、记录来源 IP、首次不标记重复、用途按 MIME 正确推断 |
| 提交后状态 | 统计到 1 条、返回最早提交人 |
| 重复检测 | 同班同课时再次提交仍保存成功、`duplicate_flag=1`、`duplicate_of` 指向原提交、返回含原提交人姓名的警告、`duplicate_of_name` 正确 |
| 参数校验 | 缺少姓名 400、缺少文件 400、课时不存在 404 |
| 教师端列表 | 查询成功、条数正确、带课程/课时/班级标题、带文件数、带 IP、可按重复筛选、未授权 401 |
| 教师端详情与审核 | 详情含文件列表、含 SHA-256、审核状态更新、非法状态 400 |
| 内嵌预览 | `?inline=1` 返回 200 且 `Content-Disposition: inline`、`Content-Type` 为图片、默认仍为 attachment、Range 仍返回 206 |
| 学生端回读 | 提交详情可回读、含文件列表 |

实测结果：**通过 45 项，失败 0 项**。

### 4.2 学生端界面（20 项）

```powershell
node scripts/verify-homework-ui.mjs http://127.0.0.1:8090
```

通过 CDP 驱动真实页面，覆盖：

- 课程页出现「提交作业」按钮、课时标题正确渲染
- 弹窗可打开、标题正确、首次提交无重复提醒
- 填写姓名、选择 2 个文件、显示合计信息
- 确认提交后弹出「作业已提交」预览窗口
- 预览窗口展示提交人、来源 IP、文件预览区、状态标签
- 图片内嵌渲染、多文件切换条存在
- 再次打开时出现重复提醒
- 同班第二位学生提交后被标记重复，并提示被重复的提交人
- 无控制台报错

实测结果：**通过 20 项，失败 0 项**。

### 4.3 教师端界面（15 项）

```powershell
node scripts/verify-homework-admin-ui.mjs http://127.0.0.1:8090
```

覆盖：令牌注入后可进入页面、表格渲染、标题与 IP/重复概念展示、数据行存在、
详情弹窗打开、详情含提交人与 IP 与预览区、预览组件渲染、
审核按钮可用且状态更新为「已查看」、侧栏出现「作业提交」入口、无控制台报错。

实测结果：**通过 15 项，失败 0 项**。

### 4.4 界面截图

```powershell
node scripts/capture-homework.mjs http://127.0.0.1:8090
```

生成 `docs/screenshots/` 下的 `student-course-homework.png`（课程页入口）、
`homework-submit-dialog.png`（上传弹窗）、`homework-preview-dialog.png`（预览弹窗）。

教师端列表页截图：

```powershell
$env:CAPTURE_TOKEN = <登录令牌>
node scripts/capture.mjs "http://127.0.0.1:8090/admin/submissions" "docs/screenshots/admin-submissions.png"
```

## 5. 演示数据

```powershell
node scripts/seed-demo.mjs
```

生成 4 门课程（文字处理 3 课时、程序设计基础 3 课时、数据库原理 2 课时、视频剪辑 2 课时）、1 个班级，并发布一节进行中的课堂，便于演示与人工检查。

## 手动验证清单

自动化脚本之外，建议人工确认以下项目：

### 基础流程

- [ ] 服务启动后访问 `/` 显示学生端首页
- [ ] 未登录时导航栏只显示"登录"
- [ ] 登录后显示"全部课程"、"下载中心"、"教师端"和用户名
- [ ] 访问 `/admin/console` 未登录时重定向到 `/login`

### 课堂闭环

- [ ] 教师端选择班级、课程、课时后点击"开始上课"
- [ ] 学生端首页在 30 秒内自动显示当前课堂（无需刷新）
- [ ] 点击"暂停"后学生端状态变为"已暂停"
- [ ] 点击"结束课堂"后学生端恢复等待状态
- [ ] 结束的课堂仍出现在"最近课堂记录"中

### 大文件下载

- [ ] 上传 1 GB 以上文件，进度条正常推进
- [ ] 下载该文件，确认大小与 SHA-256 与源文件一致
- [ ] 使用支持续传的下载工具（如 `curl -C -`）验证断点续传
- [ ] 下载过程中观察服务器内存，确认无显著增长

### 作业提交

- [ ] 课程页选中课时后出现「提交作业」按钮
- [ ] 不填姓名直接提交，提示「请填写提交人姓名」
- [ ] 不选文件直接提交，提示「请至少选择一个文件」
- [ ] 一次选择图片 + 视频 + 文档，提交后预览窗口可在三者间切换
- [ ] 上传视频后预览窗口可直接播放，不触发下载
- [ ] 上传 PDF 后预览窗口内嵌显示
- [ ] 上传 docx / zip 时预览区给出下载入口而非空白
- [ ] 同班第二位同学打开上传弹窗时看到「本班已有人提交」提醒
- [ ] 第二位同学仍可提交，预览窗口显示「重复」标记与原提交人姓名
- [ ] 教师端「作业提交」页能看到两条记录，第二条带「重复」标签
- [ ] 教师端点「标记问题」后列表状态变为「已标记问题」
- [ ] 学生端提交后关闭浏览器再打开，姓名仍保留在输入框中
- [ ] 用 `curl` 直接 POST 提交并伪造 `X-Forwarded-For`，确认记录的 IP 未被伪造值覆盖

### 边界情况

- [ ] 同一班级两个浏览器窗口同时点"开始上课"，只有一个成功
- [ ] 上传过程中断网，重新上传后状态正常
- [ ] 上传文件在传输中损坏（可用工具篡改），服务端拒绝并提示校验失败
- [ ] 删除 `storage/objects` 下的文件后，下载返回明确的"文件缺失"提示

### 界面适配

- [ ] 窄屏（< 768px）下学生端卡片单列显示
- [ ] 窄屏下教师端侧栏折叠为横向导航
- [ ] 中文文件名下载后不乱码

## 已知限制

1. **多区间 Range 请求不支持**，返回 `416`。第一版无此需求。
2. **浏览器无法指定下载目录**，也无法保证页面关闭后自动续传。这是浏览器能力边界，方案 12.1 风险 3 已说明。
3. **未做并发压力测试**。方案要求至少 10、40 台并发验证，需在真实机房环境完成。
4. **未验证备份恢复流程**。流程已在部署文档中给出，建议现场演练。
5. **学生身份识别未实现**。方案 4.4 指出不能仅凭 IP 判断学生身份，该功能属于后续阶段。
6. **作业提交未与学生账号绑定**。当前按「姓名 + 来源 IP + 时间」记录，教师需人工核对姓名是否属实；后续接入学生登录后可改为账号绑定。
7. **Office 文档不支持页内预览**。docx / xlsx / pptx 需要额外的文档转换服务，第一版只提供下载入口，避免给出打不开的伪预览。
