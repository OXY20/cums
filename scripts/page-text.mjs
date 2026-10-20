// 提取页面渲染后的可见文本，用于验证前端数据绑定是否正确。
//
// 用法：node scripts/page-text.mjs <url> [选择器]

const url = process.argv[2]
const selector = process.argv[3] ?? '#app'
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

if (!url) {
  console.error('用法：node scripts/page-text.mjs <url> [选择器]')
  process.exit(2)
}

const res = await fetch(`${CDP}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
const target = await res.json()

const socket = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const listeners = new Map()

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
    return
  }
  const handlers = listeners.get(message.method)
  if (handlers) for (const h of handlers) h(message.params)
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

function on(method, handler) {
  if (!listeners.has(method)) listeners.set(method, [])
  listeners.get(method).push(handler)
}

const errors = []
await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')

on('Runtime.exceptionThrown', (params) => {
  errors.push(params.exceptionDetails?.text ?? 'unknown')
})
on('Log.entryAdded', (params) => {
  if (params.entry.level === 'error') errors.push(params.entry.text)
})

const loaded = new Promise((resolve) => on('Page.loadEventFired', resolve))
await send('Page.navigate', { url })
await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 15000))])

// 等待异步数据渲染
await new Promise((resolve) => setTimeout(resolve, 3500))

const { result } = await send('Runtime.evaluate', {
  expression: `(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    return node ? (node.innerText || '').trim() : '__NOT_FOUND__'
  })()`,
  returnByValue: true,
})

console.log('=== 页面文本 ===')
console.log(result.value)
console.log('=== 控制台错误 ===')
console.log(errors.length === 0 ? '（无）' : errors.join('\n'))

socket.close()
await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
