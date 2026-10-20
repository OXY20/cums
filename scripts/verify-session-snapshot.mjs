// 验证课堂快照保存富文本正文。
//
// 用法：node scripts/verify-session-snapshot.mjs [baseUrl]
//
// 课堂快照必须保存富文本 HTML，否则学生端看到的课堂内容会丢失排版。

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'

let passed = 0
let failed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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

const login = await api('/api/auth/login', {
  method: 'POST',
  body: { username: 'admin', password: 'admin' },
})
const token = login.json?.token
if (!token) {
  console.error('登录失败')
  process.exit(2)
}

// 结束现有活动课堂，避免班级唯一性约束阻塞验证
const sessions = await api('/api/sessions', { token })
for (const s of sessions.json?.items ?? []) {
  if (s.status === 'running' || s.status === 'paused') {
    await api(`/api/sessions/${s.id}/end`, { method: 'POST', token })
    console.log(`已结束课堂 #${s.id}`)
  }
}

const suffix = Date.now().toString().slice(-6)
const course = await api('/api/courses', {
  method: 'POST',
  token,
  body: { title: `快照验证课程-${suffix}` },
})
const lesson = await api(`/api/courses/${course.json.id}/lessons`, {
  method: 'POST',
  token,
  body: { title: '富文本课时' },
})

const richHtml =
  '<h2>学习目标</h2><p><span style="color: #ff0000; font-size: 20px">红色大字</span></p>' +
  '<ul><li>要点一</li><li>要点二</li></ul>'

const saved = await api(`/api/lessons/${lesson.json.id}`, {
  method: 'PUT',
  token,
  body: { content_html: richHtml },
})
check('保存富文本课时', saved.status === 200)

const classes = await api('/api/classes', { token })
const classId = classes.json?.items?.[0]?.id
if (!classId) {
  console.error('没有可用班级')
  process.exit(2)
}

const session = await api('/api/sessions', {
  method: 'POST',
  token,
  body: { class_id: classId, lesson_id: lesson.json.id },
})
check('创建课堂', session.status === 200, `实际 ${session.status} ${session.text.slice(0, 120)}`)

const sessionId = session.json?.id
const view = await api(`/api/sessions/${sessionId}`, { token })
const html = view.json?.lesson_html ?? ''

check('课堂视图包含 lesson_html', typeof view.json?.lesson_html === 'string')
check('快照保留富文本内容', html.includes('红色大字'), html.slice(0, 120))
check('快照保留样式', html.includes('color'), '')
check('快照保留列表', html.includes('<ul>') || html.includes('<li>'), '')
check('快照保留标题层级', html.includes('<h2>'), '')

// 修改模板后，历史课堂不应变化（快照隔离）
await api(`/api/lessons/${lesson.json.id}`, {
  method: 'PUT',
  token,
  body: { content_html: '<p>已修改的新内容</p>' },
})
const viewAfter = await api(`/api/sessions/${sessionId}`, { token })
check(
  '修改模板后历史课堂内容不变',
  (viewAfter.json?.lesson_html ?? '').includes('红色大字') &&
    !(viewAfter.json?.lesson_html ?? '').includes('已修改的新内容'),
  (viewAfter.json?.lesson_html ?? '').slice(0, 100),
)

// 清理
await api(`/api/sessions/${sessionId}/end`, { method: 'POST', token })
await api(`/api/courses/${course.json.id}`, { method: 'DELETE', token })

console.log(`\n${'='.repeat(56)}`)
console.log(`合计 ${passed + failed} 项：通过 ${passed}，失败 ${failed}`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
}
console.log('='.repeat(56))

process.exit(failed === 0 ? 0 : 1)
