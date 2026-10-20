/**
 * 截取作业批改界面。
 *
 * 造一个有差异的批改场景：10 人名单、9 人提交、已批一部分，
 * 这样截图里能同时看到统计分布、待批改数量和平均分。
 *
 * 用法：node scripts/capture-review.mjs [baseUrl]
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

const lesson = await j(`/api/courses/${courseId}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 1 课时 · 图文混排' }),
})
const lessonId = lesson.body.id

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

const session = await j('/api/sessions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ class_id: classId, lesson_id: lessonId }),
})
await j(`/api/sessions/${session.body.id}/start`, { method: 'POST', headers: H })

async function submit(name, no) {
  const form = new FormData()
  form.append('student_name', name)
  form.append('student_no', no)
  form.append('lesson_id', String(lessonId))
  form.append('class_id', String(classId))
  form.append(
    'file',
    new File([Buffer.from(`# ${name} 的作业\n\n图文混排练习内容。`)], `${name}-图文混排.txt`, {
      type: 'text/plain',
    }),
  )
  return j('/api/student/submissions', { method: 'POST', body: form })
}

// 前 9 人提交，王二（20240110）不交
const ids = []
for (let i = 0; i < 9; i += 1) {
  const r = await submit(roster[i][1], roster[i][0])
  ids.push(r.body.submission.id)
}

// 预先批一部分，制造分布：2 好 / 3 通过 / 1 不通过 / 1 其他 / 2 待批
const preset = [
  { label: 'good', score: 95, comment: '版式清晰，图文比例得当' },
  { label: 'good', score: 92, comment: '细节处理到位' },
  { label: 'pass', score: 80 },
  { label: 'pass', score: 78 },
  { label: 'pass', score: 82 },
  { label: 'fail', score: 55, comment: '图片未按比例缩放，出现拉伸变形，请修正后重新提交' },
  { label: 'other', score: 70, comment: '内容完整但缺少题目要求的页脚' },
]
for (let i = 0; i < preset.length; i += 1) {
  await j(`/api/admin/submissions/${ids[i]}/review`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(preset[i]),
  })
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
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error(`求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  }
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
  await waitFor(
    `location.origin === ${JSON.stringify(new URL(BASE).origin)} && document.body !== null`,
    '首页',
  )
  await evaluate(`localStorage.setItem('classroom.token', ${JSON.stringify(token)})`)

  // 1. 批改页：统计与列表
  await send('Page.navigate', {
    url: `${BASE}/admin/lessons/${lessonId}/review?class_id=${classId}`,
  })
  await waitFor(`document.querySelector('.review__stats') !== null`, '批改页', 25000)
  await new Promise((r) => setTimeout(r, 1500))
  await shot('admin-review-board.png')

  // 2. 逐份批改抽屉：打开「不通过」那一份，能看到评语
  await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.el-table__body-wrapper tbody tr'))
    // 找带「不通过」深色标签的那一行
    const target = rows.find((tr) => {
      const active = Array.from(tr.querySelectorAll('.review__tag-btn'))
        .find((t) => t.classList.contains('el-tag--dark'))
      return active && active.innerText.trim() === '不通过'
    })
    const cell = (target ?? rows[0]).querySelectorAll('td')[2]
    cell?.click()
  })()`)
  await waitFor(`document.querySelector('.el-drawer') !== null`, '批改抽屉')
  await new Promise((r) => setTimeout(r, 1500))
  await shot('admin-review-drawer.png')
} finally {
  socket.close()
  // 清理截图数据：课程与班级删除后提交随之级联删除
  await j(`/api/courses/${courseId}`, { method: 'DELETE', headers: H })
  await j(`/api/classes/${classId}`, { method: 'DELETE', headers: H })
  console.log('已清理截图用测试数据')
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
}
