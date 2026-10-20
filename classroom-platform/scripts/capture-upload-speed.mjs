/**
 * 截取上传中显示速度与剩余时间的画面。
 *
 * 用 CDP 限速制造可观察的传输过程。
 *
 * 用法：node scripts/capture-upload-speed.mjs [baseUrl]
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
const cls = await j('/api/classes', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ name: `速度截图班-${stamp}` }),
})
const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '截图演示课程 · 上传进度', description: '展示上传速度与预计剩余时间' }),
})
await j(`/api/courses/${course.body.id}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ status: 'published' }),
})
const lesson = await j(`/api/courses/${course.body.id}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 1 课时 · 提交作业' }),
})
const session = await j('/api/sessions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ class_id: cls.body.id, lesson_id: lesson.body.id }),
})
await j(`/api/sessions/${session.body.id}/start`, { method: 'POST', headers: H })

// 20 MB 文件，2 MB/s 下约 10 秒，有充足时间截图
const dir = join(tmpdir(), `capspeed-${stamp}`)
mkdirSync(dir, { recursive: true })
const bigPath = join(dir, '课堂录像.mp4')
writeFileSync(bigPath, Buffer.alloc(20 * 1024 * 1024, 0x42))

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
await send('Network.enable')
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
async function waitFor(expr, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expr)) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`等待超时：${label}`)
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
async function setFiles(selector, paths) {
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true })
  const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
  await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: paths })
}
async function shot(name) {
  mkdirSync(OUT, { recursive: true })
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(`${OUT}/${name}`, Buffer.from(data, 'base64'))
  console.log(`已保存：${OUT}/${name}`)
}

try {
  await send('Page.navigate', { url: `${BASE}/student/courses/${course.body.id}` })
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((b) => b.innerText.includes('提交作业'))`,
    '提交作业按钮',
  )
  await clickByText('button', '提交作业')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '上传弹窗')
  await new Promise((r) => setTimeout(r, 1200))

  // 限速到 2 MB/s，20 MB 文件约需 10 秒
  await send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 25,
    downloadThroughput: -1,
    uploadThroughput: 2 * 1024 * 1024,
  })

  await evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('.el-dialog input'))
    const t = inputs.find((i) => (i.placeholder || '').includes('姓名'))
    if (t) { t.value = '张三'; t.dispatchEvent(new Event('input', { bubbles: true })) }
  })()`)
  await setFiles('.el-dialog input[type=file]', [bigPath])
  await new Promise((r) => setTimeout(r, 1200))

  await clickByText('.el-dialog__footer button', '确认提交')
  await waitFor(`document.querySelector('.upload-progress') !== null`, '上传进度区')

  // 等速度算出来（需要几百毫秒的采样窗口）
  await new Promise((r) => setTimeout(r, 3500))
  const stats = await evaluate(`document.querySelector('.upload-progress__stats')?.innerText ?? ''`)
  console.log(`截图时状态：${stats.replace(/\n/g, ' | ')}`)
  await shot('homework-upload-speed.png')
} finally {
  socket.close()
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
  // 浏览器可能还持有文件句柄，清理失败不影响截图结果
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 临时目录留在系统 temp 下，由系统清理 */
  }
}
