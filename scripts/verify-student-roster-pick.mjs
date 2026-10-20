/**
 * 验证学生端「从班级名单选择自己」的完整链路。
 *
 * 这条链路是把前面几个功能串起来的关键：
 * 教师导入名单 → 学生从名单选自己提交 → 教师端统计能对上是「已交」。
 *
 * 用法：node scripts/verify-student-roster-pick.mjs [baseUrl] [cdpEndpoint]
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

// ---- 准备：班级 + 名单 + 课程 + 活跃课堂 ----
const login = await j('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const token = login.body.token
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const stamp = Date.now()
const className = `选人测试班-${stamp}`
const cls = await j('/api/classes', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ name: className }),
})
const classId = cls.body.id

// 名单：4 人，含一个重名学生用于验证按学号区分
const roster = [
  ['20240201', '张三'],
  ['20240202', '李四'],
  ['20240203', '王五'],
  ['20240204', '张三'],
]
await j(`/api/classes/${classId}/students/import`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ text: roster.map((r) => r.join(' ')).join('\n') }),
})

const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: `选人测试课程-${stamp}` }),
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
  body: JSON.stringify({ title: '第 1 课时 · 选人验证' }),
})
const lessonId = lesson.body.id
const session = await j('/api/sessions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ class_id: classId, lesson_id: lessonId }),
})
await j(`/api/sessions/${session.body.id}/start`, { method: 'POST', headers: H })

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
async function setFiles(selector, paths) {
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true })
  const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
  await send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: paths })
}

/**
 * 关闭所有残留弹窗。
 *
 * 测试中会连续打开多个弹窗，若上一个没关掉，
 * 遮罩层会挡住「提交作业」按钮，导致后续点击无效。
 */
async function closeAllDialogs() {
  await evaluate(`(() => {
    const dialogs = Array.from(document.querySelectorAll('.el-dialog'))
    for (const d of dialogs) {
      const btn = Array.from(d.querySelectorAll('button')).find(
        (b) => b.innerText.includes('完成') || b.innerText.includes('取消') || b.innerText.includes('关闭'),
      )
      if (btn) btn.click()
    }
    return true
  })()`)
  // 等关闭动画结束
  await new Promise((r) => setTimeout(r, 900))
}

// 造一个测试文件
const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')
const workDir = join(tmpdir(), `pick-${stamp}`)
mkdirSync(workDir, { recursive: true })
const filePath = join(workDir, '作业.txt')
writeFileSync(filePath, '测试作业内容')

