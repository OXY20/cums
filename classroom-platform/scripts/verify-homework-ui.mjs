/**
 * 学生端作业上传流程的真实浏览器验证。
 *
 * 通过 CDP 驱动无头标签页，真实点击「提交作业」→ 填写姓名 → 选择文件 →
 * 确认提交 → 检查预览弹窗，验证：
 * - 按钮出现在课程页课时区域
 * - 弹窗可打开、重复提交提醒会出现
 * - 多文件选择、进度、提交成功
 * - 成功后预览弹窗展示文件与来源 IP
 *
 * 用法：node scripts/verify-homework-ui.mjs [baseUrl] [cdpEndpoint]
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

// ---------------------------------------------------------------------------
// 准备测试数据（通过 API）
// ---------------------------------------------------------------------------

async function apiJson(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const login = await apiJson('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const token = login.body?.token
if (!token) {
  console.error('登录失败，无法继续')
  process.exit(2)
}
const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const stamp = Date.now()
const classRes = await apiJson('/api/classes', {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ name: `UI测试班-${stamp}`, room_name: '机房 B' }),
})
const classId = classRes.body?.id

const courseRes = await apiJson('/api/courses', {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ title: `UI测试课程-${stamp}`, description: '作业上传界面验证' }),
})
const courseId = courseRes.body?.id

const lessonRes = await apiJson(`/api/courses/${courseId}/lessons`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ title: '第 1 课时 · 上传界面验证' }),
})
const lessonId = lessonRes.body?.id

if (!classId || !courseId || !lessonId) {
  console.error('测试数据创建失败')
  process.exit(2)
}

// 发布课程，学生端才能看到
await apiJson(`/api/courses/${courseId}`, {
  method: 'PUT',
  headers: authHeaders,
  body: JSON.stringify({ status: 'published' }),
})

// 创建课堂，让学生端能确定班级
const sessionRes = await apiJson('/api/sessions', {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ class_id: classId, lesson_id: lessonId }),
})
if (sessionRes.body?.id) {
  await apiJson(`/api/sessions/${sessionRes.body.id}/start`, { method: 'POST', headers: authHeaders })
}

// 准备本地测试文件
const workDir = join(tmpdir(), `homework-ui-${stamp}`)
mkdirSync(workDir, { recursive: true })
const imagePath = join(workDir, '截图.png')
const docPath = join(workDir, '作业说明.txt')
writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
writeFileSync(docPath, '这是用于界面验证的作业文本文件。')

// ---------------------------------------------------------------------------
// CDP 会话
// ---------------------------------------------------------------------------

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
send('Page.enable')

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
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`求值失败：${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
  }
  return result.result.value
}

async function goto(url) {
  await send('Page.navigate', { url })
  // 等待应用挂载
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 250))
    const ready = await evaluate(`document.querySelector('.page, .card, #app') !== null`)
    if (ready) return
  }
  throw new Error(`页面未就绪：${url}`)
}

async function waitFor(expression, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`等待超时：${label}`)
}

async function setFiles(selector, paths) {
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true })
  const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
  if (!found.nodeId) throw new Error(`未找到文件输入：${selector}`)
  await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: paths })
}

/** 点击包含指定文本的元素 */
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

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

