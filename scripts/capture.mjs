// 通过 CDP 对页面截图并保存为 PNG。
//
// 用法：node scripts/capture.mjs <url> <输出文件> [宽] [高]
// 说明：页面含 SSE 长连接时，Chrome 的 --virtual-time-budget 无法结束，
//       因此改用 CDP 显式等待并截图。

import { writeFileSync } from 'node:fs'

const url = process.argv[2]
const outFile = process.argv[3]
const width = Number(process.argv[4] ?? 1440)
const height = Number(process.argv[5] ?? 1000)
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

if (!url || !outFile) {
  console.error('用法：node scripts/capture.mjs <url> <输出文件> [宽] [高]')
  process.exit(2)
}

/** 打开新标签页并返回其 CDP 会话 */
async function openTarget(targetUrl) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' })
  if (!res.ok) throw new Error(`创建标签页失败：${res.status}`)
  return res.json()
}

async function closeTarget(id) {
  await fetch(`${CDP}/json/close/${id}`).catch(() => {})
}

/** 简易 CDP 客户端 */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', (event) => reject(new Error(`WebSocket 错误：${event.message ?? ''}`)))
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

// 固定视口，保证截图尺寸可复现
await client.send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
})

// 等待页面加载完成
const loaded = new Promise((resolve) => client.on('Page.loadEventFired', resolve))
await client.send('Page.navigate', { url })
await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 15000))])

// 可选：注入登录令牌，用于截取需要认证的教师端页面。
// 令牌通过环境变量 CAPTURE_TOKEN 传入，避免出现在命令行参数中。
//
// 注意顺序：直接访问受保护路由时，前端路由守卫会重定向到 /login，
// 因此必须先在同源页面写入令牌，再重新导航到目标地址。
const token = process.env.CAPTURE_TOKEN
if (token) {
  const origin = new URL(url).origin

  // 先落到同源空白页，取得可写入 localStorage 的上下文
  const primed = new Promise((resolve) => client.on('Page.loadEventFired', resolve))
  await client.send('Page.navigate', { url: `${origin}/login` })
  await Promise.race([primed, new Promise((resolve) => setTimeout(resolve, 15000))])

  await client.send('Runtime.evaluate', {
    expression: `localStorage.setItem('classroom.token', ${JSON.stringify(token)})`,
  })

  // 写入令牌后重新导航到真正的目标路由
  const reloaded = new Promise((resolve) => client.on('Page.loadEventFired', resolve))
  await client.send('Page.navigate', { url })
  await Promise.race([reloaded, new Promise((resolve) => setTimeout(resolve, 15000))])
}

// 等待前端异步数据渲染完成：轮询检查关键 DOM 是否出现
async function waitForContent(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { result } = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const app = document.querySelector('#app')
        if (!app) return 0
        const text = app.innerText || ''
        return text.trim().length
      })()`,
      returnByValue: true,
    })
    if (Number(result.value) > 40) return true
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

const rendered = await waitForContent()
if (!rendered) console.error('警告：页面内容可能未完全渲染')

// 额外稳定时间，等待字体与布局收敛
await new Promise((resolve) => setTimeout(resolve, 1200))

const { data } = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
writeFileSync(outFile, Buffer.from(data, 'base64'))
console.log(`已保存截图：${outFile}`)

client.close()
await closeTarget(target.id)
