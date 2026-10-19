/**
 * 截取作业上传弹窗与提交预览弹窗，作为功能留档。
 *
 * 用法：node scripts/capture-homework.mjs [baseUrl] [cdpEndpoint]
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8090'
const CDP = process.argv[3] ?? process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const OUT_DIR = 'docs/screenshots'

async function apiJson(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const login = await apiJson('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const token = login.body?.token
const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

// 找一门已发布课程，截取它的课时页
const published = await apiJson('/api/student/courses')
const course = published.body?.items?.[0]
if (!course) {
  console.error('没有已发布课程，无法截图')
  process.exit(2)
}
const lessons = await apiJson(`/api/courses/${course.id}/lessons`)
const lesson = lessons.body?.items?.[0]
if (!lesson) {
  console.error('课程没有课时，无法截图')
  process.exit(2)
}

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
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const handler = pending.get(message.id)
    if (handler) {
      pending.delete(message.id)
      message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result)
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

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(`求值失败：${result.exceptionDetails.text}`)
  return result.result.value
}

async function waitFor(expression, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`等待超时：${label}`)
}

async function shot(name) {
  mkdirSync(OUT_DIR, { recursive: true })
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = `${OUT_DIR}/${name}`
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`已保存：${file}`)
}

async function clickByText(selector, text) {
  const ok = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
    const node = nodes.find((n) => (n.innerText || n.textContent || '').includes(${JSON.stringify(text)}))
    if (!node) return false
    node.scrollIntoView({ block: 'center' })
    node.click()
    return true
  })()`)
  if (!ok) throw new Error(`未找到：${selector} / ${text}`)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})

try {
  // 课程页
  await send('Page.navigate', { url: `${BASE}/student/courses/${course.id}` })
  await waitFor(`Array.from(document.querySelectorAll('button')).some((b) => b.innerText.includes('提交作业'))`, '提交作业按钮')
  await new Promise((r) => setTimeout(r, 800))
  await shot('student-course-homework.png')

  // 上传弹窗
  await clickByText('button', '提交作业')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '上传弹窗')
  await new Promise((r) => setTimeout(r, 900))
  await shot('homework-submit-dialog.png')

  // 找一条已有提交，直接打开预览弹窗（复用学生端回读接口）
  const submissions = await apiJson(`/api/admin/submissions?lesson_id=${lesson.id}&limit=1`, {
    headers: authHeaders,
  })
  const existing = submissions.body?.items?.[0]

  if (existing) {
    // 学生端没有「按 ID 打开预览」的路由，因此这里用教师端详情弹窗截图；
    // 两者复用的是同一个 SubmissionPreview 组件，预览效果一致。
    await send('Page.navigate', { url: `${BASE}/admin/submissions` })
    await new Promise((r) => setTimeout(r, 1200))
    await evaluate(`localStorage.setItem('classroom.token', ${JSON.stringify(token)})`)
    await send('Page.navigate', { url: `${BASE}/admin/submissions` })
    await waitFor(`document.querySelector('.el-table__body tr') !== null`, '提交表格')
    await new Promise((r) => setTimeout(r, 800))
    await clickByText('.el-table__body button', '查看')
    await waitFor(`document.querySelector('.el-dialog') !== null`, '详情弹窗')
    await new Promise((r) => setTimeout(r, 1800))
    await shot('homework-preview-dialog.png')
  } else {
    console.log('当前课时还没有提交记录，跳过预览弹窗截图')
  }
} finally {
  socket.close()
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
}