try {
  console.log('[1] 打开课程页并检查「提交作业」按钮')
  await goto(`${BASE}/student/courses/${courseId}`)
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((b) => b.innerText.includes('提交作业'))`,
    '提交作业按钮',
  )
  check('课程页出现「提交作业」按钮', true)

  const lessonTitleShown = await evaluate(`document.body.innerText.includes('上传界面验证')`)
  check('课程页渲染课时标题', lessonTitleShown)

  console.log('\n[2] 打开上传弹窗')
  await clickByText('button', '提交作业')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '上传弹窗')
  check('上传弹窗已打开', true)

  const dialogTitle = await evaluate(
    `document.querySelector('.el-dialog__header')?.innerText ?? ''`,
  )
  check('弹窗标题为「提交作业」', dialogTitle.includes('提交作业'), dialogTitle)

  // 首次提交应无重复提醒
  const hasAlertFirst = await evaluate(`document.querySelector('.el-alert') !== null`)
  check('首次提交无重复提醒', hasAlertFirst === false)

  console.log('\n[3] 填写姓名并选择多个文件')
  const nameInput = await evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('.el-dialog input'))
    const target = inputs.find((i) => (i.placeholder || '').includes('姓名'))
    if (!target) return false
    target.value = '赵六'
    target.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check('填写姓名输入框', nameInput === true)

  await setFiles('.el-dialog input[type=file]', [imagePath, docPath])
  await new Promise((r) => setTimeout(r, 400))

  const fileCount = await evaluate(
    `document.querySelectorAll('.submit-form__file').length`,
  )
  check('已选择 2 个文件', fileCount === 2, `count=${fileCount}`)

  const totalHint = await evaluate(
    `document.querySelector('.submit-form__total')?.innerText ?? ''`,
  )
  check('显示文件合计信息', totalHint.includes('2 个文件'), totalHint)

  console.log('\n[4] 提交并等待成功预览弹窗')
  await clickByText('.el-dialog__footer button', '确认提交')

  await waitFor(
    `Array.from(document.querySelectorAll('.el-dialog__title')).some((t) => t.innerText.includes('作业已提交'))`,
    '提交成功弹窗',
    20000,
  )
  check('提交成功后弹出预览窗口', true)

  const resultText = await evaluate(`document.body.innerText`)
  check('预览窗口展示提交人', resultText.includes('赵六'))
  check('预览窗口展示来源 IP', /来源 IP/.test(resultText))
  check('预览窗口展示文件预览区', resultText.includes('文件预览'))
  check('预览窗口展示状态标签', /已提交/.test(resultText))

  const previewImgs = await evaluate(`document.querySelectorAll('.preview__image').length`)
  check('图片文件内嵌渲染', previewImgs >= 1, `imgs=${previewImgs}`)

  const tabCount = await evaluate(`document.querySelectorAll('.preview__tab').length`)
  check('多文件切换条存在', tabCount === 2, `tabs=${tabCount}`)

  console.log('\n[5] 关闭预览，检查重复提交提醒')
  await clickByText('.el-dialog__footer button', '完成')
  await new Promise((r) => setTimeout(r, 500))

  await clickByText('button', '提交作业')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '再次打开弹窗')
  // 重复状态来自接口，等它返回
  await new Promise((r) => setTimeout(r, 1200))

  const duplicateAlert = await evaluate(`(() => {
    const alert = document.querySelector('.submit-form__alert')
    return alert ? alert.innerText : ''
  })()`)
  check('再次打开时出现重复提交提醒', duplicateAlert.includes('已有人提交'), duplicateAlert.slice(0, 120))

  console.log('\n[6] 同班同学再次提交，验证被标记')
  const nameInput2 = await evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('.el-dialog input'))
    const target = inputs.find((i) => (i.placeholder || '').includes('姓名'))
    if (!target) return false
    target.value = '孙七'
    target.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check('填写第二位学生姓名', nameInput2 === true)

  await setFiles('.el-dialog input[type=file]', [docPath])
  await new Promise((r) => setTimeout(r, 300))
  await clickByText('.el-dialog__footer button', '确认提交')

  await waitFor(
    `Array.from(document.querySelectorAll('.el-dialog__title')).some((t) => t.innerText.includes('作业已提交'))`,
    '第二次提交成功',
    20000,
  )
  const dupText = await evaluate(`document.body.innerText`)
  check('重复提交预览显示重复标记', dupText.includes('重复'), '')
  check('提示被重复的提交人', dupText.includes('赵六'), '')

  console.log('\n[7] 控制台错误检查')
  check('无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  // 清理临时文件
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* 忽略清理失败 */
  }
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
