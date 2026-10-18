// 清理测试过程中留下的数据。
//
// 用法：node scripts/cleanup-test-data.mjs [baseUrl]
//
// 删除标题带「测试」「调试」「Quill」「富文本测试」「界面验证」「快照验证」
// 且没有授课记录的课程，并移除孤立的资源记录。
//
// 注意：有授课记录的课程按设计不能删除，这里只做停用处理。

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'

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

const PATTERNS = [
  '自动化测试课程',
  '富文本测试',
  'Quill类测试',
  '快照验证',
  '界面验证',
  '删除调试',
  '测试-',
  '[测试]',
]

const courses = await api('/api/courses', { token })
let removed = 0
let archived = 0
let kept = 0

for (const course of courses.json?.items ?? []) {
  const matched = PATTERNS.some((pattern) => course.title.includes(pattern))
  if (!matched) {
    kept += 1
    continue
  }

  const del = await api(`/api/courses/${course.id}`, { method: 'DELETE', token })
  if (del.status === 200) {
    removed += 1
    console.log(`已删除：#${course.id} ${course.title}`)
  } else if (del.status === 409) {
    // 有授课记录，改为停用
    await api(`/api/courses/${course.id}`, {
      method: 'PUT',
      token,
      body: { status: 'archived' },
    })
    archived += 1
    console.log(`已归档（有授课记录）：#${course.id} ${course.title}`)
  } else {
    console.log(`跳过：#${course.id} ${course.title}（${del.status}）`)
  }
}

console.log(`\n删除 ${removed} 门，归档 ${archived} 门，保留 ${kept} 门正常课程`)

// 结束遗留的活动课堂，便于后续测试
const sessions = await api('/api/sessions', { token })
for (const s of sessions.json?.items ?? []) {
  if (s.status === 'running' || s.status === 'paused') {
    await api(`/api/sessions/${s.id}/end`, { method: 'POST', token })
    console.log(`已结束遗留课堂 #${s.id}`)
  }
}
