/**
 * 检查填充后的数据在界面上是否正常显示。
 *
 * 覆盖五个关键页面：课程列表、课程详情（作业统计）、批改页、
 * 提交记录、学生端上传页。每页抓取关键文本并核对预期内容，
 * 顺便存一张截图便于人工确认。
 *
 * 用法：node scripts/verify-seeded-ui.mjs [baseUrl]
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const OUT = 'docs/screenshots'

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

// ---- 先确认后端数据就位 ----
const login = await api('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const token = login.body.token
const H = { Authorization: `Bearer ${token}` }

const courses = (await api('/api/courses', { headers: H })).body.items
const classes = (await api('/api/classes', { headers: H })).body.items

console.log('\n[1] 后端数据')
check('课程 4 门', courses.length === 4, `实际 ${courses.length}`)
check('班级 3 个', classes.length === 3, `实际 ${classes.length}`)
const wps = courses.find((c) => c.title === '计算机应用基础')
check('存在「计算机应用基础」', Boolean(wps))

const lessons = (await api(`/api/courses/${wps.id}/lessons`, { headers: H })).body.items
check('课时 3 个', lessons.length === 3, `实际 ${lessons.length}`)

const lesson1 = lessons[0]
const detail = (await api(`/api/lessons/${lesson1.id}`, { headers: H })).body
check('课时正文非空', (detail.content_html ?? '').length > 200, `${(detail.content_html ?? '').length} 字符`)
check('正文含「操作要点」', (detail.content_html ?? '').includes('操作要点'))

// 提交与批改
const subs = (await api(`/api/admin/submissions?lesson_id=${lesson1.id}&limit=200`, { headers: H })).body
const items = subs.items ?? []
// 26 名学生提交，其中林晓彤交错了文件重交一次 → 27 条提交记录
check('提交 27 条', items.length === 27, `实际 ${items.length}`)
const reviewed = items.filter((s) => s.review_label || s.review_score !== null)
check('已批改 20 份', reviewed.length === 20, `实际 ${reviewed.length}`)
check('提交带学号', items.every((s) => s.student_no.length === 8))
check('提交带 IP', items.every((s) => s.client_ip.length > 0))
check('提交带文件', items.every((s) => s.file_count > 0))
check('存在重复标记', items.some((s) => s.duplicate_flag === 1))

// 审阅看板
const board = (await api(`/api/lessons/${lesson1.id}/review-board?class_id=1`, { headers: H })).body
check('看板统计总数 27', board.stats.total === 27, `实际 ${board.stats.total}`)
check('看板待批改 7', board.stats.unreviewed === 7, `实际 ${board.stats.unreviewed}`)
check('看板未交 4', board.stats.missing === 4, `实际 ${board.stats.missing}`)
check('看板平均分已算', board.stats.average_score > 0, `${board.stats.average_score}`)
check(
  '看板标签合计等于总数',
  board.stats.good + board.stats.pass + board.stats.fail + board.stats.other + board.stats.unreviewed ===
    board.stats.total,
)

// 提交看板（谁没交）：按学生聚合，26 人已交 / 4 人未交
const subBoard = (await api(`/api/lessons/${lesson1.id}/submission-board?class_id=1`, { headers: H })).body
check('名单 30 人', subBoard.roster_total === 30, `实际 ${subBoard.roster_total}`)
check('提交看板统计 26 人已交', subBoard.submitted.length === 26, `实际 ${subBoard.submitted.length}`)
check('提交看板统计 4 人未交', subBoard.missing.length === 4, `实际 ${subBoard.missing.length}`)
check(
  '重复提交者只算一个学生',
  subBoard.submitted.find((s) => s.student_no === '20250102')?.submission_count === 2,
)

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
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error(`求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  }
  return r.result.value
}
async function waitFor(expr, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expr)) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`等待超时：${label}`)
}
async function shot(name) {
  mkdirSync(OUT, { recursive: true })
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}`, Buffer.from(data, 'base64'))
  console.log(`  截图：${OUT}/${name}`)
}
const bodyText = () => evaluate('document.body.innerText')

try {
  // 登录并进入后台
  await send('Page.navigate', { url: `${BASE}/student` })
  await waitFor(
    `location.origin === ${JSON.stringify(new URL(BASE).origin)} && document.body !== null`,
    '首页',
  )
  await evaluate(`localStorage.setItem('classroom.token', ${JSON.stringify(token)})`)

  console.log('\n[2] 课程列表')
  await send('Page.navigate', { url: `${BASE}/admin/courses` })
  await waitFor(`document.querySelector('.el-table') !== null`, '课程列表')
  await new Promise((r) => setTimeout(r, 1200))
  let text = await bodyText()
  for (const title of ['计算机应用基础', '程序设计基础', '视频剪辑', '计算机网络技术']) {
    check(`列表显示「${title}」`, text.includes(title))
  }
  await shot('seeded-course-list.png')

  console.log('\n[3] 课程详情 · 作业统计')
  await send('Page.navigate', { url: `${BASE}/admin/courses/${wps.id}` })
  await waitFor(`document.querySelector('.el-tabs') !== null`, '课程详情')
  await new Promise((r) => setTimeout(r, 1500))
  text = await bodyText()
  check('显示课时「Word 图文混排」', text.includes('Word 图文混排'))
  check('显示课时「Excel 数据统计」', text.includes('Excel 数据统计'))

  // 切到作业统计标签
  const switched = await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('.el-tabs__item'))
    const t = tabs.find((x) => x.innerText.includes('作业'))
    if (!t) return false
    t.click()
    return true
  })()`)
  check('找到作业统计标签', switched)
  if (switched) {
    await new Promise((r) => setTimeout(r, 1800))
    text = await bodyText()
    check('显示「批改」入口', text.includes('批改'))
    await shot('seeded-course-homework.png')
  }

  console.log('\n[4] 批改页')
  await send('Page.navigate', {
    url: `${BASE}/admin/lessons/${lesson1.id}/review?class_id=1`,
  })
  await waitFor(`document.querySelector('.review__stats') !== null`, '批改页')
  await new Promise((r) => setTimeout(r, 1500))
  text = await bodyText()
  check('显示提交份数 27', /\b27\b/.test(text))
  check('显示待批改 7', /\b7\b/.test(text))
  check('显示学生姓名', text.includes('陈思远'))
  check('显示学号', text.includes('20250101'))
  check('显示标签「好」', text.includes('好'))
  check('显示标签「不通过」', text.includes('不通过'))
  const rows = await evaluate(
    `document.querySelectorAll('.el-table__body-wrapper tbody tr').length`,
  )
  check('列表 27 行', rows === 27, `实际 ${rows}`)
  await shot('seeded-review-board.png')

  // 打开一份带评语的抽屉
  await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.el-table__body-wrapper tbody tr'))
    const target = rows.find((tr) => {
      const active = Array.from(tr.querySelectorAll('.review__tag-btn'))
        .find((t) => t.classList.contains('el-tag--dark'))
      return active && active.innerText.trim() === '不通过'
    })
    const cell = (target ?? rows[0]).querySelectorAll('td')[2]
    cell?.click()
  })()`)
  await waitFor(`document.querySelector('.el-drawer') !== null`, '批改抽屉')
  await new Promise((r) => setTimeout(r, 1800))
  // 评语写在 textarea 里，innerText 读不到表单值，必须直接取 value
  const comment = await evaluate(
    `document.querySelector('.el-drawer textarea')?.value ?? ''`,
  )
  check('抽屉显示评语', comment.includes('图片被拉伸变形') || comment.includes('未按要求设置行距'), comment)
  const score = await evaluate(
    `document.querySelector('.el-drawer .el-input-number input')?.value ?? ''`,
  )
  // el-input-number 按 step=0.5 显示，48 会渲染成 48.0
  check('抽屉显示分数', ['52', '48'].includes(String(parseFloat(score))), score)
  await shot('seeded-review-drawer.png')
  await evaluate(`document.querySelector('.el-drawer__close-btn')?.click()`)
  await new Promise((r) => setTimeout(r, 800))

  console.log('\n[5] 提交记录')
  await send('Page.navigate', { url: `${BASE}/admin/submissions` })
  await waitFor(`document.querySelector('.el-table') !== null`, '提交记录')
  await new Promise((r) => setTimeout(r, 1500))
  text = await bodyText()
  check('显示提交人姓名', text.includes('陈思远'))
  check('显示学号列', text.includes('20250101'))
  check('显示 IP', /127\.0\.0\.1|::1/.test(text))
  const subRows = await evaluate(
    `document.querySelectorAll('.el-table__body-wrapper tbody tr').length`,
  )
  check('至少显示 20 行', subRows >= 20, `实际 ${subRows}`)
  await shot('seeded-submissions.png')

  console.log('\n[6] 学生端上传页')
  await send('Page.navigate', { url: `${BASE}/student` })
  await waitFor(`document.body !== null`, '学生端')
  await new Promise((r) => setTimeout(r, 1800))
  text = await bodyText()
  check('学生端显示课程', text.includes('计算机应用基础') || text.includes('程序设计基础'))
  await shot('seeded-student.png')

  console.log('\n[7] 文件预览')
  // 列表里只有 file_count，取详情拿真实资源 ID
  const one = (await api(`/api/admin/submissions/${items[0].id}`, { headers: H })).body
  check('详情返回文件列表', (one.files ?? []).length > 0)
  const fileUrl = `${BASE}/files/${one.files[0].resource_id}`
  const fileRes = await fetch(fileUrl)
  check('文件可下载', fileRes.status === 200, `状态 ${fileRes.status}`)
  const bytes = (await fileRes.arrayBuffer()).byteLength
  check('文件大小合理', bytes > 1000, `${bytes} 字节`)
  check(
    '文件名含学号与姓名',
    /^2025\d{4}-[\u4e00-\u9fa5]+-/.test(one.files[0].name),
    one.files[0].name,
  )
} finally {
  socket.close()
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
}

console.log(`\n合计：${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
