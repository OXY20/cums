/**
 * 验证两项 UI 行为：
 * 1. 提示语是「当前设备已提交」，而非「本班谁最早交」；
 * 2. 选择附件后立即在弹窗内显示文件内容预览。
 *
 * 用法：node scripts/verify-submit-dialog-ui.mjs [baseUrl] [cdpEndpoint]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import zlib from 'node:zlib'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'
const CDP = process.argv[3] ?? process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

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

async function j(path, options = {}) {
  const r = await fetch(`${BASE}${path}`, options)
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

/** 生成可见 PNG */
function makePng(w, h, rgb) {
  const raw = []
  for (let y = 0; y < h; y += 1) {
    raw.push(0)
    for (let x = 0; x < w; x += 1) raw.push(...rgb)
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

// 准备数据
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
  body: JSON.stringify({ name: `弹窗测试班-${stamp}` }),
})
const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: `弹窗测试课程-${stamp}`, description: '验证上传弹窗' }),
})
await j(`/api/courses/${course.body.id}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ status: 'published' }),
})
const lesson = await j(`/api/courses/${course.body.id}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 1 课时 · 上传弹窗验证' }),
})
const session = await j('/api/sessions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ class_id: cls.body.id, lesson_id: lesson.body.id }),
})
await j(`/api/sessions/${session.body.id}/start`, { method: 'POST', headers: H })

// 先让「其他设备」提交一条，制造「本班已有提交」的场景
const preForm = new FormData()
preForm.append('student_name', '王五')
preForm.append('lesson_id', String(lesson.body.id))
preForm.append('class_id', String(cls.body.id))
preForm.append('device_id', 'OTHER-DEVICE-XXX')
preForm.append('file', new File([Buffer.from('other')], 'other.txt', { type: 'text/plain' }))
const pre = await j('/api/student/submissions', { method: 'POST', body: preForm })
console.log(`已由其他设备「王五」提交一条（#${pre.body?.submission?.id}）\n`)

// 准备本地文件
const dir = join(tmpdir(), `dlg-${stamp}`)
mkdirSync(dir, { recursive: true })
const imgPath = join(dir, '我的图片.png')
writeFileSync(imgPath, makePng(120, 90, [220, 80, 80]))
const txtPath = join(dir, '说明文档.txt')
writeFileSync(txtPath, '这是用于本地预览验证的文本内容。\n第二行：选中后应立即显示。\n')

// CDP
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
const consoleErrors = []
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text)
})

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
  if (!found.nodeId) throw new Error(`未找到文件输入：${selector}`)
  await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: paths })
}

console.log(`目标服务：${BASE}\n`)

