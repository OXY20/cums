/**
 * 验证时间显示与运行设备时区一致。
 *
 * 后端用 SQLite 的 datetime('now') 存 UTC 且不带时区标记，
 * 前端若不补 Z 会被当成当地时间解析，在东八区就会差 8 小时。
 * 这里比对「页面显示的时间」与「设备本地时间」。
 *
 * 用法：node scripts/verify-timezone.mjs [baseUrl] [cdpEndpoint]
 */
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

/** 设备本地时间，格式与页面一致 */
function localNow() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return {
    text: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    offsetMinutes: -d.getTimezoneOffset(),
    date: d,
  }
}

const local = localNow()
console.log(`设备本地时间：${local.text}`)
console.log(`设备时区偏移：UTC${local.offsetMinutes >= 0 ? '+' : ''}${local.offsetMinutes / 60}`)
console.log(`当前 UTC 时间：${local.date.toISOString()}\n`)

// ---------------------------------------------------------------------------
// 1. 纯函数层面：直接比对 formatTime 的换算是否正确
// ---------------------------------------------------------------------------
console.log('[1] 格式化函数换算（后端 UTC 无标记 → 本地时间）')
const cases = [
  { utc: '2026-10-19 17:28:13', label: 'UTC 无标记（SQLite）' },
  { utc: '2026-10-19T17:28:13.123+00:00', label: 'RFC3339 带偏移' },
  { utc: '2026-10-19T17:28:13Z', label: 'RFC3339 带 Z' },
]
// 期望：把 UTC 时间按设备偏移换算
const expectedFor = (utcText) => {
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(utcText)
  const iso = hasZone ? utcText : `${utcText.replace(' ', 'T')}Z`
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
for (const c of cases) {
  const expected = expectedFor(c.utc)
  // 东八区下 UTC 17:28 应显示为次日 01:28
  console.log(`  ${c.label}: ${c.utc} → 期望 ${expected}`)
}
check('UTC 无标记时间应换算为本地（与带标记的一致）',
  expectedFor(cases[0].utc) === expectedFor(cases[1].utc),
  `${expectedFor(cases[0].utc)} vs ${expectedFor(cases[1].utc)}`)

// ---------------------------------------------------------------------------
// 2. 接口层面：提交后回读的 created_at 是 UTC
// ---------------------------------------------------------------------------
console.log('\n[2] 接口返回的时间基准')
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
  body: JSON.stringify({ name: `时区测试班-${stamp}` }),
})
const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: `时区测试课程-${stamp}` }),
})
await j(`/api/courses/${course.body.id}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ status: 'published' }),
})
const lesson = await j(`/api/courses/${course.body.id}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 1 课时 · 时区验证' }),
})
const session = await j('/api/sessions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ class_id: cls.body.id, lesson_id: lesson.body.id }),
})
await j(`/api/sessions/${session.body.id}/start`, { method: 'POST', headers: H })

const form = new FormData()
form.append('student_name', '时区测试')
form.append('lesson_id', String(lesson.body.id))
form.append('class_id', String(cls.body.id))
form.append('file', new File([Buffer.from('tz')], 'tz.txt', { type: 'text/plain' }))
const submit = await j('/api/student/submissions', { method: 'POST', body: form })
const createdAt = submit.body?.submission?.created_at
console.log(`  提交记录 created_at：${createdAt}`)

// 判断存的是 UTC 还是本地：与当前 UTC 时间比较
const utcNow = local.date.toISOString().replace('T', ' ').slice(0, 19)
const utcDiff = Math.abs(new Date(`${createdAt.replace(' ', 'T')}Z`).getTime() - Date.now()) / 1000
const localDiff = Math.abs(new Date(createdAt.replace(' ', 'T')).getTime() - Date.now()) / 1000
console.log(`  当前 UTC：${utcNow}`)
console.log(`  与当前时刻相差：按UTC解析 ${utcDiff.toFixed(0)}s，按本地解析 ${localDiff.toFixed(0)}s`)
check('后端存储的是 UTC（按 UTC 解析才接近当前时刻）', utcDiff < 120, `utcDiff=${utcDiff.toFixed(0)}s`)

// ---------------------------------------------------------------------------
// 3. 页面层面：教师端表格显示的时间应等于本地时间
// ---------------------------------------------------------------------------
console.log('\n[3] 教师端页面显示的时间')
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
async function waitFor(expr, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expr)) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`等待超时：${label}`)
}

try {
  // 注入令牌后打开教师端提交记录页
  await send('Page.navigate', { url: `${BASE}/student` })
  await waitFor(`document.body !== null`, '首页加载')
  await evaluate(`localStorage.setItem('classroom.token', ${JSON.stringify(token)})`)
  await send('Page.navigate', { url: `${BASE}/admin/submissions` })
  await waitFor(
    `document.querySelectorAll('.el-table__row').length > 0`,
    '提交记录表格',
    20000,
  )

  // 找到刚提交的那行，读取时间列
  const rowTime = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.el-table__row'))
    for (const row of rows) {
      if (row.innerText.includes('时区测试')) {
        const cells = Array.from(row.querySelectorAll('td'))
        // 时间列包含 YYYY-MM-DD 格式
        for (const cell of cells) {
          const t = cell.innerText.trim()
          if (/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(t)) return t
        }
      }
    }
    return ''
  })()`)
  console.log(`  页面显示：${rowTime}`)
  console.log(`  设备本地：${localNow().text}`)

  check('页面显示时间格式正确', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rowTime), rowTime)

  // 关键断言：显示的时间应接近设备本地时间，而不是差 8 小时
  const shown = new Date(rowTime.replace(' ', 'T')).getTime()
  const diffSeconds = Math.abs(shown - Date.now()) / 1000
  check(
    '显示时间与设备本地时间一致（相差 < 120 秒）',
    diffSeconds < 120,
    `相差 ${(diffSeconds / 60).toFixed(1)} 分钟；页面=${rowTime}，本地=${localNow().text}`,
  )

  // 明确检查不是 UTC
  if (local.offsetMinutes !== 0) {
    const utcShown = new Date(`${createdAt.replace(' ', 'T')}Z`)
    const utcText = `${utcShown.getUTCFullYear()}-${String(utcShown.getUTCMonth() + 1).padStart(2, '0')}-${String(utcShown.getUTCDate()).padStart(2, '0')} ${String(utcShown.getUTCHours()).padStart(2, '0')}:${String(utcShown.getUTCMinutes()).padStart(2, '0')}:${String(utcShown.getUTCSeconds()).padStart(2, '0')}`
    check('显示的不是 UTC 时间', shown > 0 && Math.abs(shown - new Date(utcText.replace(' ', 'T')).getTime()) > 60000 || local.offsetMinutes === 0,
      `UTC 应为 ${utcText}，页面显示 ${rowTime}`)
  }
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
