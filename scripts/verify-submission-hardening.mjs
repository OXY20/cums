/**
 * 前端改动自检：验证教师端预览票与作业文件访问守卫。
 *
 * 覆盖：
 * 1. 管理员登录并取一份提交详情
 * 2. 详情里每个文件都应带 preview_ticket
 * 3. 带 preview_ticket 匿名访问文件 → 200（模拟 <img> 标签，无 Authorization 头）
 * 4. 无票匿名访问作业文件 → 403
 * 5. 票据绑定资源：拿 A 的票访问 B → 403
 * 6. 带 Bearer 访问 → 200
 * 7. 教学资源匿名访问 → 200（不受作业守卫影响）
 * 8. 学生端回读不带票，但带 access_token → 200
 */

const base = process.argv[2] ?? 'http://127.0.0.1:8099'
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'admin'

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function json(path, options = {}) {
  const response = await fetch(`${base}${path}`, options)
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body, headers: response.headers }
}

function makeFile(name, type, bytes) {
  return new File([new Uint8Array(bytes)], name, { type })
}

async function main() {
  console.log(`目标服务：${base}\n`)

  console.log('[1] 管理员登录')
  const login = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  })
  check('登录成功', login.status === 200, `status=${login.status}`)
  const token = login.body?.token
  if (!token) throw new Error('无法获取令牌，中止')
  const auth = { Authorization: `Bearer ${token}` }

  console.log('\n[2] 准备数据并提交（带图片，便于内联预览）')
  const cls = await json('/api/classes', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `预览票测试班-${Date.now()}`, room_name: '机房 A' }),
  })
  const classId = cls.body?.id
  const course = await json('/api/courses', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `预览票测试课程-${Date.now()}` }),
  })
  const courseId = course.body?.id
  const lesson = await json(`/api/courses/${courseId}/lessons`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '第 1 课时 · 预览票' }),
  })
  const lessonId = lesson.body?.id
  check('基础数据创建成功', !!(classId && courseId && lessonId))

  // 学生只能对已发布课程的课时提交作业：新建课程默认是草稿，
  // 这里显式发布，避免脚本走的是普通用户走不到的状态。
  await json(`/api/courses/${courseId}`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'published' }),
  })

  const form = new FormData()
  form.append('student_name', '预览票测试员')
  form.append('lesson_id', String(lessonId))
  form.append('class_id', String(classId))
  form.append('file', makeFile('截图.png', 'image/png', 1024))
  form.append('file', makeFile('报告.pdf', 'application/pdf', 2048))

  const submit = await json('/api/student/submissions', { method: 'POST', body: form })
  check('提交成功', submit.status === 200, JSON.stringify(submit.body).slice(0, 200))
  const submissionId = submit.body?.submission?.id
  const accessToken = submit.body?.access_token
  check('返回 access_token', typeof accessToken === 'string' && accessToken.length === 64, `len=${accessToken?.length}`)
  check('返回 withdraw_deadline', typeof submit.body?.withdraw_deadline === 'string', `${submit.body?.withdraw_deadline}`)

  console.log('\n[3] 教师端详情应下发预览票')
  const detail = await json(`/api/admin/submissions/${submissionId}`, { headers: auth })
  check('详情查询成功', detail.status === 200, `status=${detail.status}`)
  const files = detail.body?.files ?? []
  check('详情含 2 个文件', files.length === 2, `files=${files.length}`)
  check(
    '每个文件都带 preview_ticket',
    files.every((f) => typeof f.preview_ticket === 'string' && f.preview_ticket.length > 20),
    JSON.stringify(files.map((f) => !!f.preview_ticket)),
  )

  const img = files.find((f) => f.purpose === 'image')
  const pdf = files.find((f) => f.purpose === 'attachment')

  console.log('\n[4] 标签式访问（无 Authorization 头，只有预览票）')
  const inlineWithTicket = await json(
    `/files/${img.resource_id}?inline=1&preview_ticket=${encodeURIComponent(img.preview_ticket)}`,
  )
  check('带票内联预览 200', inlineWithTicket.status === 200, `status=${inlineWithTicket.status}`)
  check(
    '内联返回 inline',
    (inlineWithTicket.headers.get('content-disposition') ?? '').startsWith('inline'),
    `${inlineWithTicket.headers.get('content-disposition')}`,
  )
  check(
    '内联返回真实图片类型',
    (inlineWithTicket.headers.get('content-type') ?? '').startsWith('image/'),
    `${inlineWithTicket.headers.get('content-type')}`,
  )
  check(
    '带 nosniff',
    inlineWithTicket.headers.get('x-content-type-options') === 'nosniff',
    `${inlineWithTicket.headers.get('x-content-type-options')}`,
  )

  console.log('\n[5] 无票匿名访问作业文件应被拒绝')
  const noTicket = await json(`/files/${img.resource_id}?inline=1`)
  check('无票匿名访问 403', noTicket.status === 403, `status=${noTicket.status}`)

  console.log('\n[6] 票据绑定资源 ID')
  const crossTicket = await json(
    `/files/${pdf.resource_id}?preview_ticket=${encodeURIComponent(img.preview_ticket)}`,
  )
  check('用 A 的票访问 B 被拒绝', crossTicket.status === 403, `status=${crossTicket.status}`)

  console.log('\n[7] Bearer 访问仍正常')
  const withBearer = await json(`/files/${pdf.resource_id}`, { headers: auth })
  check('带 Bearer 下载 200', withBearer.status === 200, `status=${withBearer.status}`)
  const bearerRange = await json(`/files/${pdf.resource_id}`, {
    headers: { ...auth, Range: 'bytes=0-9' },
  })
  check('带 Bearer 的 Range 仍 206', bearerRange.status === 206, `status=${bearerRange.status}`)

  console.log('\n[8] 学生端回读与撤回')
  const readBack = await json(`/api/student/submissions/${submissionId}?access_token=${accessToken}`)
  check('带凭证回读 200', readBack.status === 200, `status=${readBack.status}`)
  check('学生端回读不含预览票', (readBack.body?.files ?? []).every((f) => !f.preview_ticket))
  const readBackNoToken = await json(`/api/student/submissions/${submissionId}`)
  check('无凭证回读 403', readBackNoToken.status === 403, `status=${readBackNoToken.status}`)
  const readBackBadToken = await json(
    `/api/student/submissions/${submissionId}?access_token=${'0'.repeat(64)}`,
  )
  check('错误凭证回读 403', readBackBadToken.status === 403, `status=${readBackBadToken.status}`)

  console.log('\n[9] 教学资源不受作业守卫影响')
  const reg = await json('/api/resources/register', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '教学课件.pdf', size_bytes: 1024 }),
  })
  const resId = reg.body?.resource_id
  const upForm = new FormData()
  upForm.append('file', makeFile('教学课件.pdf', 'application/pdf', 1024))
  const up = await json(`/api/resources/${resId}/upload`, { method: 'POST', headers: auth, body: upForm })
  check('教学资源上传成功', up.status === 200, `status=${up.status}`)
  const publicRes = await json(`/files/${resId}`)
  check('教学资源匿名可下载', publicRes.status === 200, `status=${publicRes.status}`)

  console.log('\n[10] 撤回后文件不再对匿名开放')
  const withdraw = await json(`/api/student/submissions/${submissionId}/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken }),
  })
  check('撤回成功', withdraw.status === 200, JSON.stringify(withdraw.body).slice(0, 200))

  const afterWithdrawTicket = await json(
    `/files/${img.resource_id}?inline=1&preview_ticket=${encodeURIComponent(img.preview_ticket)}`,
  )
  check('撤回后带票访问被拒', afterWithdrawTicket.status !== 200, `status=${afterWithdrawTicket.status}`)

  const withdrawAgain = await json(`/api/student/submissions/${submissionId}/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken }),
  })
  check('重复撤回被拒', withdrawAgain.status === 409, `status=${withdrawAgain.status}`)

  const listAfter = await json(`/api/admin/submissions?lesson_id=${lessonId}`, { headers: auth })
  check('教师端列表默认不含已撤回', listAfter.body?.total === 0, `total=${listAfter.body?.total}`)
  const listAll = await json(
    `/api/admin/submissions?lesson_id=${lessonId}&include_withdrawn=true`,
    { headers: auth },
  )
  check('include_withdrawn=true 能看到撤回记录', listAll.body?.total === 1, `total=${listAll.body?.total}`)

  console.log(`\n${'='.repeat(50)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) {
    console.log('\n失败项：')
    for (const item of failures) console.log(`  - ${item}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('验证脚本异常：', err)
  process.exitCode = 1
})
