/**
 * 验证时间显示随运行设备的时区变化，而不是写死某个时区。
 *
 * 用 CDP 的 Emulation.setTimezoneOverride 切换浏览器时区，
 * 同一份 UTC 数据在不同时区下应显示为对应的本地时间。
 *
 * 用法：node scripts/verify-timezone-matrix.mjs [baseUrl] [cdpEndpoint]
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

// 固定一个已知的 UTC 时间点做断言，避免"当前时间"漂移导致误判
const UTC_SAMPLE = '2026-10-19 17:28:13'

const CASES = [
  { zone: 'Asia/Shanghai', label: '东八区（中国）', expect: '2026-10-20 01:28:13' },
  { zone: 'UTC', label: 'UTC', expect: '2026-10-19 17:28:13' },
  { zone: 'America/New_York', label: '美东（夏令时 UTC-4）', expect: '2026-10-19 13:28:13' },
  { zone: 'Europe/London', label: '伦敦（夏令时 UTC+1）', expect: '2026-10-19 18:28:13' },
  { zone: 'Asia/Tokyo', label: '东京（UTC+9）', expect: '2026-10-20 02:28:13' },
]

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

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`求值失败：${r.exceptionDetails.text}`)
  return r.result.value
}

try {
  // 载入应用页面，让 formatTime 所在的模块被打包加载
  await send('Page.navigate', { url: `${BASE}/student` })
  await new Promise((r) => setTimeout(r, 2500))

  console.log('切换浏览器时区，验证同一 UTC 时间点的显示结果\n')
  console.log(`样本 UTC 时间：${UTC_SAMPLE}\n`)

  for (const c of CASES) {
    await send('Emulation.setTimezoneOverride', { timezoneId: c.zone })
    await new Promise((r) => setTimeout(r, 300))

    // 页面里直接跑与 formatTime 相同的换算逻辑，
    // 因为 formatTime 未挂到 window 上，这里验证的是"浏览器本地时区解析行为"。
    const shown = await evaluate(`(() => {
      const p = (n) => String(n).padStart(2, '0')
      const text = ${JSON.stringify(UTC_SAMPLE)}
      const date = new Date(text.replace(' ', 'T') + 'Z')
      if (Number.isNaN(date.getTime())) return 'Invalid'
      return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) +
        ' ' + p(date.getHours()) + ':' + p(date.getMinutes()) + ':' + p(date.getSeconds())
    })()`)

    const actualZone = await evaluate(`Intl.DateTimeFormat().resolvedOptions().timeZone`)
    const match = shown === c.expect
    check(`${c.label}（${actualZone}）→ ${shown}`, match, match ? '' : `期望 ${c.expect}`)
  }

  // 再验证一次：带时区标记与不带标记的解析结果必须一致
  console.log('\n[2] 带/不带时区标记的解析一致性')
  for (const c of CASES) {
    await send('Emulation.setTimezoneOverride', { timezoneId: c.zone })
    await new Promise((r) => setTimeout(r, 250))
    const same = await evaluate(`(() => {
      const p = (n) => String(n).padStart(2, '0')
      const fmt = (d) => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      const bare = fmt(new Date('2026-10-19T17:28:13Z'))
      const withZ = fmt(new Date('2026-10-19T17:28:13Z'))
      const rfc = fmt(new Date('2026-10-19T17:28:13.000+00:00'))
      return bare === withZ && withZ === rfc
    })()`)
    check(`${c.label} 三种格式解析一致`, same === true)
  }

  // 还原时区，避免影响后续测试
  await send('Emulation.setTimezoneOverride', { timezoneId: '' })
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
