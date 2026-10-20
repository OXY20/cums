/**
 * 验证课程作业统计与名单管理界面。
 *
 * 用法：node scripts/verify-roster-ui.mjs [baseUrl] [cdpEndpoint]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'
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

async function j(path, options = {}) {
  const r = await fetch(`${BASE}${path}`, options)
  const text = await r.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: r.status, body }
}

// ---- 准备数据：一个班级、一门课两课时、名单、部分提交 ----
const login = await j('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const token = login.body.token
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const stamp = Date.now()
const className = `界面测试班-${stamp}`
const cls = await j('/api/classes', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ name: className }),
})
const classId = cls.body.id

const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: `界面测试课程-${stamp}`, description: '验证作业统计界面' }),
})
const courseId = course.body.id
await j(`/api/courses/${courseId}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ status: 'published' }),
})
const l1 = await j(`/api/courses/${courseId}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 1 课时 · 图文混排' }),
})
const l2 = await j(`/api/courses/${courseId}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 2 课时 · 表格制作' }),
})

// 5 人名单
await j(`/api/classes/${classId}/students/import`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    text: '20240101 张三\n20240102 李四\n20240103 王五\n20240104 赵六\n20240105 钱七',
  }),
})

// 课时 1：3 人交；课时 2：1 人交
async function submit(name, no, lessonId) {
  const form = new FormData()
  form.append('student_name', name)
  if (no) form.append('student_no', no)
  form.append('lesson_id', String(lessonId))
  form.append('class_id', String(classId))
  form.append('file', new File([Buffer.from('hw')], `${name}.txt`, { type: 'text/plain' }))
  return j('/api/student/submissions', { method: 'POST', body: form })
}
await submit('张三', '20240101', l1.body.id)
await submit('李四', '20240102', l1.body.id)
await submit('王五', '20240103', l1.body.id)
await submit('张三', '20240101', l2.body.id)

// ---- CDP ----
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
  const m = JSON.parse(event.data)
  if (m.id !== undefined) {
    const h = pending.get(m.id)
    if (h) {
      pending.delete(m.id)
      m.error ? h.reject(new Error(JSON.stringify(m.error))) : h.resolve(m.result)
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
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`求值失败：${r.exceptionDetails.text}`)
  return r.result.value
}
async function waitFor(expr, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expr)) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`等待超时：${label}`)
}
async function clickByText(selector, text) {
  const ok = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
    const node = nodes.find((n) => (n.innerText || n.textContent || '').includes(${JSON.stringify(text)}))
    if (!node) return false
    node.scrollIntoView({ block: 'center' })
    node.click()
    return true
  })()`)
  if (!ok) throw new Error(`未找到：${selector} / ${text}`)
}

try {
  // 注入令牌
  await send('Page.navigate', { url: `${BASE}/student` })
  await waitFor(`document.body !== null`, '首页')
  await evaluate(`localStorage.setItem('classroom.token', ${JSON.stringify(token)})`)

  // ---- 课程详情：作业统计标签页 ----
  console.log('[1] 课程详情「作业统计」标签页')
  await send('Page.navigate', { url: `${BASE}/admin/courses/${courseId}` })
  await waitFor(`document.querySelector('.el-tabs') !== null`, '标签页', 20000)

  const tabs = await evaluate(`(() => {
    return Array.from(document.querySelectorAll('.el-tabs__item')).map((t) => t.innerText.trim())
  })()`)
  check('出现「课时内容」标签', tabs.some((t) => t.includes('课时内容')), tabs.join('|'))
  check('出现「作业统计」标签', tabs.some((t) => t.includes('作业统计')), tabs.join('|'))

  await clickByText('.el-tabs__item', '作业统计')
  await waitFor(`document.querySelector('.hw') !== null`, '作业统计面板', 15000)
  check('作业统计面板渲染', true)

  // 班级选择的默认行为：这门课只用过一个班时自动选中，省掉无意义的手动选择。
  // 多个班时仍然不选，避免把跨班数据误读成某一个班。
  // Element Plus 2.9 的 el-select 不在 input.value 上暴露选中值，只能读面板文本。
  // 自动选中发生在第一次总览返回之后，因此要等面板稳定下来再断言。
  await waitFor(
    `document.querySelector('.hw__head')?.innerText.includes(${JSON.stringify(className)})`,
    '自动选中班级',
    15000,
  ).then(
    () => true,
    () => false,
  )
  const headText = await evaluate(`document.querySelector('.hw__head')?.innerText ?? ''`)
  check('单班课程自动选中该班', headText.includes(className), headText.replace(/\n/g, ' '))

  // 显式选择测试班级
  await evaluate(`(() => {
    const trigger = document.querySelector('.hw__head .el-select')
    if (trigger) trigger.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  // 精确匹配本次创建的班级名：库里有多个历史测试班级，用 includes 会选错
  const picked = await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.el-select-dropdown__item'))
    const target = items.find((i) => i.innerText.trim() === ${JSON.stringify(className)})
    if (!target) return false
    target.click()
    return true
  })()`)
  check('可以选择班级', picked === true)

  await new Promise((r) => setTimeout(r, 1800))

  const summaryText = await evaluate(`document.querySelector('.hw__summary')?.innerText ?? ''`)
  console.log(`  汇总：${summaryText.replace(/\n/g, ' ')}`)
  check('显示应缴份数', /应缴/.test(summaryText), summaryText)
  check('显示已交份数', /已交/.test(summaryText), summaryText)
  check('显示待补交份数', /待补交/.test(summaryText), summaryText)

  // 应缴 = 5 人 × 2 课时 = 10，已交 = 3 + 1 = 4，待补交 = 6
  check('应缴 10 份', summaryText.includes('10'), summaryText)
  check('已交 4 份', /已交\s*4/.test(summaryText.replace(/\n/g, ' ')), summaryText)
  check('待补交 6 份', /待补交\s*6/.test(summaryText.replace(/\n/g, ' ')), summaryText)

  const lessonRows = await evaluate(`document.querySelectorAll('.hw__lesson').length`)
  check('列出 2 个课时', lessonRows === 2, `count=${lessonRows}`)

  const lessonTexts = await evaluate(`(() => {
    return Array.from(document.querySelectorAll('.hw__lesson')).map((r) => r.innerText.replace(/\\n/g, ' '))
  })()`)
  console.log(`  课时行：${lessonTexts.join(' || ')}`)
  check('课时1 显示 3/5', lessonTexts[0].includes('3 / 5'), lessonTexts[0])
  check('课时1 显示 2 人未交', lessonTexts[0].includes('2 人未交'), lessonTexts[0])
  check('课时2 显示 1/5', lessonTexts[1].includes('1 / 5'), lessonTexts[1])
  check('课时2 显示 4 人未交', lessonTexts[1].includes('4 人未交'), lessonTexts[1])

  // ---- 课时明细 ----
  console.log('\n[2] 课时提交明细')
  await clickByText('.hw__lesson', '第 1 课时')
  await waitFor(`document.querySelector('.board__missing-list') !== null`, '未交名单', 15000)
  check('明细弹窗打开', true)

  const missingText = await evaluate(`document.querySelector('.board__missing-list')?.innerText ?? ''`)
  console.log(`  未交：${missingText.replace(/\n/g, '、')}`)
  check('未交名单含赵六', missingText.includes('赵六'), missingText)
  check('未交名单含钱七', missingText.includes('钱七'), missingText)
  check('未交名单不含已交的张三', !missingText.includes('张三'), missingText)
  check('未交名单带学号', /20240104/.test(missingText), missingText)

  const dialogText = await evaluate(`(() => {
    const dialogs = Array.from(document.querySelectorAll('.el-dialog'))
    const d = dialogs.find((x) => x.innerText.includes('未交'))
    return d ? d.innerText : ''
  })()`)
  check('明细显示已交分组', dialogText.includes('已交'), dialogText.slice(0, 100))
  check('明细显示名单人数', dialogText.includes('名单 5 人'), dialogText.slice(0, 120))
  check('明细含复制名单按钮', dialogText.includes('复制名单'), dialogText.slice(0, 150))

  // 已交表格内容
  const submittedNames = await evaluate(`(() => {
    const dialogs = Array.from(document.querySelectorAll('.el-dialog'))
    const d = dialogs.find((x) => x.innerText.includes('未交'))
    if (!d) return []
    return Array.from(d.querySelectorAll('.el-table__row')).map((r) => r.innerText.replace(/\\n/g, ' '))
  })()`)
  console.log(`  已交行：${submittedNames.join(' || ')}`)
  check('已交表格含张三', submittedNames.some((r) => r.includes('张三')), submittedNames.join('|'))
  check('已交表格含来源 IP', submittedNames.some((r) => r.includes('127.0.0.1')), submittedNames.join('|'))

  // 关闭弹窗
  await evaluate(`(() => {
    const dialogs = Array.from(document.querySelectorAll('.el-dialog'))
    const d = dialogs.find((x) => x.innerText.includes('未交'))
    if (!d) return false
    const btn = Array.from(d.querySelectorAll('button')).find((b) => b.innerText.includes('Close') || b.className.includes('close'))
    if (btn) { btn.click(); return true }
    const mask = document.querySelector('.el-overlay-dialog')
    if (mask) { mask.click(); return true }
    return false
  })()`)
  await new Promise((r) => setTimeout(r, 600))

  // ---- 名单管理页 ----
  console.log('\n[3] 学生名单管理页')
  await send('Page.navigate', { url: `${BASE}/admin/roster` })
  await waitFor(`document.querySelector('.roster') !== null`, '名单页', 20000)
  check('名单页渲染', true)

  await new Promise((r) => setTimeout(r, 1500))

  const rosterText = await evaluate(`document.querySelector('.roster')?.innerText ?? ''`)
  check('显示名单人数', /共 \d+ 人/.test(rosterText), rosterText.slice(0, 200))
  check('出现导入名单按钮', rosterText.includes('导入名单'), rosterText.slice(0, 200))

  // 切到测试班级，确认名单可见
  await evaluate(`(() => {
    const trigger = document.querySelector('.roster__head .el-select')
    if (trigger) trigger.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.el-select-dropdown__item'))
    const target = items.find((i) => i.innerText.trim() === ${JSON.stringify(className)})
    if (target) target.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 1500))

  const rows = await evaluate(`document.querySelectorAll('.el-table__row').length`)
  check('名单表格有数据', rows === 5, `rows=${rows}`)

  const rosterTable = await evaluate(`document.querySelector('.el-table')?.innerText ?? ''`)
  check('名单含张三', rosterTable.includes('张三'), rosterTable.slice(0, 200))
  check('名单含学号', rosterTable.includes('20240101'), rosterTable.slice(0, 200))

  // 侧栏入口（管理后台左侧导航，不是顶栏）
  const navText = await evaluate(`(() => {
    const navs = Array.from(document.querySelectorAll('nav'))
    const admin = navs.find((n) => n.className.includes('admin-nav') || n.closest('.admin-aside') || n.closest('aside'))
    if (admin) return admin.innerText
    return navs.map((n) => n.innerText).join('|')
  })()`)
  check('侧栏出现「学生名单」入口', navText.includes('学生名单'), navText.replace(/\n/g, '|'))

  // ---- 导入对话框 ----
  console.log('\n[4] 导入对话框')
  await clickByText('button', '导入名单')
  await waitFor(`document.querySelector('.import__input') !== null`, '导入对话框', 15000)
  check('导入对话框打开', true)

  const importTip = await evaluate(`document.querySelector('.import__tip')?.innerText ?? ''`)
  check('显示格式说明', importTip.includes('学号 姓名'), importTip.slice(0, 100))
  check('说明支持 Excel 粘贴', importTip.includes('Excel'), importTip.slice(0, 120))

  const hasReplace = await evaluate(`document.querySelector('.import__replace') !== null`)
  check('提供整班替换选项', hasReplace === true)

  // ---- 控制台 ----
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
