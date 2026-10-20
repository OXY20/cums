/**
 * 真实场景冒烟：模拟教师完整使用一遍新功能。
 *
 * 不是逐项断言，而是按真实操作顺序走一遍，
 * 确认这条链路在「没有任何测试铺垫」的干净状态下也能跑通。
 *
 * 用法：node scripts/smoke-roster-workflow.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'

let passed = 0
let failed = 0
function step(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
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
const className = `冒烟班-${stamp}`
const courseTitle = `冒烟课程-${stamp}`

console.log('模拟教师操作流程\n')

// 1. 教师建班
const cls = await j('/api/classes', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ name: className, room_name: '机房 A' }),
})
step('教师创建班级', cls.status === 200, `status=${cls.status}`)
const classId = cls.body.id

// 2. 从 Excel 粘贴名单（模拟真实格式：带表头、Tab 分隔）
const excelPaste = `学号\t姓名
20240301\t陈一
20240302\t林二
20240303\t黄三
20240304\t刘四
20240305\t蔡五
20240306\t杨六`
const imported = await j(`/api/classes/${classId}/students/import`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ text: excelPaste }),
})
step('粘贴导入名单（含表头）', imported.status === 200 && imported.body.total === 6,
  `total=${imported.body?.total}`)
step('表头未被当成学生', imported.body.invalid.length === 0,
  `invalid=${imported.body?.invalid?.length}`)

// 3. 教师建课与课时
const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: courseTitle }),
})
const courseId = course.body.id
await j(`/api/courses/${courseId}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ status: 'published' }),
})
const lessons = []
for (const t of ['第一课时 认识界面', '第二课时 保存文件', '第三课时 打印输出']) {
  const l = await j(`/api/courses/${courseId}/lessons`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ title: t }),
  })
  lessons.push(l.body)
}
step('教师建课与 3 个课时', lessons.length === 3)

// 4. 上课
const session = await j('/api/sessions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ class_id: classId, lesson_id: lessons[0].id }),
})
await j(`/api/sessions/${session.body.id}/start`, { method: 'POST', headers: H })
step('教师开始上课', true)

// 5. 学生交作业：课时1 全班交，课时2 交了 4 人，课时3 交了 2 人
async function submit(no, name, lessonId) {
  const form = new FormData()
  form.append('student_name', name)
  form.append('student_no', no)
  form.append('lesson_id', String(lessonId))
  form.append('class_id', String(classId))
  form.append('file', new File([Buffer.from('作业内容')], `${name}.txt`, { type: 'text/plain' }))
  return j('/api/student/submissions', { method: 'POST', body: form })
}

const roster = [
  ['20240301', '陈一'],
  ['20240302', '林二'],
  ['20240303', '黄三'],
  ['20240304', '刘四'],
  ['20240305', '蔡五'],
  ['20240306', '杨六'],
]

for (const [no, name] of roster) await submit(no, name, lessons[0].id)
step('第一课时全班 6 人提交', true)

for (const [no, name] of roster.slice(0, 4)) await submit(no, name, lessons[1].id)
step('第二课时 4 人提交', true)

for (const [no, name] of roster.slice(0, 2)) await submit(no, name, lessons[2].id)
step('第三课时 2 人提交', true)

// 6. 教师查看课程作业总览
const ov = await j(`/api/courses/${courseId}/homework-overview?class_id=${classId}`, { headers: H })
const [l1, l2, l3] = ov.body.lessons
console.log(`\n  总览：应缴 ${ov.body.roster_total * 3} 份`)
console.log(`    第一课时 ${ov.body.roster_total - l1.missing_count}/6，未交 ${l1.missing_count}`)
console.log(`    第二课时 ${ov.body.roster_total - l2.missing_count}/6，未交 ${l2.missing_count}`)
console.log(`    第三课时 ${ov.body.roster_total - l3.missing_count}/6，未交 ${l3.missing_count}\n`)

step('总览：第一课时已收齐', l1.missing_count === 0, `missing=${l1.missing_count}`)
step('总览：第二课时缺 2 人', l2.missing_count === 2, `missing=${l2.missing_count}`)
step('总览：第三课时缺 4 人', l3.missing_count === 4, `missing=${l3.missing_count}`)

// 7. 教师点进第二课时看谁没交
const board = await j(`/api/lessons/${lessons[1].id}/submission-board?class_id=${classId}`, {
  headers: H,
})
const missingNames = board.body.missing.map((m) => m.student_name)
console.log(`  第二课时未交：${missingNames.join('、')}`)
step('未交名单正确（蔡五、杨六）',
  missingNames.length === 2 && missingNames.includes('蔡五') && missingNames.includes('杨六'),
  missingNames.join(','))

// 8. 教师核对：有没有人交重了
const dupCount = board.body.submitted.filter((s) => s.has_duplicate).length
step('无人重复提交（不同学生不误标）', dupCount === 0, `duplicate=${dupCount}`)

// 9. 学生补交后，未交名单应更新
await submit('20240305', '蔡五', lessons[1].id)
const board2 = await j(`/api/lessons/${lessons[1].id}/submission-board?class_id=${classId}`, {
  headers: H,
})
step('补交后未交减少为 1 人', board2.body.missing.length === 1,
  `missing=${board2.body.missing.length}`)
step('补交的蔡五进入已交名单',
  board2.body.submitted.some((s) => s.student_no === '20240305'),
  board2.body.submitted.map((s) => s.student_no).join(','))

// 10. 同一学生再交一次 → 应标重复
const again = await submit('20240305', '蔡五', lessons[1].id)
step('同一学生重复提交被标记', again.body.submission.duplicate_flag === 1,
  `flag=${again.body.submission.duplicate_flag}`)
step('提示语说明是本人重复', again.body.duplicate_warning?.includes('你已提交过') === true,
  `${again.body.duplicate_warning}`)

// 11. 统计口径：重复提交不应虚增人数
const board3 = await j(`/api/lessons/${lessons[1].id}/submission-board?class_id=${classId}`, {
  headers: H,
})
step('重复提交不虚增已交人数', board3.body.submitted.length === 5,
  `count=${board3.body.submitted.length}`)

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exitCode = 1
