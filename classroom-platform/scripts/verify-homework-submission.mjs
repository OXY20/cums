/**
 * 作业提交接口端到端验证。
 *
 * 覆盖：登录 → 建班级/课程/课时 → 学生提交多文件 → 重复检测 →
 * 教师端列表/详情/审核 → 文件内嵌预览。
 *
 * 用法：node scripts/verify-homework-submission.mjs [baseUrl]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8090'

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

async function json(path, options = {}) {
  const response = await fetch(`${base}${path}`, options)
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body, headers: response.headers }
}

function auth(token) {
  return { Authorization: `Bearer ${token}` }
}

/** 构造一个指定类型的小文件 */
function makeFile(name, type, bytes) {
  return new File([new Uint8Array(bytes)], name, { type })
}

async function main() {
  console.log(`目标服务：${base}\n`)

  // ---- 登录 ----
  console.log('[1] 管理员登录')
  const login = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  check('登录成功', login.status === 200, `status=${login.status}`)
  const token = login.body?.token
  if (!token) throw new Error('无法获取令牌，后续用例中止')

  // ---- 准备数据 ----
  console.log('\n[2] 准备班级 / 课程 / 课时')
  const classRes = await json('/api/classes', {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `作业测试班-${Date.now()}`, room_name: '机房 A' }),
  })
  check('创建班级', classRes.status === 200 || classRes.status === 201, JSON.stringify(classRes.body))
  const classId = classRes.body?.id

  const courseRes = await json('/api/courses', {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `作业测试课程-${Date.now()}`, description: '用于验证作业提交' }),
  })
  check('创建课程', courseRes.status === 200 || courseRes.status === 201, JSON.stringify(courseRes.body))
  const courseId = courseRes.body?.id

  const lessonRes = await json(`/api/courses/${courseId}/lessons`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '第 1 课时 · 作业提交验证' }),
  })
  check('创建课时', lessonRes.status === 200 || lessonRes.status === 201, JSON.stringify(lessonRes.body))
  const lessonId = lessonRes.body?.id

  if (!classId || !courseId || !lessonId) throw new Error('基础数据创建失败，中止')

  // ---- 提交前状态查询 ----
  console.log('\n[3] 提交前状态查询')
  const status0 = await json(`/api/student/submissions/status?lesson_id=${lessonId}&class_id=${classId}`)
  check('查询课时提交状态', status0.status === 200, JSON.stringify(status0.body))
  check('初始本班无提交', status0.body?.class_total === 0, `class_total=${status0.body?.class_total}`)
  check('初始本设备无提交', status0.body?.device === null, JSON.stringify(status0.body?.device))

  // ---- 第一次提交：多文件 ----
  console.log('\n[4] 学生提交作业（3 个文件：图片 / 视频 / 文档）')
  const form = new FormData()
  form.append('student_name', '张三')
  form.append('note', '第一次提交，包含图片、视频和文档')
  form.append('lesson_id', String(lessonId))
  form.append('class_id', String(classId))
  form.append('file', makeFile('作业截图.png', 'image/png', 512))
  form.append('file', makeFile('演示视频.mp4', 'video/mp4', 4096))
  form.append('file', makeFile('实验报告.pdf', 'application/pdf', 2048))

  const submit1 = await json('/api/student/submissions', { method: 'POST', body: form })
  check('提交成功', submit1.status === 200, JSON.stringify(submit1.body).slice(0, 300))
  const sub1 = submit1.body?.submission
  check('返回 3 个文件', sub1?.files?.length === 3, `files=${sub1?.files?.length}`)
  check('记录提交人姓名', sub1?.student_name === '张三', `name=${sub1?.student_name}`)
  check('服务端记录 IP', typeof sub1?.client_ip === 'string' && sub1.client_ip.length > 0, `ip=${sub1?.client_ip}`)
  check('首次提交未标记重复', sub1?.duplicate_flag === 0, `flag=${sub1?.duplicate_flag}`)
  check('无重复警告', submit1.body?.duplicate_warning === null, `${submit1.body?.duplicate_warning}`)

  const purposes = (sub1?.files ?? []).map((f) => f.purpose).sort()
  check('文件用途正确推断', JSON.stringify(purposes) === JSON.stringify(['attachment', 'image', 'video']), JSON.stringify(purposes))

  // ---- 提交后状态查询 ----
  console.log('\n[5] 提交后状态查询')
  const status1 = await json(`/api/student/submissions/status?lesson_id=${lessonId}&class_id=${classId}`)
  check('本班统计到 1 条提交', status1.body?.class_total === 1, `class_total=${status1.body?.class_total}`)
  check('本设备（同 IP、无 device_id）也被识别', status1.body?.device !== null, JSON.stringify(status1.body?.device)?.slice(0, 80))
  check('本设备提交人为张三', status1.body?.device?.latest?.student_name === '张三', `${status1.body?.device?.latest?.student_name}`)

  // ---- 第二次提交：同班同课时 → 重复标记 ----
  console.log('\n[6] 同班同学再次提交（应触发重复提醒）')
  const form2 = new FormData()
  form2.append('student_name', '李四')
  form2.append('lesson_id', String(lessonId))
  form2.append('class_id', String(classId))
  form2.append('file', makeFile('李四作业.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1024))

  const submit2 = await json('/api/student/submissions', { method: 'POST', body: form2 })
  check('重复提交仍然保存成功', submit2.status === 200, JSON.stringify(submit2.body).slice(0, 200))
  const sub2 = submit2.body?.submission
  check('被标记为重复', sub2?.duplicate_flag === 1, `flag=${sub2?.duplicate_flag}`)
  check('记录了被重复的提交 ID', typeof sub2?.duplicate_of === 'number', `duplicate_of=${sub2?.duplicate_of}`)
  // 提示语改为中性表述：不指名道姓、不给时间，避免暴露其他同学信息
  check(
    '重复警告为中性文案',
    typeof submit2.body?.duplicate_warning === 'string' &&
      submit2.body.duplicate_warning.includes('重复') &&
      !submit2.body.duplicate_warning.includes('张三'),
    `${submit2.body?.duplicate_warning}`,
  )

  // ---- 参数校验 ----
  console.log('\n[7] 参数校验')
  const noName = new FormData()
  noName.append('lesson_id', String(lessonId))
  noName.append('file', makeFile('a.png', 'image/png', 16))
  const noNameRes = await json('/api/student/submissions', { method: 'POST', body: noName })
  check('缺少姓名被拒绝', noNameRes.status === 400, `status=${noNameRes.status}`)

  const noFile = new FormData()
  noFile.append('student_name', '王五')
  noFile.append('lesson_id', String(lessonId))
  const noFileRes = await json('/api/student/submissions', { method: 'POST', body: noFile })
  check('缺少文件被拒绝', noFileRes.status === 400, `status=${noFileRes.status}`)

  const badLesson = new FormData()
  badLesson.append('student_name', '王五')
  badLesson.append('lesson_id', '99999999')
  badLesson.append('file', makeFile('a.png', 'image/png', 16))
  const badLessonRes = await json('/api/student/submissions', { method: 'POST', body: badLesson })
  check('课时不存在被拒绝', badLessonRes.status === 404, `status=${badLessonRes.status}`)

  // ---- 教师端列表 ----
  console.log('\n[8] 教师端提交记录')
  const list = await json(`/api/admin/submissions?lesson_id=${lessonId}`, { headers: auth(token) })
  check('列表查询成功', list.status === 200, JSON.stringify(list.body).slice(0, 200))
  check('列表包含 2 条提交', list.body?.total === 2, `total=${list.body?.total}`)
  const firstRow = list.body?.items?.[0]
  check('列表带课程标题', typeof firstRow?.course_title === 'string' && firstRow.course_title.length > 0, `${firstRow?.course_title}`)
  check('列表带课时标题', typeof firstRow?.lesson_title === 'string' && firstRow.lesson_title.length > 0, `${firstRow?.lesson_title}`)
  check('列表带班级名称', typeof firstRow?.class_name === 'string' && firstRow.class_name.length > 0, `${firstRow?.class_name}`)
  check('列表带文件数', firstRow?.file_count >= 1, `count=${firstRow?.file_count}`)
  check('列表带 IP', typeof firstRow?.client_ip === 'string' && firstRow.client_ip.length > 0, `${firstRow?.client_ip}`)

  const dupList = await json(`/api/admin/submissions?lesson_id=${lessonId}&duplicate_only=true`, { headers: auth(token) })
  check('可按重复标记筛选', dupList.body?.total === 1, `total=${dupList.body?.total}`)
  check('筛选结果是李四', dupList.body?.items?.[0]?.student_name === '李四', `${dupList.body?.items?.[0]?.student_name}`)

  // ---- 未授权 ----
  const unauth = await json(`/api/admin/submissions?lesson_id=${lessonId}`)
  check('未授权访问被拒绝', unauth.status === 401, `status=${unauth.status}`)

  // ---- 教师端详情 ----
  console.log('\n[9] 教师端提交详情与审核')
  const detail = await json(`/api/admin/submissions/${sub1.id}`, { headers: auth(token) })
  check('详情查询成功', detail.status === 200, JSON.stringify(detail.body).slice(0, 200))
  check('详情含文件列表', detail.body?.files?.length === 3, `files=${detail.body?.files?.length}`)
  check('详情含 SHA-256', (detail.body?.files ?? []).every((f) => typeof f.sha256 === 'string' && f.sha256.length === 64), '')

  const review = await json(`/api/admin/submissions/${sub1.id}/review`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'reviewed' }),
  })
  check('审核状态更新成功', review.status === 200 && review.body?.status === 'reviewed', `status=${review.body?.status}`)

  const badReview = await json(`/api/admin/submissions/${sub1.id}/review`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'nonsense' }),
  })
  check('非法审核状态被拒绝', badReview.status === 400, `status=${badReview.status}`)

  // ---- 文件预览 ----
  console.log('\n[10] 文件内嵌预览')
  const imageFile = sub1.files.find((f) => f.purpose === 'image')
  const inlineRes = await fetch(`${base}/files/${imageFile.resource_id}?inline=1`)
  check('inline 预览可访问', inlineRes.status === 200, `status=${inlineRes.status}`)
  const disposition = inlineRes.headers.get('content-disposition') ?? ''
  check('Content-Disposition 为 inline', disposition.startsWith('inline'), disposition)
  check('Content-Type 为图片', (inlineRes.headers.get('content-type') ?? '').startsWith('image/'), inlineRes.headers.get('content-type'))

  const downloadRes = await fetch(`${base}/files/${imageFile.resource_id}`)
  const downloadDisposition = downloadRes.headers.get('content-disposition') ?? ''
  check('默认仍为附件下载', downloadDisposition.startsWith('attachment'), downloadDisposition)

  const rangeRes = await fetch(`${base}/files/${imageFile.resource_id}`, { headers: { Range: 'bytes=0-9' } })
  check('Range 请求仍返回 206', rangeRes.status === 206, `status=${rangeRes.status}`)

  // ---- 学生端回读 ----
  console.log('\n[11] 学生端上传后回读（用于弹窗预览）')
  const publicDetail = await json(`/api/student/submissions/${sub1.id}`)
  check('学生端可回读提交详情', publicDetail.status === 200, `status=${publicDetail.status}`)
  check('回读含文件列表', publicDetail.body?.files?.length === 3, `files=${publicDetail.body?.files?.length}`)

  // ---- 汇总 ----
  console.log(`\n${'='.repeat(50)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) {
    console.log('\n失败项：')
    for (const item of failures) console.log(`  - ${item}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('验证脚本异常：', err)
  process.exitCode = 1
})
