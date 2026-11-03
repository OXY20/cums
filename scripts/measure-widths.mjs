// 测量各页面内容区的有效宽度，用于核对各页面宽度是否一致。

//
// 用法：node scripts/measure-widths.mjs [基础地址] [视口宽]
// 说明：需要先启动前端服务与带调试端口的 Chrome（--remote-debugging-port=9222）。
// 教师端页面会自动登录并注入令牌。


// 管理员凭据：安装向导创建后账号名与口令由使用者决定，
// 因此允许通过环境变量覆盖，默认保持与旧版一致。
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'admin'
const BASE = process.argv[2] ?? 'http://localhost:5174'
const VIEWPORT = Number(process.argv[3] ?? 1440)
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

/** 待测量的页面：学生端与教师端各页面 */
const ROUTES = [
  { path: '/login', name: '登录页' },
  { path: '/student', name: '学生端首页' },
  { path: '/student/courses/4', name: '学生端课程详情' },
  { path: '/student/sessions/6', name: '学生端课堂详情' },
  { path: '/student/downloads', name: '下载中心' },
  { path: '/admin/console', name: '课堂控制台' },
  { path: '/admin/courses', name: '课程管理' },
  { path: '/admin/courses/4', name: '课程详情（教师端）' },
  { path: '/admin/roster', name: '学生名单' },
  { path: '/admin/resources', name: '资源库' },
  { path: '/admin/submissions', name: '作业提交' },
  { path: '/admin/lessons/11/review', name: '作业批改' },
  { path: '/admin/system', name: '系统状态' },
]

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

/** 登录取令牌，供教师端页面使用 */
async function loginToken() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  })
  const body = await res.json()
  return body.token ?? null
}

/** 测量当前页面的内容容器 */
const MEASURE = `(() => {
  const candidates = ['.page', '.admin-content', '.login-page', '#app > div']
  let el = null
  let sel = ''
  for (const item of candidates) {
    const hit = document.querySelector(item)
    if (hit) { el = hit; sel = item; break }
  }
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const padLeft = parseFloat(cs.paddingLeft) || 0
  const padRight = parseFloat(cs.paddingRight) || 0
  return {
    sel,
    path: location.pathname,
    outer: Math.round(rect.width),
    content: Math.round(rect.width - padLeft - padRight),
    left: Math.round(rect.left),
    right: Math.round(window.innerWidth - rect.right),
    maxWidth: cs.maxWidth,
    padding: cs.padding,
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }
})()`

const token = await loginToken()

const target = await openTarget('about:blank')
const client = connect(target.webSocketDebuggerUrl)
await client.ready

await client.send('Page.enable')
await client.send('Runtime.enable')
await client.send('Emulation.setDeviceMetricsOverride', {
  width: VIEWPORT,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})

// 先落到同源页面写入令牌，避免教师端路由被守卫重定向
const primed = new Promise((resolve) => client.on('Page.loadEventFired', resolve))
await client.send('Page.navigate', { url: `${BASE}/login` })
await Promise.race([primed, new Promise((resolve) => setTimeout(resolve, 15000))])

if (token) {
  await client.send('Runtime.evaluate', {
    expression: `localStorage.setItem('classroom.token', ${JSON.stringify(token)})`,
  })
  const { result: stored } = await client.send('Runtime.evaluate', {
    expression: `localStorage.getItem('classroom.token') ? localStorage.getItem('classroom.token').length : 'null'`,
    returnByValue: true,
  })
  console.log(`令牌长度 ${token.length}，写入后 localStorage 长度 ${stored.value}`)
} else {
  console.error('警告：登录失败，未写入令牌')
}

/**
 * 写入令牌。
 *
 * 同源下多个工具共用同一个浏览器时，localStorage 可能被其它会话清掉，
 * 因此每次导航前都补写一次，保证受保护路由不会被打回登录页。
 */
async function writeToken() {
  if (!token) return
  await client.send('Runtime.evaluate', {
    expression: `localStorage.setItem('classroom.token', ${JSON.stringify(token)})`,
  })
}

const rows = []

for (const route of ROUTES) {
  // 先补写令牌，再导航到目标页
  await writeToken()
  const loaded = new Promise((resolve) => client.on('Page.loadEventFired', resolve))
  await client.send('Page.navigate', { url: `${BASE}${route.path}` })
  await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 15000))])
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const { result } = await client.send('Runtime.evaluate', {
    expression: MEASURE,
    returnByValue: true,
  })

  const measured = result.value
  if (!measured) {
    rows.push({ name: route.name, path: route.path, error: '未找到内容容器' })
    continue
  }
  rows.push({ name: route.name, path: route.path, ...measured })
}

console.log(`视口宽度：${VIEWPORT}px\n`)
console.log(
  ['页面', '实际路径', '容器', '外框', '内容宽', '左距', '右距', 'max-width', '横向溢出'].join('\t'),
)
for (const row of rows) {
  if (row.error) {
    console.log(`${row.name}\t${row.error}`)
    continue
  }
  const overflow = row.scrollWidth > row.viewport ? `是（${row.scrollWidth}px）` : '否'
  console.log(
    [
      row.name,
      row.path,
      row.sel,
      row.outer,
      row.content,
      row.left,
      row.right,
      row.maxWidth,
      overflow,
    ].join('\t'),
  )
}

// 汇总：内容宽是否一致
const widths = new Map()
for (const row of rows) {
  if (row.error) continue
  const list = widths.get(row.content) ?? []
  list.push(row.name)
  widths.set(row.content, list)
}
console.log('\n内容宽分组：')
for (const [width, names] of [...widths.entries()].sort((a, b) => b[0] - a[0])) {
  console.log(`  ${width}px → ${names.join('、')}`)
}

client.close()
await closeTarget(target.id)
