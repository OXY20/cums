/**
 * 验证作业审阅功能（后端接口）。
 *
 * 覆盖：
 * 1. 单份审阅：打标签、打分、评语、清除
 * 2. 批量审阅：多份同一评价、去重、上限、空列表
 * 3. 审阅看板：统计口径、按提交展开（不聚合）
 * 4. 列表按标签筛选
 * 5. 参数校验与权限
 *
 * 用法：node scripts/verify-review-api.mjs [baseUrl]
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
  body: JSON.stringify({ name: `审阅测试班-${stamp}` }),
})
const classId = cls.body.id

const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: `审阅测试课程-${stamp}` }),
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
  body: JSON.stringify({ title: '审阅课时 · 批量批改' }),
})
const lessonId = lesson.body.id

// 名单：5 人，方便验证「未交」
await j(`/api/classes/${classId}/students/import`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    text: ['20240101\t张三', '20240102\t李四', '20240103\t王五', '20240104\t赵六', '20240105\t钱七'].join(
      '\n',
    ),
  }),
})

async function submit(studentName, studentNo) {
  const form = new FormData()
  form.append('student_name', studentName)
  if (studentNo) form.append('student_no', studentNo)
  form.append('lesson_id', String(lessonId))
  form.append('class_id', String(classId))
  form.append('file', new File([Buffer.from('hw')], `${studentName}.txt`, { type: 'text/plain' }))
  return j('/api/student/submissions', { method: 'POST', body: form })
}

const sub1 = await submit('张三', '20240101')
const sub2 = await submit('李四', '20240102')
const sub3 = await submit('王五', '20240103')
// 张三再交一次：验证审阅看板不按学生聚合
const sub4 = await submit('张三', '20240101')

const id1 = sub1.body.submission.id
const id2 = sub2.body.submission.id
const id3 = sub3.body.submission.id
const id4 = sub4.body.submission.id

// ---- 1. 新字段默认值 ----
console.log('\n[1] 审阅字段默认值')

const fresh = await j(`/api/admin/submissions/${id1}`, { headers: H })
check('详情接口返回 review_label', 'review_label' in fresh.body, JSON.stringify(fresh.body).slice(0, 120))
check('默认标签为空串', fresh.body.review_label === '', `"${fresh.body.review_label}"`)
check('默认分数为 null', fresh.body.review_score === null, String(fresh.body.review_score))
check('默认评语为空串', fresh.body.review_comment === '', `"${fresh.body.review_comment}"`)
check('默认未审阅', fresh.body.reviewed_at === null, String(fresh.body.reviewed_at))

// ---- 2. 单份审阅：打标签 ----
console.log('\n[2] 单份审阅 · 打标签')

const good = await j(`/api/admin/submissions/${id1}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ label: 'good' }),
})
check('打「好」标签成功', good.status === 200, JSON.stringify(good.body).slice(0, 150))
check('标签已写入', good.body.review_label === 'good', good.body.review_label)
check('打标签自动置为已查看', good.body.status === 'reviewed', good.body.status)
check('打标签记录了审阅时间', typeof good.body.reviewed_at === 'string' && good.body.reviewed_at.length > 0,
  String(good.body.reviewed_at))

// ---- 3. 单份审阅：打分与评语 ----
console.log('\n[3] 单份审阅 · 打分与评语')

const scored = await j(`/api/admin/submissions/${id1}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ score: 95, comment: '结构清晰，完成度高' }),
})
check('打分成功', scored.status === 200)
check('分数已写入', scored.body.review_score === 95, String(scored.body.review_score))
check('评语已写入', scored.body.review_comment === '结构清晰，完成度高', scored.body.review_comment)
check('只改分数不清空已有标签', scored.body.review_label === 'good', scored.body.review_label)

// 分数边界
const zero = await j(`/api/admin/submissions/${id2}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ score: 0 }),
})
check('0 分合法', zero.status === 200 && zero.body.review_score === 0, String(zero.body.review_score))

const hundred = await j(`/api/admin/submissions/${id2}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ score: 100 }),
})
check('100 分合法', hundred.status === 200 && hundred.body.review_score === 100,
  String(hundred.body.review_score))

const over = await j(`/api/admin/submissions/${id2}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ score: 101 }),
})
check('超过 100 分被拒绝', over.status === 400, `status=${over.status}`)

const negative = await j(`/api/admin/submissions/${id2}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ score: -1 }),
})
check('负分被拒绝', negative.status === 400, `status=${negative.status}`)

const decimal = await j(`/api/admin/submissions/${id2}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ score: 87.5 }),
})
check('小数分合法', decimal.status === 200 && decimal.body.review_score === 87.5,
  String(decimal.body.review_score))

// ---- 4. 清除 ----
console.log('\n[4] 清除审阅')

const cleared = await j(`/api/admin/submissions/${id2}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ label: '', score: null }),
})
check('清空标签与分数成功', cleared.status === 200)
check('标签已清空', cleared.body.review_label === '', `"${cleared.body.review_label}"`)
check('分数已清空', cleared.body.review_score === null, String(cleared.body.review_score))
check('清空后撤销审阅时间', cleared.body.reviewed_at === null, String(cleared.body.reviewed_at))

// 只清分数、保留标签：审阅时间应保留
await j(`/api/admin/submissions/${id3}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ label: 'pass', score: 70 }),
})
const clearScoreOnly = await j(`/api/admin/submissions/${id3}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ score: null }),
})
check('只清分数保留标签', clearScoreOnly.body.review_label === 'pass',
  clearScoreOnly.body.review_label)
check('只清分数不清审阅时间',
  typeof clearScoreOnly.body.reviewed_at === 'string' && clearScoreOnly.body.reviewed_at.length > 0,
  String(clearScoreOnly.body.reviewed_at))

// ---- 5. 批量审阅 ----
console.log('\n[5] 批量审阅')

const batch = await j('/api/admin/submissions/batch-review', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ ids: [id1, id2, id3, id4], label: 'pass', lesson_id: lessonId }),
})
check('批量审阅成功', batch.status === 200, JSON.stringify(batch.body).slice(0, 200))
check('更新 4 份', batch.body.updated === 4, `updated=${batch.body.updated}`)
check('批量返回统计', batch.body.stats !== null, String(batch.body.stats))

const bstats = batch.body.stats
check('统计总数 4', bstats.total === 4, `total=${bstats.total}`)
check('统计通过数 4', bstats.pass === 4, `pass=${bstats.pass}`)
check('统计未审阅 0', bstats.unreviewed === 0, `unreviewed=${bstats.unreviewed}`)

// 批量打分
const batchScore = await j('/api/admin/submissions/batch-review', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ ids: [id1, id2], score: 88, lesson_id: lessonId }),
})
check('批量打分成功', batchScore.status === 200)
check('批量打分更新 2 份', batchScore.body.updated === 2, `updated=${batchScore.body.updated}`)
check('批量打分后平均分正确',
  batchScore.body.stats.average_score === 88,
  String(batchScore.body.stats.average_score))

// 去重
const dupIds = await j('/api/admin/submissions/batch-review', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ ids: [id1, id1, id1], label: 'other' }),
})
check('重复 ID 只算一次', dupIds.body.updated === 1, `updated=${dupIds.body.updated}`)

// 空列表
const emptyIds = await j('/api/admin/submissions/batch-review', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ ids: [], label: 'pass' }),
})
check('空列表被拒绝', emptyIds.status === 400, `status=${emptyIds.status}`)

// 超上限
const tooMany = await j('/api/admin/submissions/batch-review', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ ids: Array.from({ length: 501 }, (_, i) => i + 1), label: 'pass' }),
})
check('超过 500 份被拒绝', tooMany.status === 400, `status=${tooMany.status}`)

// 不存在的 ID 被忽略
const partial = await j('/api/admin/submissions/batch-review', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ ids: [id1, 99999999], label: 'fail' }),
})
check('不存在的 ID 被忽略而非整批失败', partial.status === 200 && partial.body.updated === 1,
  `status=${partial.status}, updated=${partial.body.updated}`)

// ---- 6. 审阅看板 ----
console.log('\n[6] 课时审阅看板')

const board = await j(`/api/lessons/${lessonId}/review-board?class_id=${classId}`, { headers: H })
check('看板查询成功', board.status === 200, JSON.stringify(board.body).slice(0, 200))

const bd = board.body
check('返回课程标题', bd.course_title.includes('审阅测试课程'), bd.course_title)
check('返回班级名', bd.class_name.includes('审阅测试班'), bd.class_name)
check('名单人数 5', bd.roster_total === 5, `roster_total=${bd.roster_total}`)
check('按提交展开（张三交两次 = 4 行）', bd.items.length === 4, `items=${bd.items.length}`)
check('每份带文件清单', bd.items.every((i) => Array.isArray(i.files) && i.files.length > 0))
check('每份带提交人', bd.items.every((i) => typeof i.student_name === 'string' && i.student_name))
check('每份带审阅字段', bd.items.every((i) => 'review_label' in i && 'review_score' in i))
check('统计未交 2 人（赵六、钱七）', bd.stats.missing === 2, `missing=${bd.stats.missing}`)
check('统计总数与条目一致', bd.stats.total === bd.items.length,
  `${bd.stats.total} vs ${bd.items.length}`)

// 按时间倒序
const times = bd.items.map((i) => i.created_at)
const sortedDesc = [...times].sort().reverse()
check('条目按提交时间倒序', JSON.stringify(times) === JSON.stringify(sortedDesc),
  times.join(' | '))

// 无班级时不返回未交
const boardNoClass = await j(`/api/lessons/${lessonId}/review-board`, { headers: H })
check('跨班看板成功', boardNoClass.status === 200)
check('跨班看板未交数为 0', boardNoClass.body.stats.missing === 0,
  `missing=${boardNoClass.body.stats.missing}`)

// ---- 7. 列表按标签筛选 ----
console.log('\n[7] 列表按标签筛选')

// 当前：id1=other, id2=pass(88), id3=pass, id4=pass
const byFail = await j(`/api/admin/submissions?lesson_id=${lessonId}&review_label=fail`, {
  headers: H,
})
check('按 fail 筛选成功', byFail.status === 200)
check('fail 有 1 条（来自上一步的 partial 批量）', byFail.body.items.length === 1,
  `count=${byFail.body.items.length}`)

const byPass = await j(`/api/admin/submissions?lesson_id=${lessonId}&review_label=pass`, {
  headers: H,
})
check('按 pass 筛选有 3 条', byPass.body.items.length === 3, `count=${byPass.body.items.length}`)

const byUnreviewed = await j(
  `/api/admin/submissions?lesson_id=${lessonId}&review_label=unreviewed`,
  { headers: H },
)
check('按 unreviewed 筛选为 0 条', byUnreviewed.body.items.length === 0,
  `count=${byUnreviewed.body.items.length}`)

const badLabel = await j(`/api/admin/submissions?lesson_id=${lessonId}&review_label=bogus`, {
  headers: H,
})
check('非法标签被拒绝', badLabel.status === 400, `status=${badLabel.status}`)

// ---- 8. 参数与权限 ----
console.log('\n[8] 参数校验与权限')

const emptyReview = await j(`/api/admin/submissions/${id1}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({}),
})
check('空审阅请求被拒绝', emptyReview.status === 400, `status=${emptyReview.status}`)

const badLabelBody = await j(`/api/admin/submissions/${id1}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ label: 'excellent' }),
})
check('非法标签值被拒绝', badLabelBody.status === 400, `status=${badLabelBody.status}`)

const badStatus = await j(`/api/admin/submissions/${id1}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ status: 'done' }),
})
check('非法状态被拒绝', badStatus.status === 400, `status=${badStatus.status}`)

const missingSub = await j('/api/admin/submissions/99999999/review', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ label: 'pass' }),
})
check('不存在的提交返回 404', missingSub.status === 404, `status=${missingSub.status}`)

const noAuthReview = await j(`/api/admin/submissions/${id1}/review`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ label: 'pass' }),
})
check('未授权审阅返回 401', noAuthReview.status === 401, `status=${noAuthReview.status}`)

const noAuthBoard = await j(`/api/lessons/${lessonId}/review-board`)
check('未授权看板返回 401', noAuthBoard.status === 401, `status=${noAuthBoard.status}`)

const badLesson = await j('/api/lessons/99999999/review-board', { headers: H })
check('不存在的课时返回 404', badLesson.status === 404, `status=${badLesson.status}`)

// ---- 9. 状态与标签互不干扰 ----
console.log('\n[9] 状态与标签互不干扰')

const flagged = await j(`/api/admin/submissions/${id4}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ status: 'flagged' }),
})
check('显式标记问题成功', flagged.status === 200 && flagged.body.status === 'flagged',
  flagged.body.status)
check('显式状态不影响标签', flagged.body.review_label === 'pass', flagged.body.review_label)

const reLabel = await j(`/api/admin/submissions/${id4}/review`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ label: 'fail' }),
})
check('已标记问题的记录改标签后仍为 flagged', reLabel.body.status === 'flagged',
  reLabel.body.status)
check('标签已更新为 fail', reLabel.body.review_label === 'fail', reLabel.body.review_label)

// ---- 清理 ----
console.log('\n[清理] 删除测试数据')
await j(`/api/courses/${courseId}`, { method: 'DELETE', headers: H })
await j(`/api/classes/${classId}`, { method: 'DELETE', headers: H })
console.log('  已删除测试课程与班级')

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
}
