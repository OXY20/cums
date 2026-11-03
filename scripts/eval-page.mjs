// 在页面中执行一段表达式并打印结果，用于前端行为验证。
//
// 用法：node scripts/eval-page.mjs <url> <表达式文件或内联表达式> [宽] [高]
// 说明：表达式可以是文件路径（.js/.json）或直接给出的表达式文本。
// 页面需已通过 CAPTURE_TOKEN 注入登录令牌后再执行。

import { readFileSync } from 'node:fs'

const url = process.argv[2]
const source = process.argv[3]
const width = Number(process.argv[4] ?? 1440)
const height = Number(process.argv[5] ?? 1200)
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

if (!url || !source) {
  console.error('用法：node scripts/eval-page.mjs <url> <表达式文件或表达式> [宽] [高]')
  process.exit(2)
}

const expression = source.endsWith('.js') || source.endsWith('.json')
  ? readFileSync(source, 'utf8')
  : source

async function openTarget(targetUrl) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' })
  if (!res.ok) throw new Error(`创建标签页失败：${res.status}`)
  return res.json()
}

async function closeTarget(id) {
  await fetch(`${CDP}/json/close/${id}`).catch(() => {})
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', (event) =>
      reject(new Error(`WebSocket 错误：${event.message ?? ''}`)),
    )
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const handler = pending.get(message.id)
      if (handler) {
        pending.delete(message.id)
        if (message.error) handler.reject(new Error(JSON.stringify(message.error)))
        else handler.resolve(message.result)
      }
      return
    }
    const handlers = listeners.get(message.method)
    if (handlers) for (const handler of handlers) handler(message.params)
  })

  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, [])
      listeners.get(method).push(handler)
    },
    close() {
      socket.close()
    },
  }
}

const target = await openTarget('about:blank')
const client = connect(target.webSocketDebuggerUrl)
await client.ready

await client.send('Page.enable')
await client.send('Runtime.enable')

await client.send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
})

const loaded = new Promise((resolve) => client.on('Page.loadEventFired', resolve))
await client.send('Page.navigate', { url })
await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 15000))])

const token = process.env.CAPTURE_TOKEN
if (token) {
  const origin = new URL(url).origin

  const primed = new Promise((resolve) => client.on('Page.loadEventFired', resolve))
  await client.send('Page.navigate', { url: `${origin}/login` })
  await Promise.race([primed, new Promise((resolve) => setTimeout(resolve, 15000))])

  await client.send('Runtime.evaluate', {
    expression: `localStorage.setItem('classroom.token', ${JSON.stringify(token)})`,
  })

  const reloaded = new Promise((resolve) => client.on('Page.loadEventFired', resolve))
  await client.send('Page.navigate', { url })
  await Promise.race([reloaded, new Promise((resolve) => setTimeout(resolve, 15000))])
}

// 等待页面渲染
await new Promise((resolve) => setTimeout(resolve, 2500))

const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true,
})

if (exceptionDetails) {
  console.error('执行出错：', JSON.stringify(exceptionDetails, null, 2))
} else {
  console.log(typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2))
}

client.close()
await closeTarget(target.id)