try {
  console.log('[1] 打开课程页与上传弹窗')
  await send('Page.navigate', { url: `${BASE}/student/courses/${course.body.id}` })
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((b) => b.innerText.includes('提交作业'))`,
    '提交作业按钮',
  )
  await clickByText('button', '提交作业')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '上传弹窗')
  await new Promise((r) => setTimeout(r, 1500))
  check('上传弹窗已打开', true)

  console.log('\n[2] 检查提示语语义')
  const dialogText = await evaluate(`document.querySelector('.el-dialog')?.innerText ?? ''`)
  // 本设备尚未提交，因此不应出现「当前设备已提交」的警告
  const alertEl = await evaluate(`document.querySelector('.submit-form__alert')?.innerText ?? ''`)
  check('本设备未提交时不显示设备警告', alertEl === '', alertEl.slice(0, 100))
  check('提示语不指名其他同学', !dialogText.includes('王五'), '弹窗中不应出现其他学生姓名')
  check('提示语不暴露最早提交时间', !/最早由/.test(dialogText), '不应出现「最早由」')
  check('显示本班已有份数（不含姓名）', /本班已有\s*\d+\s*份提交/.test(dialogText), '')

  console.log('\n[3] 选择文件后应立即出现预览')
  await setFiles('.el-dialog input[type=file]', [imgPath, txtPath])
  await new Promise((r) => setTimeout(r, 1200))

  const hasPreviewBlock = await evaluate(`document.querySelector('.local-preview') !== null`)
  check('出现本地预览区', hasPreviewBlock === true)

  const tabCount = await evaluate(`document.querySelectorAll('.local-preview__tab').length`)
  check('预览切换条有 2 个文件', tabCount === 2, `tabs=${tabCount}`)

  const imgShown = await evaluate(`document.querySelectorAll('.local-preview__image').length`)
  check('图片立即内嵌渲染', imgShown === 1, `imgs=${imgShown}`)

  const imgSrc = await evaluate(`document.querySelector('.local-preview__image')?.src ?? ''`)
  check('图片使用本地 object URL', imgSrc.startsWith('blob:'), imgSrc.slice(0, 40))

  // 图片是否真实加载（naturalWidth > 0）
  const imgLoaded = await evaluate(
    `(() => { const el = document.querySelector('.local-preview__image'); return el ? el.naturalWidth > 0 : false })()`,
  )
  check('图片已成功解码加载', imgLoaded === true)

  const labelText = await evaluate(`document.querySelector('.local-preview')?.innerText ?? ''`)
  check('显示文件合计信息', /共 2 个文件/.test(labelText), '')
  check('显示文件大小', /\d+(\.\d+)?\s*(B|KB|MB)/.test(labelText), '')

  console.log('\n[4] 切换到文本文件，应显示文本内容')
  await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('.local-preview__tab'))
    const txt = tabs.find((t) => t.innerText.includes('.txt'))
    if (txt) txt.click()
  })()`)
  await new Promise((r) => setTimeout(r, 900))

  const textShown = await evaluate(`document.querySelectorAll('.local-preview__text').length`)
  check('文本文件显示文本预览', textShown === 1, `blocks=${textShown}`)

  const textContent = await evaluate(`document.querySelector('.local-preview__text')?.innerText ?? ''`)
  check('文本内容正确读取', textContent.includes('本地预览验证'), textContent.slice(0, 60))

  console.log('\n[5] 移除文件后预览应同步更新')
  await clickByText('.local-preview__actions button', '移除')
  await new Promise((r) => setTimeout(r, 800))
  const afterRemove = await evaluate(`document.querySelectorAll('.local-preview__tab').length`)
  check('移除后只剩 1 个文件', afterRemove === 1, `tabs=${afterRemove}`)

  console.log('\n[6] 提交后用同一设备再次打开，应出现设备警告')
  await evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('.el-dialog input'))
    const target = inputs.find((i) => (i.placeholder || '').includes('姓名'))
    if (target) {
      target.value = '赵六'
      target.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })()`)
  await setFiles('.el-dialog input[type=file]', [imgPath])
  await new Promise((r) => setTimeout(r, 600))
  await clickByText('.el-dialog__footer button', '确认提交')
  await waitFor(
    `Array.from(document.querySelectorAll('.el-dialog__title')).some((t) => t.innerText.includes('作业已提交'))`,
    '提交成功',
    25000,
  )
  check('提交成功', true)
  await clickByText('.el-dialog__footer button', '完成')
  await new Promise((r) => setTimeout(r, 800))

  // 再次打开
  await clickByText('button', '提交作业')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '再次打开弹窗')
  await new Promise((r) => setTimeout(r, 1600))

  const alert2 = await evaluate(`document.querySelector('.submit-form__alert')?.innerText ?? ''`)
  check('再次打开出现设备警告', alert2.includes('当前设备已提交'), alert2.slice(0, 120))
  check('警告中说明具体时间', /\d{4}-\d{2}-\d{2}/.test(alert2), alert2.slice(0, 160))
  check('警告含提交人姓名（自己的）', alert2.includes('赵六'), alert2.slice(0, 160))

  console.log('\n[7] 控制台错误检查')
  check('无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} finally {
  socket.close()
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
}

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
}
