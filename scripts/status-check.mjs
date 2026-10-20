// 运行状态检查：验证服务可用性与现有数据，供人工查看前确认。
//
// 用法：node scripts/status-check.mjs [baseUrl]

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'

async function getJson(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 保留原文 */
  }
  return { status: res.status, json, text }
}

console.log(`目标服务：${BASE}\n`)

// 版本
const version = await getJson('/api/version')
console.log('=== 服务信息 ===')
console.log('状态:', version.status === 200 ? '可用' : `异常（${version.status}）`)
console.log('名称:', version.json?.name)
console.log('版本:', version.json?.version)
console.log()

// 登录
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const login = await loginRes.json()
console.log('=== 登录 ===')
console.log('管理员登录:', loginRes.status === 200 && login.token ? '成功' : `失败（${loginRes.status}）`)
console.log('用户:', login.user?.display_name, `(${login.user?.role})`)
const token = login.token
console.log()

// 课程
const courses = await getJson('/api/student/courses')
console.log('=== 课程（学生端可见）===')
console.log('共', courses.json?.total, '门')
for (const c of courses.json?.items ?? []) {
  console.log(`  #${c.id} ${c.title} — ${c.lesson_count} 课时`)
}
console.log()

// 当前课堂
const current = await getJson('/api/student/current-session')
console.log('=== 当前课堂 ===')
if (current.json) {
  console.log('课程:', current.json.course_title, '·', current.json.lesson_title)
  console.log('班级:', current.json.class_name)
  console.log('教师:', current.json.teacher_name)
  console.log('状态:', current.json.session.status)
  console.log('开始:', current.json.session.started_at)
} else {
  console.log('（当前无进行中的课堂）')
}
console.log()

// 健康检查
const health = await getJson('/api/admin/health', token)
console.log('=== 健康状态 ===')
if (health.status === 200) {
  console.log('服务:', health.json.status)
  console.log('数据库:', health.json.database)
  console.log('活动课堂:', health.json.active_sessions)
  console.log('进行中下载:', health.json.active_downloads)
  console.log('资源占用:', health.json.objects_bytes, '字节')
  console.log('运行时长:', health.json.uptime_seconds, '秒')
} else {
  console.log('健康检查失败:', health.status, health.text)
}
console.log()

// 资源
const resources = await getJson('/api/resources', token)
console.log('=== 资源库 ===')
console.log('共', resources.json?.total ?? 0, '个资源')
for (const r of (resources.json?.items ?? []).slice(0, 5)) {
  console.log(`  #${r.id} ${r.name} — ${r.status} — ${r.size_bytes} 字节`)
}
console.log()

// 班级
const classes = await getJson('/api/classes')
console.log('=== 班级 ===')
for (const c of classes.json?.items ?? []) {
  console.log(`  #${c.id} ${c.name}（${c.room_name || '未填机房'}）`)
}
console.log()

console.log('=== 访问地址 ===')
console.log(`  学生端：${BASE}/`)
console.log(`  教师端：${BASE}/admin/console`)
console.log('  账号：admin / admin')
