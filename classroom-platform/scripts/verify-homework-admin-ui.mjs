/**
 * 教师端「作业提交」页面的真实浏览器验证。
 *
 * 前置：先由 verify-homework-submission.mjs 或 verify-homework-ui.mjs 产生提交数据。
 *
 * 用法：node scripts/verify-homework-admin-ui.mjs [baseUrl] [cdpEndpoint]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8090'
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

// 获取令牌
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const { token } = await loginRes.json()
if (!token) {
  console.error('登录失败')
  process.exit(2)
}

// 确认至少有 1 条提交记录，否则页面无内容可校验
const listRes = await fetch(`${BASE}/api/admin/submissions?limit=5`, {
  headers: { Authorization: `Bearer ${token}` },
})
const listBody = await listRes.json()
if ((listBody.total ?? 0) === 0) {
  console.error('当前没有提交记录，请先运行 verify-homework-submission.mjs')
  process.exit(2)
}
console.log(`库中已有 ${listBody.total} 条提交记录（最多取 5 条校验）\n`)

// CDP
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
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const handler = pending.get(message.id)
    if (handler) {
      pending.delete(message.id)
      message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result)
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

const consoleErrors = []
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    consoleErrors.push(message.params.entry.text)
  }
})

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(`求值失败：${result.exceptionDetails.text}`)
  }
  return result.result.value
}

async function waitFor(expression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`等待超时：${label}`)
}

async function clickByText(selector, text) {
  const clicked = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
    const node = nodes.find((n) => (n.innerText || n.textContent || '').includes(${JSON.stringify(text)}))
    if (!node) return false
    node.scrollIntoView({ block: 'center' })
    node.click()
    return true
  })()`)
  if (!clicked) throw new Error(`未找到可点击元素：${selector} / ${text}`)
}

console.log(`目标服务：${BASE}\n`)

try {
  console.log('[1] 注入登录令牌并打开作业提交页')
  await send('Page.navigate', { url: `${BASE}/admin/submissions` })
  // 先注入令牌再重新加载，避免被登录守卫拦回
  await new Promise((r) => setTimeout(r, 800))
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('classroom.token', ${JSON.stringify(token)})`,
  })
  await send('Page.navigate', { url: `${BASE}/admin/submissions` })
  await new Promise((r) => setTimeout(r, 1500))

  const url = await evaluate(`location.pathname`)
  check('已进入作业提交页（未被登录守卫拦截）', url === '/admin/submissions', url)

  await waitFor(`document.querySelector('.el-table') !== null`, '提交表格')
  check('页面渲染提交表格', true)

  const bodyText = await evaluate(`document.body.innerText`)
  check('标题包含「作业提交」', bodyText.includes('作业提交'), '')
  check('展示来源 IP 概念', bodyText.includes('IP'), '')
  check('展示重复提交概念', bodyText.includes('重复'), '')

  const rowCount = await evaluate(`document.querySelectorAll('.el-table__body tr').length`)
  check('表格有数据行', rowCount >= 1, `rows=${rowCount}`)

  console.log('\n[2] 打开提交详情')
  await clickByText('.el-table__body button', '查看')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '详情弹窗')
  check('详情弹窗已打开', true)

  await new Promise((r) => setTimeout(r, 1000))
  const dialogText = await evaluate(`document.querySelector('.el-dialog')?.innerText ?? ''`)
  check('详情展示提交人', dialogText.includes('姓名') || dialogText.includes('学生'), '')
  check('详情展示来源 IP', dialogText.includes('IP'), '')
  check('详情展示文件预览区域', dialogText.includes('预览'), '')

  const previewNodes = await evaluate(
    `document.querySelectorAll('.preview__image, .preview__video, .preview__frame, .preview__fallback, .preview__tab').length`,
  )
  check('预览组件已渲染', previewNodes >= 1, `nodes=${previewNodes}`)

  console.log('\n[3] 审核操作')
  const hasReviewButton = await evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('.el-dialog button'))
    return btns.some((b) => b.innerText.includes('标记'))
  })()`)
  check('详情提供审核按钮', hasReviewButton)

  if (hasReviewButton) {
    await clickByText('.el-dialog button', '已查看')
    await new Promise((r) => setTimeout(r, 1200))
    const afterReview = await evaluate(`document.querySelector('.el-dialog')?.innerText ?? ''`)
    check('审核后状态更新为已查看', afterReview.includes('已查看'), '')
  }

  console.log('\n[4] 导航入口')
  await send('Page.navigate', { url: `${BASE}/admin/console` })
  await new Promise((r) => setTimeout(r, 1500))
  const navText = await evaluate(`document.querySelector('.admin-sidebar')?.innerText ?? ''`)
  check('侧栏出现「作业提交」入口', navText.includes('作业提交'), navText.replace(/\s+/g, ' '))

  console.log('\n[5] 控制台错误检查')
  check('无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
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
