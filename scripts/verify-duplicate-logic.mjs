/**
 * 验证重复判定的口径。
 *
 * 关键行为：
 * - 带学号时按「同一个学生」判断，不同学生提交不算重复；
 * - 同一学生重复提交才算重复；
 * - 不带学号时退回设备/班级判断。
 *
 * 用法：node scripts/verify-duplicate-logic.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'

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

const login = await j('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const token = login.body.token
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const stamp = Date.now()
const cls = await j('/api/classes', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ name: `重复判定班-${stamp}` }),
})
const classId = cls.body.id
const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: `重复判定课程-${stamp}` }),
})
const courseId = course.body.id
const lesson = await j(`/api/courses/${courseId}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 1 课时' }),
})
const lessonId = lesson.body.id

// 导入名单：看板只把名单内的人算作「已交」，没有名单时全归「名单外」
await j(`/api/classes/${classId}/students/import`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    text: '20240101 张三\n20240102 李四\n20240103 王五\n20240104 赵六',
  }),
})

async function submit(name, no, opts = {}) {
  const form = new FormData()
  form.append('student_name', name)
  if (no) form.append('student_no', no)
  form.append('lesson_id', String(lessonId))
  form.append('class_id', String(classId))
  if (opts.deviceId) form.append('device_id', opts.deviceId)
  form.append('file', new File([Buffer.from('x')], `${name}.txt`, { type: 'text/plain' }))
  return j('/api/student/submissions', { method: 'POST', body: form })
}

console.log('[1] 带学号：不同学生提交不应标记重复')
const a = await submit('张三', '20240101', { deviceId: 'dev-a' })
check('张三首次提交成功', a.status === 200)
check('张三未被标记重复', a.body.submission.duplicate_flag === 0,
  `flag=${a.body.submission.duplicate_flag}`)
check('张三无重复警告', a.body.duplicate_warning === null, `${a.body.duplicate_warning}`)

const b = await submit('李四', '20240102', { deviceId: 'dev-a' })
check('李四提交成功', b.status === 200)
check('李四未被标记重复（同一台电脑但不同学生）',
  b.body.submission.duplicate_flag === 0, `flag=${b.body.submission.duplicate_flag}`)
check('李四无重复警告', b.body.duplicate_warning === null, `${b.body.duplicate_warning}`)

const c = await submit('王五', '20240103', { deviceId: 'dev-b' })
check('王五未被标记重复（另一台电脑）',
  c.body.submission.duplicate_flag === 0, `flag=${c.body.submission.duplicate_flag}`)

console.log('\n[2] 带学号：同一学生再次提交应标记重复')
const a2 = await submit('张三', '20240101', { deviceId: 'dev-c' })
check('张三二次提交成功', a2.status === 200)
check('张三二次提交被标记重复', a2.body.submission.duplicate_flag === 1,
  `flag=${a2.body.submission.duplicate_flag}`)
check('重复指向自己的首次提交', a2.body.submission.duplicate_of === a.body.submission.id,
  `duplicate_of=${a2.body.submission.duplicate_of}, 首次=${a.body.submission.id}`)
check('提示语说明是本人重复提交',
  typeof a2.body.duplicate_warning === 'string' && a2.body.duplicate_warning.includes('你已提交过'),
  `${a2.body.duplicate_warning}`)

console.log('\n[3] 不带学号：退回设备判断')
// 用一个全新设备，但班级里已有提交
const d = await submit('临时同学', '', { deviceId: 'dev-new' })
check('无学号提交成功', d.status === 200)
check('无学号且本班已有提交 → 标记重复',
  d.body.submission.duplicate_flag === 1, `flag=${d.body.submission.duplicate_flag}`)
check('无学号时提示语不指名他人',
  typeof d.body.duplicate_warning === 'string' && !d.body.duplicate_warning.includes('张三'),
  `${d.body.duplicate_warning}`)

console.log('\n[4] 统计口径：去重人数按学生算')
const overview = await j(`/api/courses/${courseId}/homework-overview?class_id=${classId}`, {
  headers: H,
})
const l = overview.body.lessons[0]
console.log(`  提交 ${l.submitted_count} 份，去重 ${l.submitter_count} 人，重复 ${l.duplicate_count} 份`)
check('提交份数为 5', l.submitted_count === 5, `count=${l.submitted_count}`)
check('去重人数为 4（张三/李四/王五/临时同学）', l.submitter_count === 4,
  `count=${l.submitter_count}`)
check('重复份数为 2（张三二次 + 无学号临时同学）', l.duplicate_count === 2,
  `count=${l.duplicate_count}`)

const board = await j(`/api/lessons/${lessonId}/submission-board?class_id=${classId}`, {
  headers: H,
})
const names = board.body.submitted.map((s) => s.student_name)
console.log(`  看板已交：${names.join('、')}`)
console.log(`  名单外：${board.body.unlisted.map((s) => s.student_name).join('、') || '（无）'}`)
// 名单内 3 人已交（张三/李四/王五），临时同学在名单外
check('看板列出 3 位名单内学生', board.body.submitted.length === 3,
  `count=${board.body.submitted.length}`)
check('张三只出现一次', names.filter((n) => n === '张三').length === 1, names.join(','))
check('张三标记了重复', board.body.submitted.find((s) => s.student_name === '张三')?.has_duplicate === true)
check('临时同学归入名单外', board.body.unlisted.some((s) => s.student_name === '临时同学'),
  JSON.stringify(board.body.unlisted.map((s) => s.student_name)))
check('赵六未交', board.body.missing.some((m) => m.student_name === '赵六'),
  JSON.stringify(board.body.missing.map((m) => m.student_name)))

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
}
