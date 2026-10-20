/**
 * 验证课时作业批改界面（真实浏览器 + CDP）。
 *
 * 覆盖：
 * 1. 从课程作业统计进入批改页（带班级参数）
 * 2. 统计卡片数字
 * 3. 列表按提交展开、行内打标签
 * 4. 多选 + 批量打标签
 * 5. 标签筛选与搜索
 * 6. 详情抽屉：文件预览、打分、评语
 * 7. 提交记录页的标签列与筛选
 *
 * 用法：node scripts/verify-review-ui.mjs [baseUrl] [cdpEndpoint]
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

// ---- 准备数据 ----
const login = await j('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const token = login.body.token
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const stamp = Date.now()
const className = `批改界面班-${stamp}`
const cls = await j('/api/classes', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ name: className }),
})
const classId = cls.body.id

const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: `批改界面课程-${stamp}`, description: '验证批量批改界面' }),
})
const courseId = course.body.id
await j(`/api/courses/${courseId}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ status: 'published' }),
})
const lesson = await j(`/api/courses/${courseId}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 1 课时 · 批改演示' }),
})
const lessonId = lesson.body.id

await j(`/api/classes/${classId}/students/import`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    text: '20240101 张三\n20240102 李四\n20240103 王五\n20240104 赵六\n20240105 钱七',
  }),
})

async function submit(name, no) {
  const form = new FormData()
  form.append('student_name', name)
  if (no) form.append('student_no', no)
  form.append('lesson_id', String(lessonId))
  form.append('class_id', String(classId))
  form.append('file', new File([Buffer.from('homework content')], `${name}.txt`, { type: 'text/plain' }))
  return j('/api/student/submissions', { method: 'POST', body: form })
}

// 4 人提交，张三交两次 → 5 份
await submit('张三', '20240101')
await submit('李四', '20240102')
await submit('王五', '20240103')
await submit('赵六', '20240104')
await submit('张三', '20240101')

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
  width: 1600,
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
  if (r.exceptionDetails) {
    const d = r.exceptionDetails
    const detail = d.exception?.description ?? d.text ?? '未知错误'
    throw new Error(`求值失败：${detail}｜表达式：${expression.slice(0, 120)}`)
  }
  return r.result.value
}
async function waitFor(expr, label, timeoutMs = 20000) {
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

/** 关闭所有弹层（MessageBox / Message），避免遮住后续点击 */
async function closeAllDialogs() {
  for (let i = 0; i < 6; i += 1) {
    const closed = await evaluate(`(() => {
      const box = document.querySelector('.el-message-box__btns .el-button--primary')
      if (box) { box.click(); return 'box' }
      const mask = document.querySelector('.el-overlay-message-box')
      if (mask) { mask.style.display = 'none'; return 'mask' }
      return ''
    })()`)
    if (!closed) break
    await new Promise((r) => setTimeout(r, 400))
  }
  await evaluate(`document.querySelectorAll('.el-message').forEach((n) => n.remove())`)
}

