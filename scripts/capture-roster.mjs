/**
 * 截取作业统计与名单管理界面。
 *
 * 用法：node scripts/capture-roster.mjs [baseUrl]
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const OUT = 'docs/screenshots'

async function j(path, options = {}) {
  const r = await fetch(`${BASE}${path}`, options)
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

const login = await j('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const token = login.body.token
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const stamp = Date.now()
// 班级名唯一：classes.name 有 UNIQUE 约束，重复创建会失败
const className = `25级计应1班-${stamp}`
const cls = await j('/api/classes', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ name: className, room_name: '实训楼 302' }),
})
const classId = cls.body.id

const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    title: '计算机应用基础',
    description: 'Windows 操作、图文混排与表格制作',
  }),
})
const courseId = course.body.id
await j(`/api/courses/${courseId}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ status: 'published' }),
})

const lessonTitles = ['第 1 课时 · 图文混排', '第 2 课时 · 表格制作', '第 3 课时 · 演示文稿']
const lessons = []
for (const title of lessonTitles) {
  const l = await j(`/api/courses/${courseId}/lessons`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ title }),
  })
  lessons.push(l.body)
}

// 一份完整名单
const roster = [
  ['20240101', '张三'],
  ['20240102', '李四'],
  ['20240103', '王五'],
  ['20240104', '赵六'],
  ['20240105', '钱七'],
  ['20240106', '孙八'],
  ['20240107', '周九'],
  ['20240108', '吴十'],
  ['20240109', '郑一'],
  ['20240110', '王二'],
]
await j(`/api/classes/${classId}/students/import`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ text: roster.map((r) => r.join(' ')).join('\n') }),
})

// 制造有差异的提交情况
const session = await j('/api/sessions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ class_id: classId, lesson_id: lessons[0].id }),
})
await j(`/api/sessions/${session.body.id}/start`, { method: 'POST', headers: H })

async function submit(name, no, lessonId) {
  const form = new FormData()
  form.append('student_name', name)
  form.append('student_no', no)
  form.append('lesson_id', String(lessonId))
  form.append('class_id', String(classId))
  form.append('file', new File([Buffer.from('x'.repeat(2048))], `${name}作业.txt`, { type: 'text/plain' }))
  return j('/api/student/submissions', { method: 'POST', body: form })
}

// 课时1：8 人交（2 人未交）
for (let i = 0; i < 8; i += 1) {
  await submit(roster[i][1], roster[i][0], lessons[0].id)
}
// 课时2：5 人交
for (let i = 0; i < 5; i += 1) {
  await submit(roster[i][1], roster[i][0], lessons[1].id)
}
// 课时3：9 人交
for (let i = 0; i < 9; i += 1) {
  await submit(roster[i][1], roster[i][0], lessons[2].id)
}

// ---- CDP ----
const res = await fetch(`${CDP}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
const target = await res.json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.id !== undefined) {
    const h = pending.get(m.id)
    if (h) {
      pending.delete(m.id)
      m.error ? h.reject(new Error(JSON.stringify(m.error))) : h.resolve(m.result)
    }
  }
})
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`求值失败：${r.exceptionDetails.text}`)
  return r.result.value
}
async function waitFor(expr, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expr)) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`等待超时：${label}`)
}
async function shot(name) {
  mkdirSync(OUT, { recursive: true })
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}`, Buffer.from(data, 'base64'))
  console.log(`已保存：${OUT}/${name}`)
}

try {
  await send('Page.navigate', { url: `${BASE}/student` })
  await waitFor(`document.body !== null`, '首页')
  await evaluate(`localStorage.setItem('classroom.token', ${JSON.stringify(token)})`)

  // 1. 课程详情 → 作业统计
  await send('Page.navigate', { url: `${BASE}/admin/courses/${courseId}` })
  await waitFor(`document.querySelector('.el-tabs') !== null`, '标签页')
  await evaluate(`(() => {
    const t = Array.from(document.querySelectorAll('.el-tabs__item')).find((x) => x.innerText.includes('作业统计'))
    if (t) t.click()
  })()`)
  await waitFor(`document.querySelector('.hw') !== null`, '统计面板')
  await new Promise((r) => setTimeout(r, 1200))

  // 选班级
  await evaluate(`(() => {
    const t = document.querySelector('.hw__head .el-select')
    if (t) t.click()
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.el-select-dropdown__item'))
    const target = items.find((i) => i.innerText.trim() === ${JSON.stringify(className)})
    if (target) target.click()
  })()`)
  await new Promise((r) => setTimeout(r, 2000))
  await shot('admin-homework-overview.png')

  // 2. 课时明细
  await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.hw__lesson'))
    if (rows[0]) rows[0].click()
  })()`)
  await waitFor(`document.querySelector('.board__missing-list') !== null`, '明细')
  await new Promise((r) => setTimeout(r, 900))
  await shot('admin-homework-board.png')

  // 3. 名单管理
  await send('Page.navigate', { url: `${BASE}/admin/roster` })
  await waitFor(`document.querySelector('.roster') !== null`, '名单页')
  await new Promise((r) => setTimeout(r, 1200))
  await evaluate(`(() => {
    const t = document.querySelector('.roster__head .el-select')
    if (t) t.click()
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.el-select-dropdown__item'))
    const target = items.find((i) => i.innerText.trim() === ${JSON.stringify(className)})
    if (target) target.click()
  })()`)
  await new Promise((r) => setTimeout(r, 1500))
  await shot('admin-roster.png')
} finally {
  socket.close()
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
}
