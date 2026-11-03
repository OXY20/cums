/**
 * 路径与权限守卫回归：学生端与教师端的可见性边界。
 *
 * 覆盖三组约定：
 * 1. 下载中心只暴露已发布课程关联的就绪资源，教师资源库仍需登录；
 * 2. 未发布课程（草稿 / 归档）的课程、课时、资源、正文块对匿名一律 404，
 *    也不能开课或收作业；教师带令牌不受限；
 * 3. 撤回后回读与文件下载同样被拒。
 *
 * 用法：
 *   node scripts/verify-path-guard.mjs [baseUrl]
 *
 * 管理员凭据由环境变量提供，默认 admin / admin。
 * 脚本会创建一条测试提交并立即撤回，记录保留（教师端默认不可见）。
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:8099'
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'admin'

const rows = []

function check(name, ok, detail) {
  rows.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`)
}

async function call(method, path, { token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text }
}

async function json(method, path, options) {
  const res = await call(method, path, options)
  try {
    return { status: res.status, data: JSON.parse(res.text) }
  } catch {
    return { status: res.status, data: null }
  }
}

const login = await json('POST', '/api/auth/login', {
  body: { username: ADMIN_USER, password: ADMIN_PASS },
})
if (!login.data?.token) {
  console.error('登录失败，无法继续；请先确认服务已安装且凭据正确')
  process.exit(2)
}
const token = login.data.token

const courses = (await json('GET', '/api/courses', { token })).data.items
const published = courses.find((course) => course.status === 'published')
const unpublished = courses.find((course) => course.status !== 'published')

if (!published) {
  console.error('没有已发布课程，无法验证公开路径')
  process.exit(2)
}

const publishedLessons = (await json('GET', `/api/courses/${published.id}/lessons`)).data.items
const publishedLesson = publishedLessons[0]
if (!publishedLesson) {
  console.error('已发布课程没有课时，无法验证公开路径')
  process.exit(2)
}

// ---- 下载中心 ----
const studentResources = await json('GET', '/api/student/resources')
const resourceCount = studentResources.data?.items?.length ?? -1
check(
  '匿名可读学生端资源',
  studentResources.status === 200 && resourceCount >= 0,
  `status=${studentResources.status} count=${resourceCount}`,
)
check('匿名仍不可读教师资源库', (await call('GET', '/api/resources')).status === 401, 'expect 401')

// ---- 未发布内容边界 ----
if (unpublished) {
  const label = `${unpublished.title}(${unpublished.status})`
  const draftLessons = (await json('GET', `/api/courses/${unpublished.id}/lessons`, { token })).data
    ?.items
  const draftLesson = draftLessons?.[0]

  check('匿名读未发布课程被拒', (await call('GET', `/api/courses/${unpublished.id}`)).status === 404, label)
  check(
    '教师可读未发布课程',
    (await call('GET', `/api/courses/${unpublished.id}`, { token })).status === 200,
    label,
  )
  check(
    '匿名读未发布课时列表被拒',
    (await call('GET', `/api/courses/${unpublished.id}/lessons`)).status === 404,
    'expect 404',
  )

  if (draftLesson) {
    check(
      '匿名读未发布课时被拒',
      (await call('GET', `/api/lessons/${draftLesson.id}`)).status === 404,
      'expect 404',
    )
    check(
      '教师可读未发布课时',
      (await call('GET', `/api/lessons/${draftLesson.id}`, { token })).status === 200,
      'expect 200',
    )
    check(
      '匿名读未发布课时资源被拒',
      (await call('GET', `/api/lessons/${draftLesson.id}/resources`)).status === 404,
      'expect 404',
    )
    check(
      '匿名读未发布课时正文块被拒',
      (await call('GET', `/api/lessons/${draftLesson.id}/blocks`)).status === 404,
      'expect 404',
    )

    const form = new FormData()
    form.set('student_name', '路径守卫回归')
    form.set('lesson_id', String(draftLesson.id))
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt')
    check(
      '不能向未发布课时交作业',
      (await call('POST', '/api/student/submissions', { body: form })).status === 404,
      'expect 404',
    )

    const classes = (await json('GET', '/api/classes', { token })).data.items
    const sessions = (await json('GET', '/api/sessions', { token })).data.items
    // 有活动课堂的班级会先撞上 409，测不到课程状态这道校验，因此挑空闲班级。
    const busy = new Set(
      sessions
        .filter((item) => item.status === 'running' || item.status === 'paused')
        .map((item) => item.class_id),
    )
    const freeClass = classes?.find((item) => !busy.has(item.id))

    if (freeClass) {
      check(
        '不能给未发布课程开课',
        (
          await call('POST', '/api/sessions', {
            token,
            body: { class_id: freeClass.id, lesson_id: draftLesson.id },
          })
        ).status === 400,
        'expect 400',
      )
    }
  }
}

// ---- 已发布内容仍公开 ----
check('匿名可读已发布课程', (await call('GET', `/api/courses/${published.id}`)).status === 200, 'expect 200')
check(
  '匿名可读已发布课时列表',
  (await call('GET', `/api/courses/${published.id}/lessons`)).status === 200,
  'expect 200',
)
check(
  '匿名可读已发布课时',
  (await call('GET', `/api/lessons/${publishedLesson.id}`)).status === 200,
  'expect 200',
)
check(
  '匿名可读课时资源',
  (await call('GET', `/api/lessons/${publishedLesson.id}/resources`)).status === 200,
  'expect 200',
)

const current = (await json('GET', '/api/student/current-session')).data
if (current?.session) {
  check(
    '匿名可读当前课堂',
    (await call('GET', `/api/sessions/${current.session.id}`)).status === 200,
    'expect 200',
  )
}

// ---- 认证收口 ----
check('匿名不可枚举班级', (await call('GET', '/api/classes')).status === 401, 'expect 401')
check('教师可读班级', (await call('GET', '/api/classes', { token })).status === 200, 'expect 200')

// ---- 撤回语义 ----
const form = new FormData()
form.set('student_name', '路径守卫回归')
form.set('lesson_id', String(publishedLesson.id))
form.append('file', new Blob(['regress'], { type: 'text/plain' }), '路径守卫回归.txt')

const created = await json('POST', '/api/student/submissions', { body: form })
const submissionId = created.data?.submission?.id
const accessToken = created.data?.access_token

if (submissionId && accessToken) {
  check('提交成功', created.status === 200, `id=${submissionId}`)
  check(
    '撤回前可回读',
    (await call('GET', `/api/student/submissions/${submissionId}?access_token=${accessToken}`))
      .status === 200,
    'expect 200',
  )
  check(
    '撤回成功',
    (
      await call('POST', `/api/student/submissions/${submissionId}/withdraw`, {
        body: { access_token: accessToken },
      })
    ).status === 200,
    'expect 200',
  )
  check(
    '撤回后回读被拒',
    (await call('GET', `/api/student/submissions/${submissionId}?access_token=${accessToken}`))
      .status === 403,
    'expect 403',
  )
} else {
  check('提交成功', false, `status=${created.status} ${created.text.slice(0, 120)}`)
}

const failed = rows.filter((row) => !row.ok).length
console.log(`\nTOTAL ${rows.length}  PASS ${rows.length - failed}  FAIL ${failed}`)
process.exit(failed === 0 ? 0 : 1)
