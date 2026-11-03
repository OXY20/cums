// 点击页面中的某个元素后再截图，用于验证交互后的界面。
//
// 用法：node scripts/click-capture.mjs <url> <输出文件> <选择器> [序号] [宽] [高]
// 说明：序号默认 0，表示第一个匹配元素；支持 -1 表示最后一个。
//
// 同样沿用 capture.mjs 的 CDP 客户端。页面含 SSE 长连接时不能靠虚拟时间预算，
// 因此显式等待元素出现并点击，再等渲染稳定后截图。

import { writeFileSync } from 'node:fs'

const url = process.argv[2]
const outFile = process.argv[3]
const selector = process.argv[4]
const index = Number(process.argv[5] ?? 0)
const width = Number(process.argv[6] ?? 1440)
const height = Number(process.argv[7] ?? 1200)
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

if (!url || !outFile || !selector) {
  console.error('用法：node scripts/click-capture.mjs <url> <输出文件> <选择器> [序号] [宽] [高]')
  process.exit(2)
}

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

// 可选：注入登录令牌后再导航，用于截取需要认证的教师端页面。
// 直接访问受保护路由会被路由守卫重定向，因此先落到同源页面写入令牌。
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

// 等待目标元素出现
async function waitForElement(selector, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { result } = await client.send('Runtime.evaluate', {
      expression: `document.querySelectorAll(${JSON.stringify(selector)}).length`,
      returnByValue: true,
    })
    if (Number(result.value) > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

const found = await waitForElement(selector)
if (!found) {
  console.error(`警告：未找到元素 ${selector}`)
}

// 点击（序号为 -1 时取最后一个）
const { result: clicked } = await client.send('Runtime.evaluate', {
  expression: `(() => {
    const nodes = document.querySelectorAll(${JSON.stringify(selector)})
    if (nodes.length === 0) return false
    const target = ${index} < 0 ? nodes[nodes.length + ${index}] : nodes[${index}]
    if (!target) return false
    target.click()
    return true
  })()`,
  returnByValue: true,
})
console.log(clicked.value ? `已点击 ${selector}[${index}]` : `点击失败：${selector}[${index}]`)

// 等待点击后的渲染与数据加载
await new Promise((resolve) => setTimeout(resolve, 2500))

const { data } = await client.send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
})
writeFileSync(outFile, Buffer.from(data, 'base64'))
console.log(`已保存截图：${outFile}`)

client.close()
await closeTarget(target.id)
