#!/usr/bin/env node
/**
 * 端到端冒烟测试：覆盖《机房教学资源平台建设方案》阶段一至阶段三的验收项。
 *
 * 用法：
 *   node scripts/smoke-test.mjs [baseUrl]
 *
 * 默认目标为 http://127.0.0.1:8080。
 * 该脚本会创建并清理自己的测试数据，但请勿指向生产数据目录。
 */

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:8080'

let passed = 0
let failed = 0
const failures = []

/** 断言辅助 */
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/** 发送请求；raw=true 时按原样发送 Buffer（用于 multipart） */
async function api(path, { method = 'GET', token, body, raw = false, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })

  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 保留原始文本 */
  }
  return { status: res.status, json, text, headers: res.headers }
}

/** 计算字符串的 SHA-256 */
async function sha256Hex(buffer) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(buffer).digest('hex')
}

/** 构造 multipart 上传体 */
function buildMultipart(buffer, filename, boundary) {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return Buffer.concat([head, buffer, tail])
}

async function main() {
  console.log(`目标服务：${BASE}`)

  // -------------------------------------------------------------------------
  section('一、认证与权限')
  // -------------------------------------------------------------------------

  const badLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'definitely-wrong' },
  })
  check('错误口令被拒绝', badLogin.status === 401, `实际 ${badLogin.status}`)

  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin' },
  })
  check('管理员登录成功', login.status === 200 && typeof login.json?.token === 'string')
  const token = login.json.token

  const unauth = await api('/api/admin/health')
  check('未认证访问管理接口返回 401', unauth.status === 401, `实际 ${unauth.status}`)

  const badToken = await api('/api/admin/health', { token: 'not-a-real-token' })
  check('伪造令牌被拒绝', badToken.status === 401, `实际 ${badToken.status}`)

  const me = await api('/api/auth/me', { token })
  check('获取当前用户信息', me.status === 200 && me.json?.username === 'admin')

  const version = await api('/api/version')
  check('公开版本接口无需登录', version.status === 200 && !!version.json?.version)

  // -------------------------------------------------------------------------
  section('二、班级与机房')
  // -------------------------------------------------------------------------

  const classSuffix = Date.now().toString().slice(-6)
  const className = `自动化测试班-${classSuffix}`

  const createClass = await api('/api/classes', {
    method: 'POST',
    token,
    body: { name: className, room_name: '第一机房' },
  })
  check('创建班级与机房', createClass.status === 200 && createClass.json?.name === className)
  const classId = createClass.json.id

  const dupClass = await api('/api/classes', {
    method: 'POST',
    token,
    body: { name: className, room_name: '第一机房' },
  })
  check('同名班级被拒绝（唯一约束）', dupClass.status === 409, `实际 ${dupClass.status}`)

  const listClasses = await api('/api/classes')
  check(
    '班级列表包含新建班级',
    listClasses.status === 200 && listClasses.json.items.some((c) => c.id === classId),
  )

  // -------------------------------------------------------------------------
  section('三、课程与课时')
  // -------------------------------------------------------------------------

  const createCourse = await api('/api/courses', {
    method: 'POST',
    token,
    body: { title: `自动化测试课程-${classSuffix}`, description: '用于端到端验证' },
  })
  check('创建课程', createCourse.status === 200 && !!createCourse.json?.id)
  const courseId = createCourse.json.id
  check('新课程默认为草稿状态', createCourse.json.status === 'draft')

  // 草稿课程不应出现在学生端列表
  const studentCoursesBefore = await api('/api/student/courses')
  check(
    '草稿课程不出现在学生端列表',
    !studentCoursesBefore.json.items.some((c) => c.id === courseId),
  )

  const publish = await api(`/api/courses/${courseId}`, {
    method: 'PUT',
    token,
    body: { status: 'published' },
  })
  check('发布课程', publish.status === 200 && publish.json.status === 'published')

  const studentCoursesAfter = await api('/api/student/courses')
  check(
    '已发布课程出现在学生端列表',
    studentCoursesAfter.json.items.some((c) => c.id === courseId),
  )

  const createLesson = await api(`/api/courses/${courseId}/lessons`, {
    method: 'POST',
    token,
    body: {
      title: '第 1 课时：图文混排',
      content_json: JSON.stringify({
        goal: '掌握图文混排的基本方法',
        steps: '1. 插入图片；2. 设置环绕方式',
        task: '完成一份图文混排文档',
      }),
    },
  })
  check('创建课时', createLesson.status === 200 && !!createLesson.json?.id)
  const lessonId = createLesson.json.id

  const autoOrder = await api(`/api/courses/${courseId}/lessons`, {
    method: 'POST',
    token,
    body: { title: '第 2 课时：表格制作' },
  })
  check('课时排序自动递增', autoOrder.json?.sort_order === 2, `实际 ${autoOrder.json?.sort_order}`)

  const copyCourse = await api(`/api/courses/${courseId}/copy`, { method: 'POST', token })
  check('复制课程模板', copyCourse.status === 200 && copyCourse.json?.title.includes('副本'))
  const copiedCourseId = copyCourse.json.id

  const copiedLessons = await api(`/api/courses/${copiedCourseId}/lessons`)
  check('复制课程同时复制课时', copiedLessons.json?.total === 2, `实际 ${copiedLessons.json?.total}`)

  // -------------------------------------------------------------------------
  section('四、课堂控制')
  // -------------------------------------------------------------------------

  const noSession = await api(`/api/student/current-session?class_id=${classId}`)
  check('无课堂时学生端返回空状态', noSession.status === 200 && noSession.json === null)

  const createSession = await api('/api/sessions', {
    method: 'POST',
    token,
    body: { class_id: classId, lesson_id: lessonId },
  })
  check('创建课堂场次', createSession.status === 200 && !!createSession.json?.id)
  const sessionId = createSession.json.id
  check('新场次处于暂停状态', createSession.json.status === 'paused')

  const start = await api(`/api/sessions/${sessionId}/start`, { method: 'POST', token })
  check('开始上课', start.status === 200 && start.json.status === 'running')

  const currentSession = await api(`/api/student/current-session?class_id=${classId}`)
  check(
    '学生端显示当前课堂',
    currentSession.status === 200 &&
      currentSession.json?.lesson_title === '第 1 课时：图文混排' &&
      currentSession.json?.class_name === className,
  )
  check(
    '学生端包含课时结构化内容',
    currentSession.json?.lesson_content?.goal === '掌握图文混排的基本方法',
  )

  // 同一班级不允许第二个活动课堂
  const conflictSession = await api('/api/sessions', {
    method: 'POST',
    token,
    body: { class_id: classId, lesson_id: lessonId },
  })
  check('同班级并发活动课堂被拒绝', conflictSession.status === 409, `实际 ${conflictSession.status}`)

  const pause = await api(`/api/sessions/${sessionId}/pause`, { method: 'POST', token })
  check('暂停课堂', pause.status === 200 && pause.json.status === 'paused')

  const resume = await api(`/api/sessions/${sessionId}/start`, { method: 'POST', token })
  check('恢复课堂', resume.status === 200 && resume.json.status === 'running')

  const pauseAgain = await api(`/api/sessions/${sessionId}/pause`, { method: 'POST', token })
  check('再次暂停', pauseAgain.status === 200)

  // 模板修改后，历史课堂快照应保持不变
  const modifyLesson = await api(`/api/lessons/${lessonId}`, {
    method: 'PUT',
    token,
    body: { content_json: JSON.stringify({ goal: '被修改后的目标' }) },
  })
  check('修改课时模板', modifyLesson.status === 200)

  const snapshotCheck = await api(`/api/sessions/${sessionId}`)
  check(
    '历史课堂保留原始快照',
    snapshotCheck.json?.lesson_content?.goal === '掌握图文混排的基本方法',
    `实际 ${snapshotCheck.json?.lesson_content?.goal}`,
  )

  const end = await api(`/api/sessions/${sessionId}/end`, { method: 'POST', token })
  check('结束课堂', end.status === 200 && end.json.status === 'ended')

  const afterEnd = await api(`/api/student/current-session?class_id=${classId}`)
  check('结束后学生端不再显示课堂', afterEnd.json === null)

  const restart = await api(`/api/sessions/${sessionId}/start`, { method: 'POST', token })
  check('已结束课堂不能重新开始', restart.status === 409, `实际 ${restart.status}`)

  const deleteUsedCourse = await api(`/api/courses/${courseId}`, { method: 'DELETE', token })
  check('有授课记录的课程禁止删除', deleteUsedCourse.status === 409, `实际 ${deleteUsedCourse.status}`)

  // -------------------------------------------------------------------------
  section('五、资源库与大文件传输')
  // -------------------------------------------------------------------------

  // 构造 3 MiB 确定性测试数据
  const payload = Buffer.alloc(3 * 1024 * 1024 + 4096)
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31 + 7) % 251
  const digest = await sha256Hex(payload)

  const register = await api('/api/resources/register', {
    method: 'POST',
    token,
    body: { name: '自动化测试资源.bin', size_bytes: payload.length, sha256: digest },
  })
  check('登记资源元数据', register.status === 200 && !!register.json?.resource_id)
  const resourceId = register.json.resource_id
  check('storage_key 由服务端生成', /^[0-9a-f]{2}\//.test(register.json.storage_key))

  const boundary = `----smoke${Date.now()}`
  const multipart = buildMultipart(payload, 'test-resource.bin', boundary)

  const upload = await api(`/api/resources/${resourceId}/upload`, {
    method: 'POST',
    token,
    body: multipart,
    raw: true,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  })
  check('上传资源成功', upload.status === 200, `实际 ${upload.status} ${upload.text.slice(0, 120)}`)
  check('服务端计算 SHA-256 与客户端一致', upload.json?.sha256 === digest)
  check('上传后状态为可用', upload.json?.status === 'ready')

  // 摘要不匹配时应拒绝
  const wrongRegister = await api('/api/resources/register', {
    method: 'POST',
    token,
    body: { name: '错误摘要.bin', size_bytes: 1024, sha256: 'a'.repeat(64) },
  })
  const wrongBoundary = `----smokeWrong${Date.now()}`
  const wrongUpload = await api(`/api/resources/${wrongRegister.json.resource_id}/upload`, {
    method: 'POST',
    token,
    body: buildMultipart(Buffer.alloc(1024, 1), 'wrong.bin', wrongBoundary),
    raw: true,
    headers: { 'Content-Type': `multipart/form-data; boundary=${wrongBoundary}` },
  })
  check('SHA-256 不匹配时拒绝并报错', wrongUpload.status === 400, `实际 ${wrongUpload.status}`)

  // HEAD 元信息
  const head = await fetch(`${BASE}/files/${resourceId}`, { method: 'HEAD' })
  check('HEAD 返回 200', head.status === 200)
  check('HEAD 声明支持 Range', head.headers.get('accept-ranges') === 'bytes')
  check('HEAD 返回正确 Content-Length', Number(head.headers.get('content-length')) === payload.length)
  check('HEAD 返回 ETag', (head.headers.get('etag') ?? '').includes(digest.slice(0, 16)))

  // 完整下载
  const full = await fetch(`${BASE}/files/${resourceId}`)
  const fullBuffer = Buffer.from(await full.arrayBuffer())
  check('完整下载内容一致', fullBuffer.equals(payload))

  // 中间区间
  const mid = await fetch(`${BASE}/files/${resourceId}`, { headers: { Range: 'bytes=1000-1999' } })
  const midBuffer = Buffer.from(await mid.arrayBuffer())
  check('中间区间返回 206', mid.status === 206, `实际 ${mid.status}`)
  check('中间区间内容正确', midBuffer.equals(payload.subarray(1000, 2000)))
  check(
    'Content-Range 头正确',
    mid.headers.get('content-range') === `bytes 1000-1999/${payload.length}`,
    mid.headers.get('content-range'),
  )

  // 后缀区间
  const suffix = await fetch(`${BASE}/files/${resourceId}`, { headers: { Range: 'bytes=-1024' } })
  const suffixBuffer = Buffer.from(await suffix.arrayBuffer())
  check('后缀区间返回 206', suffix.status === 206)
  check('后缀区间内容正确', suffixBuffer.equals(payload.subarray(payload.length - 1024)))

  // 开放式区间
  const openEnd = await fetch(`${BASE}/files/${resourceId}`, {
    headers: { Range: `bytes=${payload.length - 512}-` },
  })
  const openBuffer = Buffer.from(await openEnd.arrayBuffer())
  check('开放式区间返回 206 且内容正确', openEnd.status === 206 && openBuffer.equals(payload.subarray(payload.length - 512)))

  // 无效区间
  const invalid = await fetch(`${BASE}/files/${resourceId}`, {
    headers: { Range: `bytes=${payload.length + 100}-${payload.length + 200}` },
  })
  check('超出范围的区间返回 416', invalid.status === 416, `实际 ${invalid.status}`)

  const malformed = await fetch(`${BASE}/files/${resourceId}`, { headers: { Range: 'bytes=abc-def' } })
  check('格式错误的区间返回 416', malformed.status === 416, `实际 ${malformed.status}`)

  // 多区间不支持时应明确拒绝，而不是静默降级
  const multi = await fetch(`${BASE}/files/${resourceId}`, {
    headers: { Range: 'bytes=0-99,200-299' },
  })
  check('多区间请求被明确拒绝', multi.status === 416, `实际 ${multi.status}`)

  // If-Range 不匹配时回退完整下载
  const stale = await fetch(`${BASE}/files/${resourceId}`, {
    headers: { Range: 'bytes=0-99', 'If-Range': '"stale-etag"' },
  })
  const staleBuffer = Buffer.from(await stale.arrayBuffer())
  check('If-Range 不匹配时返回完整文件', stale.status === 200 && staleBuffer.equals(payload))

  // If-Range 匹配时正常返回部分内容
  const matching = await fetch(`${BASE}/files/${resourceId}`, {
    headers: { Range: 'bytes=0-99', 'If-Range': `"${digest}"` },
  })
  check('If-Range 匹配时返回 206', matching.status === 206, `实际 ${matching.status}`)

  // 路径穿越防护
  const traversal = await api('/files/..%2f..%2fapp%2fconfig%2fconfig.toml')
  check(
    '编码路径穿越被拒绝',
    traversal.status === 400 || traversal.status === 404 || traversal.status === 403,
    `实际 ${traversal.status}`,
  )

  // 资源与课时关联
  const attach = await api(`/api/lessons/${lessonId}/resources/${resourceId}`, {
    method: 'POST',
    token,
  })
  check('关联资源到课时', attach.status === 200)

  const lessonResources = await api(`/api/lessons/${lessonId}/resources`)
  check(
    '课时资源列表包含关联资源',
    lessonResources.json.items.some((r) => r.id === resourceId),
  )

  // -------------------------------------------------------------------------
  section('六、审计与监控')
  // -------------------------------------------------------------------------

  const health = await api('/api/admin/health', { token })
  check('健康检查可用', health.status === 200 && health.json.database === 'ok')
  check('健康检查返回资源占用', typeof health.json.objects_bytes === 'number')
  check('健康检查反映活动课堂数', health.json.active_sessions === 0)

  const audit = await api('/api/admin/audit-logs?limit=50', { token })
  check('审计日志可查询', audit.status === 200 && Array.isArray(audit.json.items))
  check(
    '审计日志记录了关键操作',
    audit.json.items.some((item) => item.action === 'auth.login') &&
      audit.json.items.some((item) => item.action === 'session.create'),
  )

  // -------------------------------------------------------------------------
  section('七、SSE 实时事件')
  // -------------------------------------------------------------------------

  // 订阅事件流，然后触发一次课堂操作，验证事件可达
  const controller = new AbortController()
  const events = []
  const ssePromise = (async () => {
    const res = await fetch(`${BASE}/api/events`, { signal: controller.signal })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const deadline = Date.now() + 5000
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        events.push(decoder.decode(value, { stream: true }))
        if (events.join('').includes('session.started')) break
      }
    } catch {
      /* 中断属预期 */
    }
  })()

  // 等待订阅建立
  await new Promise((resolve) => setTimeout(resolve, 400))

  const sseSession = await api('/api/sessions', {
    method: 'POST',
    token,
    body: { class_id: classId, lesson_id: lessonId },
  })
  await api(`/api/sessions/${sseSession.json.id}/start`, { method: 'POST', token })

  await Promise.race([ssePromise, new Promise((resolve) => setTimeout(resolve, 6000))])
  controller.abort()

  check(
    'SSE 推送课堂开始事件',
    events.join('').includes('session.started'),
    events.join('').slice(0, 120),
  )

  await api(`/api/sessions/${sseSession.json.id}/end`, { method: 'POST', token })

  // -------------------------------------------------------------------------
  section('八、清理')
  // -------------------------------------------------------------------------

  const cleanupSession = await api(`/api/sessions/${sseSession.json.id}/end`, {
    method: 'POST',
    token,
  })
  check('清理：结束测试课堂', cleanupSession.status === 409 || cleanupSession.status === 200)

  // 清理：删除复制的课程（无授课记录）
  const deleteCopy = await api(`/api/courses/${copiedCourseId}`, { method: 'DELETE', token })
  check('清理：删除复制的课程', deleteCopy.status === 200)

  // 资源与课时仍被测试数据引用，保留以便人工检查；此处仅删除资源
  const deleteResource = await api(`/api/resources/${resourceId}`, { method: 'DELETE', token })
  check('清理：删除测试资源', deleteResource.status === 200)

  // -------------------------------------------------------------------------
  console.log(`\n${'='.repeat(56)}`)
  console.log(`合计 ${passed + failed} 项：通过 ${passed}，失败 ${failed}`)
  if (failures.length > 0) {
    console.log('\n失败项：')
    for (const item of failures) console.log(`  - ${item}`)
  }
  console.log('='.repeat(56))

  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试执行异常：', err)
  process.exit(2)
})
