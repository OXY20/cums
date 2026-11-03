// 对指定页面注入带色方框与标签，用于前端界面调整沟通。
//
// 用法：node scripts/annotate-page.mjs <url> <输出文件> [宽] [高] [标注集]
// 说明：沿用 capture.mjs 的 CDP 客户端，直接在页面里画标注框并整页截图。
//
// 标注集默认取 frontend/src/annotations/student-course-detail.json；
// 第 5 个参数可以是标注集名（frontend/src/annotations 下的文件名），
// 也可以是任意 JSON 文件路径。
//
// AGENT-DECISION: 标注集与前端页面标注模式共用 frontend/src/annotations/*.json，
// 保证"页面上看到的"与"截图里画出的"是同一份定义。
// 页面上的实时标注请直接访问带 ?annotate= 参数的地址，或点顶栏的「标注」按钮。

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, resolve } from 'node:path'

const url = process.argv[2]
const outFile = process.argv[3]
const width = Number(process.argv[4] ?? 1440)
const height = Number(process.argv[5] ?? 1000)
const setArg = process.argv[6]
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

if (!url || !outFile) {
  console.error('用法：node scripts/annotate-page.mjs <url> <输出文件> [宽] [高] [标注集]')
  process.exit(2)
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const setDir = resolve(repoRoot, 'frontend/src/annotations')

/** 读取标注集：名称走 src/annotations 目录，路径直接读文件 */
function loadItems() {
  const fallback = resolve(setDir, 'student-course-detail.json')
  const target = !setArg
    ? fallback
    : setArg.endsWith('.json')
      ? resolve(repoRoot, setArg)
      : resolve(setDir, `${setArg}.json`)

  if (!target.endsWith('.json')) {
    throw new Error(`标注集必须是 JSON 文件：${target}`)
  }

  const parsed = JSON.parse(readFileSync(target, 'utf8'))
  const items = parsed.items ?? parsed
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`标注集为空：${target}`)
  }
  return { items, source: target }
}

const { items: ITEMS, source: SET_SOURCE } = loadItems()

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

/**
 * 在页面里画框与角标，并注入标注清单，返回标注清单。
 *
 * 与前端 AnnotationOverlay 保持同一套规则：
 * 角标只显示编号并贴在方框左上角外侧，说明文字放右下角清单面板，
 * 避免宽标签压住正文。
 */
const annotateScript = (items) => `
(() => {
  const items = ${JSON.stringify(items)}
  const layer = document.createElement('div')
  layer.id = '__annotate_layer__'
  // 截图模式下用文档坐标定位，配合 captureBeyondViewport 覆盖整页
  layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483000;'
  document.body.appendChild(layer)

  const summary = []
  for (const item of items) {
    let elements = []
    if (item.mark) {
      const marked = document.querySelector(item.mark)
      if (marked) elements = [marked]
    }
    if (elements.length === 0) {
      const found = Array.from(document.querySelectorAll(item.sel))
      elements = item.all ? found : found.slice(0, 1)
    }
    if (elements.length === 0) {
      summary.push({ tag: item.tag, note: item.note, color: item.color, count: 0 })
      continue
    }

    elements.forEach((el, index) => {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return

      const box = document.createElement('div')
      box.style.cssText = [
        'position:absolute',
        'box-sizing:border-box',
        'border:2px solid ' + item.color,
        'border-radius:4px',
        'background:' + item.color + '14',
      ].join(';')
      box.style.left = (rect.left + window.scrollX) + 'px'
      box.style.top = (rect.top + window.scrollY) + 'px'
      box.style.width = rect.width + 'px'
      box.style.height = rect.height + 'px'

      const label = document.createElement('div')
      label.textContent = elements.length > 1 ? item.tag + '.' + (index + 1) : item.tag
      label.title = item.note
      label.style.cssText = [
        'position:absolute',
        'left:-2px',
        'top:-2px',
        'transform:translateY(-100%)',
        'background:' + item.color,
        'color:#fff',
        'font:600 10px/14px "Segoe UI",sans-serif',
        'padding:0 4px',
        'border-radius:2px',
        'white-space:nowrap',
        'box-shadow:0 0 0 1px #fff',
      ].join(';')

      box.appendChild(label)
      layer.appendChild(box)
    })

    summary.push({ tag: item.tag, note: item.note, color: item.color, count: elements.length })
  }

  // 右下角清单面板：截图里直接对照编号与说明
  const panel = document.createElement('div')
  panel.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483100',
    'width:300px',
    'max-height:60vh',
    'overflow:auto',
    'background:#fff',
    'border:1px solid #e5e7eb',
    'border-radius:8px',
    'box-shadow:0 8px 24px rgba(15,23,42,.18)',
    'font:12px/1.6 "Segoe UI",sans-serif',
    'color:#1f2937',
  ].join(';')

  const head = document.createElement('div')
  head.textContent = '标注清单 ' + summary.length
  head.style.cssText = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;font-weight:600;'
  panel.appendChild(head)

  for (const item of summary) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 10px;'

    const tag = document.createElement('span')
    tag.textContent = item.tag
    tag.style.cssText = 'flex:none;min-width:30px;text-align:center;color:#fff;font-weight:600;border-radius:3px;padding:0 4px;line-height:18px;background:' + item.color

    const note = document.createElement('span')
    note.textContent = item.note
    note.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'

    const count = document.createElement('span')
    count.textContent = item.count === 0 ? '未找到' : item.count + ' 处'
    count.style.cssText = 'flex:none;color:' + (item.count === 0 ? '#e5484d' : '#6b7280')

    row.appendChild(tag)
    row.appendChild(note)
    row.appendChild(count)
    panel.appendChild(row)
  }
  document.body.appendChild(panel)

  return JSON.stringify(summary)
})()
`

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

// 等待前端异步数据渲染完成
async function waitForContent(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { result } = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const app = document.querySelector('#app')
        if (!app) return 0
        return (app.innerText || '').trim().length
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

await new Promise((resolve) => setTimeout(resolve, 1500))

const { result } = await client.send('Runtime.evaluate', {
  expression: annotateScript(ITEMS),
  returnByValue: true,
})

const summary = JSON.parse(result.value)
console.log(`标注集：${SET_SOURCE}`)
for (const item of summary) {
  const mark = item.count === 0 ? '（未找到元素）' : `（${item.count} 处）`
  console.log(`${item.tag.padEnd(4)} ${item.note} ${mark}`)
}

const { data } = await client.send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
})
writeFileSync(outFile, Buffer.from(data, 'base64'))
console.log(`已保存截图：${outFile}`)

client.close()
await closeTarget(target.id)
