/**
 * 截取上传弹窗的两个关键状态：选中文件后的本地预览、再次打开时的设备警告。
 *
 * 用法：node scripts/capture-submit-dialog.mjs [baseUrl]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import zlib from 'node:zlib'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const OUT = 'docs/screenshots'

async function j(path, options = {}) {
  const r = await fetch(`${BASE}${path}`, options)
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

function makePng(w, h, draw) {
  const raw = []
  for (let y = 0; y < h; y += 1) {
    raw.push(0)
    for (let x = 0; x < w; x += 1) raw.push(...draw(x, y))
  }
  const table = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    let crc = 0xffffffff
    for (const b of body) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
    const cb = Buffer.alloc(4)
    cb.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([len, body, cb])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ])
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
  body: JSON.stringify({ name: `截图班-${stamp}` }),
})
const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '截图演示课程', description: '展示附件即时预览' }),
})
await j(`/api/courses/${course.body.id}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ status: 'published' }),
})
const lesson = await j(`/api/courses/${course.body.id}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 1 课时 · 图文混排练习' }),
})
const session = await j('/api/sessions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ class_id: cls.body.id, lesson_id: lesson.body.id }),
})
await j(`/api/sessions/${session.body.id}/start`, { method: 'POST', headers: H })

// 本设备先提交一次，用于第二个截图（设备警告）
const preForm = new FormData()
preForm.append('student_name', '张三')
preForm.append('lesson_id', String(lesson.body.id))
preForm.append('class_id', String(cls.body.id))
preForm.append('file', new File([Buffer.from('x')], 'a.txt', { type: 'text/plain' }))
await j('/api/student/submissions', { method: 'POST', body: preForm })

// 准备一张有内容的示例图片
const dir = join(tmpdir(), `cap-${stamp}`)
mkdirSync(dir, { recursive: true })
const imgPath = join(dir, '作业截图.png')
writeFileSync(imgPath, makePng(320, 220, (x, y) => {
  // 蓝底 + 白色对角条纹，视觉上能看出是真实图片
  const diag = (x + y) % 60 < 12
  return diag ? [255, 255, 255] : [64, 128, 240]
}))
const txtPath = join(dir, '实验说明.txt')
writeFileSync(txtPath, '图文混排练习\n\n1. 插入图片并设置四周环绕\n2. 添加文本框\n3. 调整页边距\n')

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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`求值失败：${r.exceptionDetails.text}`)
  return r.result.value
}
async function waitFor(expr, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expr)) return
    await new Promise((r) => setTimeout(r, 200))
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
  await new Promise((r) => setTimeout(r, 1500))

  // 填写姓名并选择文件
  await evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('.el-dialog input'))
    const t = inputs.find((i) => (i.placeholder || '').includes('姓名'))
    if (t) { t.value = '张三'; t.dispatchEvent(new Event('input', { bubbles: true })) }
  })()`)
  await setFiles('.el-dialog input[type=file]', [imgPath, txtPath])
  await new Promise((r) => setTimeout(r, 1600))
  await shot('homework-submit-preview.png')

  // 提交后重新打开，展示设备警告
  await clickByText('.el-dialog__footer button', '确认提交')
  await waitFor(
    `Array.from(document.querySelectorAll('.el-dialog__title')).some((t) => t.innerText.includes('作业已提交'))`,
    '提交成功',
    25000,
  )
  await clickByText('.el-dialog__footer button', '完成')
  await new Promise((r) => setTimeout(r, 900))

  await clickByText('button', '提交作业')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '再次打开')
  await new Promise((r) => setTimeout(r, 1800))
  await shot('homework-device-warning.png')
} finally {
  socket.close()
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
}
