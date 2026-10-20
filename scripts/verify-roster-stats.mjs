/**
 * 验证学生名单与作业统计功能。
 *
 * 覆盖：
 * 1. 名单导入（多种分隔符、表头跳过、去重、异常行）
 * 2. 课程作业总览（每课时提交率）
 * 3. 课时提交看板（已交 / 未交 / 名单外）
 * 4. 学号贯穿：学生提交时带学号 → 统计能对上
 *
 * 用法：node scripts/verify-roster-stats.mjs [baseUrl]
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

// ---- 准备 ----
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
  body: JSON.stringify({ name: `名单测试班-${stamp}` }),
})
const classId = cls.body.id

const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: `名单测试课程-${stamp}` }),
})
const courseId = course.body.id
await j(`/api/courses/${courseId}`, {
  method: 'PUT',
  headers: H,
  body: JSON.stringify({ status: 'published' }),
})
const lesson1 = await j(`/api/courses/${courseId}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 1 课时 · 基础' }),
})
const lesson2 = await j(`/api/courses/${courseId}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 2 课时 · 进阶' }),
})
const session = await j('/api/sessions', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ class_id: classId, lesson_id: lesson1.body.id }),
})
await j(`/api/sessions/${session.body.id}/start`, { method: 'POST', headers: H })

// ---- 1. 名单导入 ----
console.log('\n[1] 名单导入')

const emptyList = await j(`/api/classes/${classId}/students`, { headers: H })
check('初始名单为空', emptyList.body.items.length === 0, `count=${emptyList.body.items.length}`)

// 混合分隔符 + 表头 + 空行 + 注释 + 异常行
const rosterText = [
  '学号\t姓名',
  '',
  '# 这是注释行',
  '20240101\t张三',
  '20240102 李四',
  '20240103,王五',
  '20240104，赵六',
  '  20240105   钱七  ',
  '只有学号',
  '20240106',
  '20240101 张三改名',
].join('\n')

const imported = await j(`/api/classes/${classId}/students/import`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ text: rosterText }),
})
check('导入接口返回成功', imported.status === 200, JSON.stringify(imported.body).slice(0, 150))

const res = imported.body
console.log(`  新增 ${res.inserted}，更新 ${res.updated}，异常 ${res.invalid.length}，总计 ${res.total}`)

check('导入 5 位学生', res.total === 5, `total=${res.total}`)
check('新增 5 条', res.inserted === 5, `inserted=${res.inserted}`)
check('表头被跳过', !JSON.stringify(res).includes('学号\t姓名'))
check('注释行被跳过', res.invalid.every((i) => !i.raw.startsWith('#')))
check('空行被跳过', res.invalid.every((i) => i.raw.trim() !== ''))
check('缺姓名的行被记为异常', res.invalid.some((i) => i.reason.includes('两列')), JSON.stringify(res.invalid))
check('异常行带行号', res.invalid.every((i) => i.line > 0))

// 分隔符都能识别
const list = await j(`/api/classes/${classId}/students`, { headers: H })
const names = list.body.items.map((s) => s.student_name).sort()
console.log(`  名单：${names.join('、')}`)
check('Tab 分隔解析正确', names.includes('张三改名'), names.join(','))
check('空格分隔解析正确', names.includes('李四'), names.join(','))
check('英文逗号分隔解析正确', names.includes('王五'), names.join(','))
check('中文逗号分隔解析正确', names.includes('赵六'), names.join(','))
check('多余空白被裁剪', names.includes('钱七'), names.join(','))

// 学号唯一：重复学号只更新姓名
check('重复学号未产生两条记录', list.body.items.length === 5, `count=${list.body.items.length}`)
const zhang = list.body.items.find((s) => s.student_no === '20240101')
check('重复学号更新了姓名', zhang?.student_name === '张三改名', zhang?.student_name)

// 再次导入应全部为更新
const reimport = await j(`/api/classes/${classId}/students/import`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ text: rosterText }),
})
check('重复导入记为更新而非新增', reimport.body.inserted === 0 && reimport.body.updated === 5,
  `inserted=${reimport.body.inserted}, updated=${reimport.body.updated}`)

// 单个添加
const single = await j(`/api/classes/${classId}/students`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ student_no: '20240199', student_name: '孙八' }),
})
check('单个添加成功', single.status === 200 && single.body.student_no === '20240199')

const badAdd = await j(`/api/classes/${classId}/students`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ student_no: '', student_name: '无学号' }),
})
check('空学号被拒绝', badAdd.status === 400, `status=${badAdd.status}`)

// 删除
await j(`/api/classes/${classId}/students/${single.body.id}`, { method: 'DELETE', headers: H })
const afterDel = await j(`/api/classes/${classId}/students`, { headers: H })
check('删除学生成功', afterDel.body.items.length === 5, `count=${afterDel.body.items.length}`)

// ---- 2. 提交作业（部分学生带学号） ----
console.log('\n[2] 学生提交作业')

async function submit(studentName, studentNo, lessonId) {
  const form = new FormData()
  form.append('student_name', studentName)
  if (studentNo) form.append('student_no', studentNo)
  form.append('lesson_id', String(lessonId))
  form.append('class_id', String(classId))
  form.append('file', new File([Buffer.from('hw')], `${studentName}.txt`, { type: 'text/plain' }))
  return j('/api/student/submissions', { method: 'POST', body: form })
}

// 张三、李四带学号提交；王五不带学号（模拟手填姓名）
const s1 = await submit('张三改名', '20240101', lesson1.body.id)
check('带学号提交成功', s1.status === 200, JSON.stringify(s1.body).slice(0, 100))
check('提交记录保存了学号', s1.body.submission.student_no === '20240101',
  s1.body.submission.student_no)

const s2 = await submit('李四', '20240102', lesson1.body.id)
check('第二位学生提交成功', s2.status === 200)

const s3 = await submit('王五', '', lesson1.body.id)
check('不带学号也能提交', s3.status === 200)
check('无学号时字段为空串', s3.body.submission.student_no === '', `"${s3.body.submission.student_no}"`)

// 第 2 课时只有张三交
await submit('张三改名', '20240101', lesson2.body.id)

// ---- 3. 课程作业总览 ----
console.log('\n[3] 课程作业总览')

const overview = await j(`/api/courses/${courseId}/homework-overview?class_id=${classId}`, {
  headers: H,
})
check('总览查询成功', overview.status === 200, JSON.stringify(overview.body).slice(0, 150))

const ov = overview.body
check('返回课程标题', ov.course_title.includes('名单测试课程'), ov.course_title)
check('返回班级名', ov.class_name.includes('名单测试班'), ov.class_name)
check('名单人数正确', ov.roster_total === 5, `roster_total=${ov.roster_total}`)
check('返回 2 个课时', ov.lessons.length === 2, `count=${ov.lessons.length}`)

const l1 = ov.lessons[0]
const l2 = ov.lessons[1]
console.log(`  课时1：提交 ${l1.submitted_count} 份，${l1.submitter_count} 人，未交 ${l1.missing_count} 人`)
console.log(`  课时2：提交 ${l2.submitted_count} 份，${l2.submitter_count} 人，未交 ${l2.missing_count} 人`)

check('课时1 提交份数为 3', l1.submitted_count === 3, `count=${l1.submitted_count}`)
check('课时1 去重人数为 3', l1.submitter_count === 3, `count=${l1.submitter_count}`)
check('课时1 未交 2 人', l1.missing_count === 2, `missing=${l1.missing_count}`)
check('课时2 未交 4 人', l2.missing_count === 4, `missing=${l2.missing_count}`)
check('课时顺序正确', l1.sort_order === 1 && l2.sort_order === 2,
  `${l1.sort_order}, ${l2.sort_order}`)

// ---- 4. 课时提交看板 ----
console.log('\n[4] 课时提交看板（第 1 课时）')

const board = await j(
  `/api/lessons/${lesson1.body.id}/submission-board?class_id=${classId}`,
  { headers: H },
)
check('看板查询成功', board.status === 200, JSON.stringify(board.body).slice(0, 150))

const b = board.body
check('名单人数 5', b.roster_total === 5, `roster_total=${b.roster_total}`)
check('已交 3 人', b.submitted.length === 3, `count=${b.submitted.length}`)
check('未交 2 人', b.missing.length === 2, `count=${b.missing.length}`)

const submittedNames = b.submitted.map((s) => s.student_name).sort()
const missingNames = b.missing.map((s) => s.student_name).sort()
console.log(`  已交：${submittedNames.join('、')}`)
console.log(`  未交：${missingNames.join('、')}`)

check('已交含张三', submittedNames.includes('张三改名'), submittedNames.join(','))
check('已交含李四', submittedNames.includes('李四'), submittedNames.join(','))
check('已交含王五（无学号，按姓名匹配）', submittedNames.includes('王五'), submittedNames.join(','))
check('未交为赵六与钱七', missingNames.includes('赵六') && missingNames.includes('钱七'),
  missingNames.join(','))
check('未交不含已交学生', !missingNames.includes('张三改名'), missingNames.join(','))

// 无学号的提交应归到名单内（按姓名），而不是名单外
check('无学号提交未落入名单外', b.unlisted.length === 0, JSON.stringify(b.unlisted))

// 已交记录带出提交信息
const zhangState = b.submitted.find((s) => s.student_no === '20240101')
check('已交记录含提交时间', typeof zhangState?.latest_at === 'string' && zhangState.latest_at.length > 0)
check('已交记录含来源 IP', typeof zhangState?.client_ip === 'string' && zhangState.client_ip.length > 0)
check('已交记录含提交 ID', typeof zhangState?.latest_submission_id === 'number')

// ---- 5. 名单外提交者 ----
console.log('\n[5] 名单外提交者')

await submit('临时同学', '99999999', lesson1.body.id)
const board2 = await j(
  `/api/lessons/${lesson1.body.id}/submission-board?class_id=${classId}`,
  { headers: H },
)
check('名单外提交者被单独归类', board2.body.unlisted.length === 1,
  `unlisted=${board2.body.unlisted.length}`)
check('名单外提交者姓名正确', board2.body.unlisted[0]?.student_name === '临时同学',
  board2.body.unlisted[0]?.student_name)
check('名单外提交者不计入未交', board2.body.missing.length === 2,
  `missing=${board2.body.missing.length}`)

// ---- 6. 无名单时的降级 ----
console.log('\n[6] 无名单时的降级行为')

const noRosterClass = await j('/api/classes', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ name: `空名单班-${stamp}` }),
})
const ov2 = await j(
  `/api/courses/${courseId}/homework-overview?class_id=${noRosterClass.body.id}`,
  { headers: H },
)
check('无名单时名单人数为 0', ov2.body.roster_total === 0, `roster_total=${ov2.body.roster_total}`)
check('无名单时未交数为 0（不误报）',
  ov2.body.lessons.every((l) => l.missing_count === 0),
  JSON.stringify(ov2.body.lessons.map((l) => l.missing_count)))

// 不带 class_id 的跨班汇总
const ov3 = await j(`/api/courses/${courseId}/homework-overview`, { headers: H })
check('跨班汇总成功', ov3.status === 200)
check('跨班汇总未交数为 0', ov3.body.lessons.every((l) => l.missing_count === 0))

// ---- 7. 权限 ----
console.log('\n[7] 权限校验')

const noAuth = await j(`/api/classes/${classId}/students`)
check('未授权访问名单返回 401', noAuth.status === 401, `status=${noAuth.status}`)

const noAuthOverview = await j(`/api/courses/${courseId}/homework-overview`)
check('未授权访问总览返回 401', noAuthOverview.status === 401, `status=${noAuthOverview.status}`)

// ---- 8. 参数校验 ----
console.log('\n[8] 参数校验')

const badClass = await j('/api/classes/999999/students', { headers: H })
check('不存在的班级返回 404', badClass.status === 404, `status=${badClass.status}`)

const badCourse = await j('/api/courses/999999/homework-overview', { headers: H })
check('不存在的课程返回 404', badCourse.status === 404, `status=${badCourse.status}`)

const badLesson = await j('/api/lessons/999999/submission-board', { headers: H })
check('不存在的课时返回 404', badLesson.status === 404, `status=${badLesson.status}`)

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
}