try {
  // ---- 注入令牌并进入批改页 ----
  // 必须先真正导航到站点再写 localStorage：about:blank 的 origin 是 opaque，
  // 直接访问会抛 SecurityError。
  await send('Page.navigate', { url: `${BASE}/student` })
  await waitFor(
    `location.origin === ${JSON.stringify(new URL(BASE).origin)} && document.body !== null`,
    '站点首页',
  )
  await evaluate(`localStorage.setItem('classroom.token', ${JSON.stringify(token)})`)

  console.log('[1] 从课程详情进入批改页')
  await send('Page.navigate', { url: `${BASE}/admin/courses/${courseId}` })
  await waitFor(`document.querySelector('.el-tabs') !== null`, '课程详情', 25000)
  await clickByText('.el-tabs__item', '作业统计')
  await waitFor(`document.querySelector('.hw') !== null`, '作业统计面板')

  // 选择班级
  await evaluate(`document.querySelector('.hw__head .el-select').click()`)
  await new Promise((r) => setTimeout(r, 600))
  const picked = await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.el-select-dropdown__item'))
    const target = items.find((i) => i.innerText.trim() === ${JSON.stringify(className)})
    if (!target) return false
    target.click()
    return true
  })()`)
  check('可以选择班级', picked === true)
  await new Promise((r) => setTimeout(r, 1500))

  const hasReviewBtn = await evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('.hw__lesson-stats .el-button'))
    return btns.some((b) => (b.innerText || '').includes('批改'))
  })()`)
  check('课时行出现「批改」入口', hasReviewBtn === true)

  await clickByText('.hw__lesson-stats .el-button', '批改')
  await waitFor(`document.querySelector('.review__stats') !== null`, '批改页统计', 25000)
  check('进入批改页', true)

  const url = await evaluate(`location.pathname + location.search`)
  check('URL 指向课时批改页', url.includes(`/admin/lessons/${lessonId}/review`), url)
  check('URL 带上班级参数', url.includes(`class_id=${classId}`), url)

  // ---- 统计卡片 ----
  console.log('\n[2] 统计卡片')
  const statNums = await evaluate(`(() => {
    return Array.from(document.querySelectorAll('.review__stat')).map((n) => ({
      num: n.querySelector('.review__stat-num')?.innerText.trim() ?? '',
      label: n.querySelector('.review__stat-label')?.innerText.trim() ?? '',
    }))
  })()`)
  const statMap = Object.fromEntries(statNums.map((s) => [s.label, s.num]))
  console.log(`  统计：${statNums.map((s) => `${s.label}=${s.num}`).join(', ')}`)

  check('显示提交份数 5', statMap['提交份数'] === '5', JSON.stringify(statMap))
  check('显示待批改 5', statMap['待批改'] === '5', JSON.stringify(statMap))
  check('显示未交 1（钱七）', statMap['未交'] === '1', JSON.stringify(statMap))
  check('显示平均分占位', statMap['平均分'] === '—', JSON.stringify(statMap))
  check('统计含四类标签', ['好', '通过', '不通过', '其他'].every((k) => k in statMap),
    Object.keys(statMap).join(','))

  // ---- 列表结构 ----
  console.log('\n[3] 提交列表')
  const rowCount = await evaluate(`document.querySelectorAll('.el-table__body-wrapper tbody tr').length`)
  check('列表按提交展开 5 行（张三两次算两份）', rowCount === 5, `rows=${rowCount}`)

  const headers = await evaluate(`(() => {
    return Array.from(document.querySelectorAll('.el-table__header-wrapper th')).map((t) =>
      (t.innerText || '').trim())
  })()`)
  check('表头含姓名列', headers.some((h) => h.includes('姓名')), headers.join('|'))
  check('表头含分数列', headers.some((h) => h.includes('分数')), headers.join('|'))
  check('表头含标签列', headers.some((h) => h.includes('标签')), headers.join('|'))
  check('表头含来源 IP 列', headers.some((h) => h.includes('IP')), headers.join('|'))

  // ---- 行内打标签 ----
  console.log('\n[4] 行内打标签')
  const firstRowName = await evaluate(`(() => {
    const tr = document.querySelector('.el-table__body-wrapper tbody tr')
    return tr ? tr.querySelectorAll('td')[2]?.innerText.trim() : ''
  })()`)
  console.log(`  第一行学生：${firstRowName}`)

  // 点第一行的「好」标签
  const clickedGood = await evaluate(`(() => {
    const tr = document.querySelector('.el-table__body-wrapper tbody tr')
    if (!tr) return false
    const tag = Array.from(tr.querySelectorAll('.review__tag-btn')).find(
      (t) => (t.innerText || '').trim() === '好')
    if (!tag) return false
    tag.click()
    return true
  })()`)
  check('点击行内「好」标签', clickedGood === true)
  await new Promise((r) => setTimeout(r, 1500))

  const afterGood = await evaluate(`(() => {
    const tr = document.querySelector('.el-table__body-wrapper tbody tr')
    const tags = Array.from(tr.querySelectorAll('.review__tag-btn'))
    const active = tags.find((t) => t.classList.contains('el-tag--dark'))
    return active ? active.innerText.trim() : ''
  })()`)
  check('标签变为选中态「好」', afterGood === '好', afterGood)

  const statsAfter = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('.review__stat'))
    const find = (label) => nodes.find((n) => n.querySelector('.review__stat-label')?.innerText.trim() === label)
    return {
      good: find('好')?.querySelector('.review__stat-num')?.innerText.trim() ?? '',
      pending: find('待批改')?.querySelector('.review__stat-num')?.innerText.trim() ?? '',
    }
  })()`)
  check('统计「好」变为 1', statsAfter.good === '1', JSON.stringify(statsAfter))
  check('统计「待批改」降为 4', statsAfter.pending === '4', JSON.stringify(statsAfter))

  // 再点一次取消
  await evaluate(`(() => {
    const tr = document.querySelector('.el-table__body-wrapper tbody tr')
    const tag = Array.from(tr.querySelectorAll('.review__tag-btn')).find(
      (t) => (t.innerText || '').trim() === '好')
    tag?.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 1500))
  const afterCancel = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('.review__stat'))
    const good = nodes.find((n) => n.querySelector('.review__stat-label')?.innerText.trim() === '好')
    return good?.querySelector('.review__stat-num')?.innerText.trim() ?? ''
  })()`)
  check('再次点击取消标签', afterCancel === '0', afterCancel)

  // ---- 多选与批量打标签 ----
  console.log('\n[5] 多选与批量打标签')
  const selectAll = await evaluate(`(() => {
    const box = document.querySelector('.el-table__header-wrapper .el-checkbox')
    if (!box) return false
    box.click()
    return true
  })()`)
  check('可以全选', selectAll === true)
  await new Promise((r) => setTimeout(r, 500))

  const selectedText = await evaluate(`document.querySelector('.review__selected')?.innerText ?? ''`)
  check('显示已选 5 份', selectedText.includes('5'), selectedText)

  // 打开批量标签下拉
  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.review__bar-right .el-button')).find(
      (b) => (b.innerText || '').includes('批量打标签'))
    btn?.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 700))

  const dropdownItems = await evaluate(`(() => {
    return Array.from(document.querySelectorAll('.el-dropdown-menu__item')).map((i) =>
      (i.innerText || '').trim())
  })()`)
  check('下拉含四类标签', ['好', '通过', '不通过', '其他'].every((t) => dropdownItems.includes(t)),
    dropdownItems.join('|'))

  await evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('.el-dropdown-menu__item')).find(
      (i) => (i.innerText || '').trim() === '通过')
    item?.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 700))

  // 确认框
  const confirmText = await evaluate(`document.querySelector('.el-message-box__message')?.innerText ?? ''`)
  check('弹出批量确认框', confirmText.includes('5'), confirmText)
  await evaluate(`(() => {
    const btn = document.querySelector('.el-message-box__btns .el-button--primary')
    btn?.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 2000))
  await closeAllDialogs()

  const batchStats = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('.review__stat'))
    const find = (label) => nodes.find((n) => n.querySelector('.review__stat-label')?.innerText.trim() === label)
    return {
      pass: find('通过')?.querySelector('.review__stat-num')?.innerText.trim() ?? '',
      pending: find('待批改')?.querySelector('.review__stat-num')?.innerText.trim() ?? '',
    }
  })()`)
  check('批量后「通过」为 5', batchStats.pass === '5', JSON.stringify(batchStats))
  check('批量后待批改为 0', batchStats.pending === '0', JSON.stringify(batchStats))

  const clearedSelection = await evaluate(`document.querySelector('.review__selected') === null`)
  check('批量后自动清空勾选', clearedSelection === true)

  // ---- 标签筛选 ----
  console.log('\n[6] 标签筛选与搜索')
  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.review__bar-left .el-radio-button')).find(
      (b) => (b.innerText || '').includes('不通过'))
    btn?.querySelector('input')?.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 800))
  const failRows = await evaluate(`document.querySelectorAll('.el-table__body-wrapper tbody tr').length`)
  check('筛选「不通过」为 0 行', failRows === 0, `rows=${failRows}`)

  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.review__bar-left .el-radio-button')).find(
      (b) => (b.innerText || '').includes('全部'))
    btn?.querySelector('input')?.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 800))
  const allRows = await evaluate(`document.querySelectorAll('.el-table__body-wrapper tbody tr').length`)
  check('切回「全部」为 5 行', allRows === 5, `rows=${allRows}`)

  // 搜索
  await evaluate(`(() => {
    const input = document.querySelector('.review__bar-left .el-input__inner')
    if (!input) return false
    input.focus()
    input.value = '20240101'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 800))
  const searchRows = await evaluate(`document.querySelectorAll('.el-table__body-wrapper tbody tr').length`)
  check('按学号搜索命中张三的两份', searchRows === 2, `rows=${searchRows}`)

  await evaluate(`(() => {
    const input = document.querySelector('.review__bar-left .el-input__inner')
    if (!input) return false
    input.focus()
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 600))

  // ---- 详情抽屉 ----
  console.log('\n[7] 详情抽屉：预览、打分、评语')
  await evaluate(`(() => {
    const tr = document.querySelector('.el-table__body-wrapper tbody tr')
    const cell = tr.querySelectorAll('td')[2]
    cell?.click()
    return true
  })()`)
  await waitFor(`document.querySelector('.el-drawer') !== null`, '详情抽屉', 15000)
  check('打开详情抽屉', true)

  const drawerTitle = await evaluate(`document.querySelector('.el-drawer__title')?.innerText.trim() ?? ''`)
  check('抽屉标题为学生姓名', drawerTitle.length > 0, drawerTitle)

  const hasPreview = await evaluate(`document.querySelector('.el-drawer .preview') !== null`)
  check('抽屉内有文件预览区', hasPreview === true)

  const hasScoreInput = await evaluate(`document.querySelector('.el-drawer .el-input-number') !== null`)
  check('抽屉内有分数输入', hasScoreInput === true)

  const hasComment = await evaluate(`document.querySelector('.el-drawer textarea') !== null`)
  check('抽屉内有评语输入', hasComment === true)

  const drawerTags = await evaluate(`(() => {
    return Array.from(document.querySelectorAll('.el-drawer .detail__review-tags .el-tag')).map((t) =>
      (t.innerText || '').trim())
  })()`)
  check('抽屉内有四类标签按钮', ['好', '通过', '不通过', '其他'].every((t) => drawerTags.includes(t)),
    drawerTags.join('|'))

  // 打「不通过」
  await evaluate(`(() => {
    const tag = Array.from(document.querySelectorAll('.el-drawer .detail__review-tags .el-tag')).find(
      (t) => (t.innerText || '').trim() === '不通过')
    tag?.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 1800))

  // 填分数与评语
  await evaluate(`(() => {
    const input = document.querySelector('.el-drawer .el-input-number input')
    if (!input) return false
    input.focus()
    input.value = '58'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 400))
  await evaluate(`(() => {
    const ta = document.querySelector('.el-drawer textarea')
    if (!ta) return false
    ta.focus()
    ta.value = '缺少关键步骤，请补充后重新提交'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 400))

  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.el-drawer .el-button')).find(
      (b) => (b.innerText || '').includes('保存分数与评语'))
    btn?.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 2000))
  await closeAllDialogs()

  const afterDrawer = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('.review__stat'))
    const find = (label) => nodes.find((n) => n.querySelector('.review__stat-label')?.innerText.trim() === label)
    return {
      fail: find('不通过')?.querySelector('.review__stat-num')?.innerText.trim() ?? '',
      avg: find('平均分')?.querySelector('.review__stat-num')?.innerText.trim() ?? '',
    }
  })()`)
  check('统计「不通过」为 1', afterDrawer.fail === '1', JSON.stringify(afterDrawer))
  check('平均分显示 58', afterDrawer.avg === '58', JSON.stringify(afterDrawer))

  // 关闭抽屉
  await evaluate(`(() => {
    const close = document.querySelector('.el-drawer__close-btn')
    close?.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 800))

  // ---- 提交记录页 ----
  console.log('\n[8] 提交记录页的标签与筛选')
  await send('Page.navigate', { url: `${BASE}/admin/submissions` })
  await waitFor(`document.querySelector('.el-table__body-wrapper') !== null`, '提交记录页', 25000)

  const subHeaders = await evaluate(`(() => {
    return Array.from(document.querySelectorAll('.el-table__header-wrapper th')).map((t) =>
      (t.innerText || '').trim())
  })()`)
  check('表头含学号列', subHeaders.some((h) => h.includes('学号')), subHeaders.join('|'))
  check('表头含分数列', subHeaders.some((h) => h.includes('分数')), subHeaders.join('|'))
  check('表头含标签列', subHeaders.some((h) => h.includes('标签')), subHeaders.join('|'))

  const hasLabelFilter = await evaluate(`(() => {
    const labels = Array.from(document.querySelectorAll('.filter-bar__label')).map((n) => n.innerText.trim())
    return labels.some((l) => l.includes('审阅标签'))
  })()`)
  check('筛选栏含「审阅标签」', hasLabelFilter === true)

  const tagButtons = await evaluate(`(() => {
    const tr = document.querySelector('.el-table__body-wrapper tbody tr')
    if (!tr) return []
    return Array.from(tr.querySelectorAll('.tag-row__btn')).map((t) => (t.innerText || '').trim())
  })()`)
  check('列表行内有四类标签按钮',
    ['好', '通过', '不通过', '其他'].every((t) => tagButtons.includes(t)),
    tagButtons.join('|'))

  // ---- 控制台无错误 ----
  console.log('\n[9] 控制台')
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('favicon') && !e.includes('Failed to load resource'),
  )
  check('无 JavaScript 运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
} catch (err) {
  failed += 1
  failures.push(`脚本异常：${err.message}`)
  console.log(`  ✗ 脚本异常：${err.message}`)
} finally {
  // ---- 清理 ----
  console.log('\n[清理] 删除测试数据')
  await j(`/api/courses/${courseId}`, { method: 'DELETE', headers: H })
  await j(`/api/classes/${classId}`, { method: 'DELETE', headers: H })
  console.log('  已删除测试课程与班级')
  socket.close()
}

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
}