try {
  console.log('[1] 打开学生端上传弹窗')
  // 清掉上次测试记住的姓名与学号，保证从干净状态开始
  await send('Page.navigate', { url: `${BASE}/student` })
  await waitFor(`document.body !== null`, '首页')
  await evaluate(`(() => {
    localStorage.removeItem('classroom.student.name')
    localStorage.removeItem('classroom.student.no')
    localStorage.removeItem('classroom.device.id')
  })()`)

  await send('Page.navigate', { url: `${BASE}/student/courses/${courseId}` })
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((b) => b.innerText.includes('提交作业'))`,
    '提交作业按钮',
  )
  await clickByText('button', '提交作业')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '上传弹窗')
  await new Promise((r) => setTimeout(r, 1800))
  check('上传弹窗打开', true)

  console.log('\n[2] 有名单时应出现「选择姓名」下拉')
  const hasPick = await evaluate(`document.querySelector('.roster-pick__select') !== null`)
  check('出现名单选择下拉', hasPick === true)

  const hintText = await evaluate(`document.querySelector('.roster-pick__hint')?.innerText ?? ''`)
  check('显示「从班级名单中选择你自己」提示', hintText.includes('从班级名单'), hintText)

  // 展开下拉，确认名单内容
  await evaluate(`(() => {
    const t = document.querySelector('.roster-pick__select')
    if (t) t.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 700))

  const options = await evaluate(`(() => {
    return Array.from(document.querySelectorAll('.el-select-dropdown__item')).map((i) => i.innerText.trim())
  })()`)
  console.log(`  下拉选项：${options.join(' | ')}`)
  check('下拉列出 4 位学生', options.length === 4, `count=${options.length}`)
  check('选项含学号与姓名', options.some((o) => o.includes('20240201') && o.includes('张三')),
    options.join('|'))
  check('重名学生按学号区分（两条张三）',
    options.filter((o) => o.includes('张三')).length === 2, options.join('|'))

  console.log('\n[3] 选择学生后自动填入学号与姓名')
  // 选择学号 20240204 的那位张三（重名，靠学号区分）
  const picked = await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.el-select-dropdown__item'))
    const t = items.find((i) => i.innerText.includes('20240204'))
    if (!t) return false
    t.click()
    return true
  })()`)
  check('可以选中学生', picked === true)

  await new Promise((r) => setTimeout(r, 800))

  const pickedText = await evaluate(`document.querySelector('.roster-pick__picked')?.innerText ?? ''`)
  console.log(`  已选提示：${pickedText}`)
  check('显示已选学生', pickedText.includes('20240204') && pickedText.includes('张三'), pickedText)

  // 姓名与学号输入框应被自动填充。
  // 注意 placeholder 有子串重叠：姓名的含「也可直接修改」，学号的没有，
  // 因此学号要用「包含且不含姓名特征」来精确匹配，否则会取到姓名框。
  const filled = await evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('.el-dialog input'))
    const nameInput = inputs.find((i) => (i.placeholder || '').includes('也可直接修改'))
    const noInput = inputs.find((i) => {
      const p = i.placeholder || ''
      return p.includes('从名单选择后自动填入') && !p.includes('也可直接修改')
    })
    return {
      studentNo: noInput ? noInput.value : null,
      studentName: nameInput ? nameInput.value : null,
    }
  })()`)
  console.log(`  学号框="${filled.studentNo}"，姓名框="${filled.studentName}"`)
  check('学号自动填入', filled.studentNo === '20240204', `${filled.studentNo}`)
  check('姓名自动填入', filled.studentName === '张三', `${filled.studentName}`)

  console.log('\n[4] 选择文件并提交')
  await setFiles('.el-dialog input[type=file]', [filePath])
  await new Promise((r) => setTimeout(r, 1000))
  check('已选择文件', (await evaluate(`document.querySelectorAll('.local-preview__tab').length`)) === 1)

  await clickByText('.el-dialog__footer button', '确认提交')
  await waitFor(
    `Array.from(document.querySelectorAll('.el-dialog__title')).some((t) => t.innerText.includes('作业已提交'))`,
    '提交成功',
    30000,
  )
  check('提交成功', true)

  console.log('\n[5] 校验提交记录带上了学号')
  const subs = await j(`/api/admin/submissions?lesson_id=${lessonId}`, { headers: H })
  const mine = subs.body.items.find((s) => s.student_no === '20240204')
  check('提交记录保存了学号', mine !== undefined, JSON.stringify(subs.body.items.map((s) => s.student_no)))
  check('提交记录姓名为张三', mine?.student_name === '张三', mine?.student_name)
  check('提交记录关联到正确班级', mine?.class_id === classId, `class_id=${mine?.class_id}`)

  console.log('\n[6] 教师端统计应把该学生算作「已交」')
  const board = await j(`/api/lessons/${lessonId}/submission-board?class_id=${classId}`, {
    headers: H,
  })
  const submittedNos = board.body.submitted.map((s) => s.student_no)
  const missingNos = board.body.missing.map((s) => s.student_no)
  console.log(`  已交：${submittedNos.join(',')}　未交：${missingNos.join(',')}`)
  check('该学生出现在已交名单', submittedNos.includes('20240204'), submittedNos.join(','))
  check('该学生不在未交名单', !missingNos.includes('20240204'), missingNos.join(','))
  check('未交为其余 3 人', board.body.missing.length === 3, `count=${board.body.missing.length}`)
  check('重名的另一人仍在未交', missingNos.includes('20240201'), missingNos.join(','))

  console.log('\n[7] 无名单班级应降级为手填')
  const emptyClass = await j('/api/classes', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: `无名单选人班-${stamp}` }),
  })
  const course2 = await j('/api/courses', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ title: `无名单选人课程-${stamp}` }),
  })
  await j(`/api/courses/${course2.body.id}`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ status: 'published' }),
  })
  const lesson2 = await j(`/api/courses/${course2.body.id}/lessons`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ title: '第 1 课时' }),
  })
  const session2 = await j('/api/sessions', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ class_id: emptyClass.body.id, lesson_id: lesson2.body.id }),
  })
  await j(`/api/sessions/${session2.body.id}/start`, { method: 'POST', headers: H })

  await send('Page.navigate', { url: `${BASE}/student/courses/${course2.body.id}` })
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((b) => b.innerText.includes('提交作业'))`,
    '提交作业按钮',
  )
  await clickByText('button', '提交作业')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '上传弹窗')
  await new Promise((r) => setTimeout(r, 1800))

  const noPick = await evaluate(`document.querySelector('.roster-pick__select') !== null`)
  check('无名单时不显示下拉', noPick === false)

  const manualPlaceholder = await evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('.el-dialog input'))
    const t = inputs.find((i) => (i.placeholder || '').includes('姓名'))
    return t ? t.placeholder : ''
  })()`)
  check('降级为手填姓名', manualPlaceholder.includes('请输入你的姓名'), manualPlaceholder)

  // 关掉这个弹窗，避免遮罩挡住后续操作
  await closeAllDialogs()

  console.log('\n[8] 换班级时不应带出上一个班的学号')
  // 此时 localStorage 里记着 20240204（上一步提交时写入）
  const remembered = await evaluate(`localStorage.getItem('classroom.student.no')`)
  check('上一步确实记住了学号', remembered === '20240204', `${remembered}`)

  // 第 7 步启动了无名单班级的课堂，它成了当前活动课堂；
  // 回到有名单的课程页时班级上下文会串到无名单班，必须先把活动课堂切回来。
  await closeAllDialogs()
  // 先结束无名单班的课堂：currentSession 返回的是任意一个活动课堂，
  // 不结束它的话即使再启动有名单班的课堂，前端仍可能拿到无名单班那个。
  await j(`/api/sessions/${session2.body.id}/end`, { method: 'POST', headers: H })
  const sessionBack = await j('/api/sessions', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ class_id: classId, lesson_id: lessonId }),
  })
  await j(`/api/sessions/${sessionBack.body.id}/start`, { method: 'POST', headers: H })

  // 确认当前活动课堂已切回测试班级
  const activeNow = await j('/api/student/current-session')
  console.log(`  当前活动课堂：${activeNow.body?.class_name ?? '（无）'}`)
  check('活动课堂已切回有名单班级', activeNow.body?.session?.class_id === classId,
    `class_id=${activeNow.body?.session?.class_id}`)

  // 先确认：学号属于本班时保留。
  await send('Page.navigate', { url: `${BASE}/student/courses/${courseId}` })
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((b) => b.innerText.includes('提交作业'))`,
    '提交作业按钮',
  )
  await clickByText('button', '提交作业')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '上传弹窗')
  // 等名单加载完成：出现「已选」提示说明学号被正确识别为本班成员
  await new Promise((r) => setTimeout(r, 2200))
  // 诊断：把弹窗与输入框的实际状态打出来，定位是没打开还是选择器不对
  const diag = await evaluate(`(() => {
    const dialogs = Array.from(document.querySelectorAll('.el-dialog'))
    const inputs = Array.from(document.querySelectorAll('.el-dialog input'))
    return {
      dialogCount: dialogs.length,
      dialogTitles: dialogs.map((d) => d.querySelector('.el-dialog__title')?.innerText ?? ''),
      inputCount: inputs.length,
      placeholders: inputs.map((i) => i.placeholder),
      picked: document.querySelector('.roster-pick__picked')?.innerText ?? null,
      hint: document.querySelector('.roster-pick__hint')?.innerText ?? null,
    }
  })()`)
  console.log(`  诊断：${JSON.stringify(diag)}`)
  const sameClassPicked = diag.picked ?? ''
  console.log(`  重开后：${sameClassPicked || '（未自动选中）'}`)
  check('学号属于本班时自动选中', sameClassPicked.includes('20240204'), sameClassPicked)

  // 再确认：学号不属于新班级时应被清掉
  await closeAllDialogs()
  await evaluate(`localStorage.setItem('classroom.student.no', '99999999')`)
  await send('Page.navigate', { url: `${BASE}/student/courses/${courseId}` })
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((b) => b.innerText.includes('提交作业'))`,
    '提交作业按钮',
  )
  await clickByText('button', '提交作业')
  await waitFor(`document.querySelector('.el-dialog') !== null`, '上传弹窗')
  await new Promise((r) => setTimeout(r, 2200))

  const staleCleared = await evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('.el-dialog input'))
    const noInput = inputs.find((i) => {
      const p = i.placeholder || ''
      return p.includes('从名单选择后自动填入') && !p.includes('也可直接修改')
    })
    const nameInput = inputs.find((i) => (i.placeholder || '').includes('也可直接修改'))
    return { no: noInput ? noInput.value : null, name: nameInput ? nameInput.value : null }
  })()`)
  console.log(`  外来学号 99999999 打开后：学号="${staleCleared.no}"，姓名="${staleCleared.name}"`)
  check('不属于本班的学号被清除', staleCleared.no === '', `${staleCleared.no}`)
  check('配套的姓名也被清除', staleCleared.name === '', `${staleCleared.name}`)

  console.log('\n[9] 控制台错误检查')
  check('无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} finally {
  socket.close()
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
}
