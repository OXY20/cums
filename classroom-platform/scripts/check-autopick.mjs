/**
 * 检查课程详情「作业统计」面板的班级自动选中行为。
 *
 * 用法：node scripts/check-autopick.mjs <courseId>
 */
const BASE = process.argv[2] ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:8080'
const COURSE_ID = Number(process.argv[2])
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

const login = await (
  await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
).json()

const target = await (
  await fetch(`${CDP}/json/new?${encodeURIComponent(`${BASE}/student`)}`, { method: 'PUT' })
).json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.id !== undefined && pending.has(m.id)) {
    const h = pending.get(m.id)
    pending.delete(m.id)
    m.error ? h.reject(new Error(JSON.stringify(m.error))) : h.resolve(m.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

await send('Page.enable')
await send('Runtime.enable')
await new Promise((r) => setTimeout(r, 2000))

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  }
  return r.result.value
}

await evaluate(`localStorage.setItem('classroom.token', ${JSON.stringify(login.token)})`)
await send('Page.navigate', { url: `${BASE}/admin/courses/${COURSE_ID}` })
await new Promise((r) => setTimeout(r, 2500))

await evaluate(
  `Array.from(document.querySelectorAll('.el-tabs__item')).find((t) => t.innerText.includes('作业'))?.click()`,
)
await new Promise((r) => setTimeout(r, 2500))

const snapshot = await evaluate(`JSON.stringify({
  inputs: Array.from(document.querySelectorAll('.hw__head .el-select input')).map((i) => i.value),
  hint: document.querySelector('.hw__hint')?.innerText ?? null,
  head: document.querySelector('.hw__head')?.innerText ?? null,
  selected: document.querySelector('.hw__head .el-select__selected-item')?.innerText ?? null,
})`)
console.log(JSON.stringify(JSON.parse(snapshot), null, 2))

socket.close()
await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
