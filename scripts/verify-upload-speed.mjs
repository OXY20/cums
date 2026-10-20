/**
 * 验证上传时的速度与预计剩余时间显示。
 *
 * 用 CDP 拦截上传请求、按块延迟放行，制造可观测的传输速度，
 * 再检查界面上的 MB/s 与「预计还需」是否出现且数值合理。
 *
 * 用法：node scripts/verify-upload-speed.mjs [baseUrl] [cdpEndpoint]
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

// 准备课程
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
  body: JSON.stringify({ name: `速度测试班-${stamp}` }),
})
const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: `速度测试课程-${stamp}` }),
})
await j(`/api/courses/${course.body.id}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ status: 'published' }),
})
const lesson = await j(`/api/courses/${course.body.id}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 1 课时 · 上传速度验证' }),
})
const session = await j('/api/sessions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ class_id: cls.body.id, lesson_id: lesson.body.id }),
})
await j(`/api/sessions/${session.body.id}/start`, { method: 'POST', headers: H })

// 造一个 8 MB 文件，足够产生多次进度事件
const dir = join(tmpdir(), `speed-${stamp}`)
mkdirSync(dir, { recursive: true })
const bigPath = join(dir, '大文件.bin')
const SIZE_MB = 8
writeFileSync(bigPath, Buffer.alloc(SIZE_MB * 1024 * 1024, 0x41))
console.log(`已准备 ${SIZE_MB} MB 测试文件\n`)

// CDP 连接
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
await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
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
  await new Promise((r) => setTimeout(r, 1200))
  check('上传弹窗已打开', true)

  // 本地回环传输极快，8 MB 可能在 100ms 内传完，进度事件只有一两个，
  // 速度窗口来不及算出结果。用 CDP 把上传带宽限制到 2 MB/s，
  // 模拟真实机房的网络条件，才能观察到稳定的速度与倒计时。
  await send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 20,
    downloadThroughput: -1,
    uploadThroughput: 2 * 1024 * 1024,
  })
  console.log('  已把上传带宽限制为 2 MB/s（模拟机房网络）')

  console.log('\n[2] 选择大文件')
  await evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('.el-dialog input'))
    const t = inputs.find((i) => (i.placeholder || '').includes('姓名'))
    if (t) { t.value = '速度测试'; t.dispatchEvent(new Event('input', { bubbles: true })) }
  })()`)
  await setFiles('.el-dialog input[type=file]', [bigPath])
  await new Promise((r) => setTimeout(r, 1200))

  const selected = await evaluate(`document.querySelectorAll('.local-preview__tab').length`)
  check('已选择 1 个文件', selected === 1, `tabs=${selected}`)

  console.log('\n[3] 开始提交，观察速度与剩余时间')
  await clickByText('.el-dialog__footer button', '确认提交')

  // 等进度区出现
  await waitFor(`document.querySelector('.upload-progress') !== null`, '上传进度区', 15000)
  check('上传时出现进度区', true)

  const statsShown = await evaluate(`document.querySelector('.upload-progress__stats') !== null`)
  check('出现速度/剩余时间行', statsShown === true)

  // 采集若干次快照，确认数值在变化且格式正确
  const snapshots = []
  for (let i = 0; i < 60; i += 1) {
    const snap = await evaluate(`(() => {
      const stats = document.querySelector('.upload-progress__stats')
      if (!stats) return null
      const speed = stats.querySelector('.upload-progress__speed')?.innerText ?? ''
      const remaining = stats.querySelector('.upload-progress__remaining')?.innerText ?? ''
      const bytes = stats.querySelector('.upload-progress__bytes')?.innerText ?? ''
      const bar = document.querySelector('.upload-progress .el-progress-bar__inner')
      const width = bar ? bar.style.width : ''
      return { speed, remaining, bytes, width, text: stats.innerText }
    })()`)
    if (snap) snapshots.push(snap)
    await new Promise((r) => setTimeout(r, 250))
    // 上传结束后进度区会消失，提前退出
    if (snap === null) break
  }

  check('采集到进度快照', snapshots.length > 0, `count=${snapshots.length}`)

  const withSpeed = snapshots.filter((s) => /\d+\.\d+ MB\/s/.test(s.speed))
  check('速度以 MB/s 显示', withSpeed.length > 0, snapshots[0]?.speed ?? '无')

  const speedValues = withSpeed.map((s) => parseFloat(s.speed))
  const maxSpeed = Math.max(...speedValues, 0)
  check('速度数值为正', maxSpeed > 0, `max=${maxSpeed}`)
  check('速度未明显超过限制带宽', maxSpeed < 20, `max=${maxSpeed} MB/s`)

  const withRemaining = snapshots.filter((s) => /预计还需\s*(约|即将)/.test(s.remaining))
  check('显示预计剩余时间', withRemaining.length > 0, snapshots[0]?.remaining ?? '无')

  const remainingSamples = withRemaining.map((s) => s.remaining)
  const hasSeconds = remainingSamples.some((t) => /约 \d+ 秒/.test(t))
  const hasMinutes = remainingSamples.some((t) => /约 \d+ 分/.test(t))
  const finishing = remainingSamples.some((t) => t.includes('即将完成'))
  check('剩余时间显示为秒/分或即将完成', hasSeconds || hasMinutes || finishing,
    remainingSamples.slice(0, 3).join(' | '))

  const withBytes = snapshots.filter((s) => /\d+(\.\d+)? (B|KB|MB) \/ \d+(\.\d+)? (B|KB|MB)/.test(s.bytes))
  check('显示已传/总量', withBytes.length > 0, snapshots[0]?.bytes ?? '无')

  // 速度应当随进度变化，而不是一个固定值
  const distinctSpeeds = new Set(withSpeed.map((s) => s.speed))
  check('速度数值随进度变化', distinctSpeeds.size >= 2, `distinct=${distinctSpeeds.size}: ${[...distinctSpeeds].slice(0, 4).join(',')}`)

  // 剩余时间应当随进度递减
  const remainingNumbers = withRemaining
    .map((s) => {
      const m = s.remaining.match(/约 (\d+) 分 (\d+) 秒/) || s.remaining.match(/约 (\d+) 秒/)
      if (!m) return null
      return m.length === 3 ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1])
    })
    .filter((n) => n !== null)
  const isDescending = remainingNumbers.length >= 2 &&
    remainingNumbers[remainingNumbers.length - 1] <= remainingNumbers[0]
  check('剩余时间随进度递减', remainingNumbers.length < 2 || isDescending,
    remainingNumbers.slice(0, 6).join(' → '))

  console.log('\n[4] 等待提交完成')
  await waitFor(
    `Array.from(document.querySelectorAll('.el-dialog__title')).some((t) => t.innerText.includes('作业已提交'))`,
    '提交成功',
    120000,
  )
  check('大文件提交成功', true)

  const resultText = await evaluate(`(() => {
    const dialogs = Array.from(document.querySelectorAll('.el-dialog'))
    const last = dialogs[dialogs.length - 1]
    return last ? last.innerText : ''
  })()`)
  check('预览窗口显示文件', resultText.includes('大文件.bin'), resultText.slice(0, 80))

  console.log('\n[5] 控制台错误检查')
  check('无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  console.log('\n采样到的速度/剩余时间：')
  for (const s of snapshots.slice(0, 6)) {
    console.log(`  ${s.speed.padEnd(12)} | ${s.remaining.padEnd(18)} | ${s.bytes}`)
  }
} finally {
  socket.close()
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
}
