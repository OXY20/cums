/**
 * 打开一个页面，打印 URL 与可见文本，用于排查页面渲染问题。
 *
 * 用法：node scripts/peek-page.mjs <url> [等待毫秒]
 */
const url = process.argv[2] ?? 'http://127.0.0.1:8080/student'
const waitMs = Number(process.argv[3] ?? 4000)
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

const target = await (
  await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
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
await new Promise((r) => setTimeout(r, waitMs))

const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    href: location.href,
    title: document.title,
    text: document.body ? document.body.innerText.slice(0, 1200) : '(no body)',
    cards: document.querySelectorAll('.card').length,
    tables: document.querySelectorAll('.el-table').length,
  })`,
  returnByValue: true,
})
console.log(JSON.stringify(JSON.parse(r.result.value), null, 2))

socket.close()
await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
