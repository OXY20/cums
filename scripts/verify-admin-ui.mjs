// 教师端界面验证：注入登录令牌后访问各管理页面，提取渲染文本与控制台错误。
//
// 用法：node scripts/verify-admin-ui.mjs [baseUrl]

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

// 先通过 API 获取令牌
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const { token } = await loginRes.json()
if (!token) {
  console.error('登录失败，无法获取令牌')
  process.exit(2)
}

// 学生端课程列表由数据决定，因此从接口取实际标题作为校验依据，
// 避免把某次演示数据写死进测试期望。
const publishedRes = await fetch(`${BASE}/api/student/courses`)
const published = (await publishedRes.json()).items ?? []
const expectedCourseTitles = published.slice(0, 3).map((c) => c.title)
console.log(`已发布课程 ${published.length} 门，将校验前 ${expectedCourseTitles.length} 门是否渲染\n`)

const pages = [
  { path: '/admin/console', name: '课堂控制台', expect: ['课堂控制台', '发布课堂'] },
  { path: '/admin/courses', name: '课程管理', expect: ['课程管理', '新建课程'] },
  { path: '/admin/resources', name: '资源库', expect: ['资源库', '将文件拖到此处'] },
  { path: '/admin/system', name: '系统状态', expect: ['系统状态', '审计日志'] },
  { path: '/student', name: '学生端首页', expect: ['全部课程', ...expectedCourseTitles] },
  { path: '/student/downloads', name: '下载中心', expect: ['下载中心'] },
]

let passed = 0
let failed = 0

for (const page of pages) {
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
        message.error
          ? handler.reject(new Error(JSON.stringify(message.error)))
          : handler.resolve(message.result)
      }
      return
    }
    const handlers = listeners.get(message.method)
    if (handlers) for (const h of handlers) h(message.params)
  })

  const send = (method, params = {}) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  const on = (method, handler) => {
    if (!listeners.has(method)) listeners.set(method, [])
    listeners.get(method).push(handler)
  }

  const errors = []
  await send('Page.enable')
  await send('Runtime.enable')
  on('Runtime.exceptionThrown', (params) => errors.push(params.exceptionDetails?.text ?? 'unknown'))
  on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      errors.push(params.args?.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })

  // 先访问同源页面以便写入 localStorage
  const loaded1 = new Promise((resolve) => on('Page.loadEventFired', resolve))
  await send('Page.navigate', { url: `${BASE}/student` })
  await Promise.race([loaded1, new Promise((resolve) => setTimeout(resolve, 10000))])

  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('classroom.token', ${JSON.stringify(token)})`,
  })

  // 再导航到目标页面
  const loaded2 = new Promise((resolve) => on('Page.loadEventFired', resolve))
  await send('Page.navigate', { url: `${BASE}${page.path}` })
  await Promise.race([loaded2, new Promise((resolve) => setTimeout(resolve, 10000))])
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const { result } = await send('Runtime.evaluate', {
    expression: `(document.querySelector('#app')?.innerText ?? '').trim()`,
    returnByValue: true,
  })
  const text = result.value ?? ''

  const missing = page.expect.filter((keyword) => !text.includes(keyword))
  const ok = missing.length === 0 && errors.length === 0

  if (ok) {
    passed += 1
    console.log(`PASS  ${page.name}（${page.path}）`)
  } else {
    failed += 1
    console.log(`FAIL  ${page.name}（${page.path}）`)
    if (missing.length > 0) console.log(`      缺少内容：${missing.join('、')}`)
    if (errors.length > 0) console.log(`      控制台错误：${errors.join(' | ')}`)
    console.log(`      实际文本：${text.slice(0, 200).replace(/\n/g, ' / ')}`)
  }

  socket.close()
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
}

console.log(`\n合计 ${passed + failed} 项：通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
