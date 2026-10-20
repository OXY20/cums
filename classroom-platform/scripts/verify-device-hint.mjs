/**
 * 验证「当前设备已提交」提示与多设备区分。
 *
 * 用法：node scripts/verify-device-hint.mjs [baseUrl]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8080'

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
  const r = await fetch(`${base}${path}`, options)
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
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
  body: JSON.stringify({ name: `设备测试班-${stamp}` }),
})
const course = await j('/api/courses', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: `设备测试课程-${stamp}` }),
})
const lesson = await j(`/api/courses/${course.body.id}/lessons`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title: '第 1 课时 · 设备识别' }),
})
const lessonId = lesson.body.id

console.log(`测试课时 #${lessonId}\n`)

/** 用指定设备标识提交 */
async function submitAs(name, deviceId) {
  const form = new FormData()
  form.append('student_name', name)
  form.append('lesson_id', String(lessonId))
  form.append('class_id', String(cls.body.id))
  if (deviceId) form.append('device_id', deviceId)
  form.append('file', new File([new Uint8Array([1, 2, 3])], 'test.txt', { type: 'text/plain' }))
  return j('/api/student/submissions', { method: 'POST', body: form })
}

console.log('[1] 设备 A 提交前查询（应无提交）')
const s0 = await j(`/api/student/submissions/status?lesson_id=${lessonId}&class_id=${cls.body.id}&device_id=DEV-A`)
check('状态查询成功', s0.status === 200, JSON.stringify(s0.body).slice(0, 120))
check('本班总数为 0', s0.body?.class_total === 0, `class_total=${s0.body?.class_total}`)
check('当前设备无提交', s0.body?.device === null, JSON.stringify(s0.body?.device))

console.log('\n[2] 设备 A 提交')
const a1 = await submitAs('张三', 'DEV-A')
check('提交成功', a1.status === 200, JSON.stringify(a1.body).slice(0, 150))
check('记录设备标识', a1.body?.submission?.device_id === 'DEV-A', `device_id=${a1.body?.submission?.device_id}`)

console.log('\n[3] 设备 A 再次查询（应提示本设备已提交）')
const s1 = await j(`/api/student/submissions/status?lesson_id=${lessonId}&class_id=${cls.body.id}&device_id=DEV-A`)
check('设备 A 已被识别出提交', s1.body?.device !== null, JSON.stringify(s1.body?.device))
check('设备提交通数为 1', s1.body?.device?.total === 1, `total=${s1.body?.device?.total}`)
check('返回该设备最近提交人', s1.body?.device?.latest?.student_name === '张三', `${s1.body?.device?.latest?.student_name}`)
check('本班总数为 1', s1.body?.class_total === 1, `class_total=${s1.body?.class_total}`)

console.log('\n[4] 设备 B 查询（同班但不同设备，不应被告知已提交）')
const s2 = await j(`/api/student/submissions/status?lesson_id=${lessonId}&class_id=${cls.body.id}&device_id=DEV-B`)
check('设备 B 无提交记录', s2.body?.device === null, JSON.stringify(s2.body?.device))
check('但能看到本班已有 1 份', s2.body?.class_total === 1, `class_total=${s2.body?.class_total}`)

console.log('\n[5] 设备 B 提交后，各自独立识别')
const b1 = await submitAs('李四', 'DEV-B')
check('设备 B 提交成功', b1.status === 200, JSON.stringify(b1.body).slice(0, 120))

const sA = await j(`/api/student/submissions/status?lesson_id=${lessonId}&class_id=${cls.body.id}&device_id=DEV-A`)
const sB = await j(`/api/student/submissions/status?lesson_id=${lessonId}&class_id=${cls.body.id}&device_id=DEV-B`)
check('设备 A 只看到自己的 1 次', sA.body?.device?.total === 1, `A total=${sA.body?.device?.total}`)
check('设备 A 的提交人仍是张三', sA.body?.device?.latest?.student_name === '张三', `${sA.body?.device?.latest?.student_name}`)
check('设备 B 只看到自己的 1 次', sB.body?.device?.total === 1, `B total=${sB.body?.device?.total}`)
check('设备 B 的提交人是李四', sB.body?.device?.latest?.student_name === '李四', `${sB.body?.device?.latest?.student_name}`)
check('本班总数变为 2', sB.body?.class_total === 2, `class_total=${sB.body?.class_total}`)

console.log('\n[6] 设备 A 二次提交（自己覆盖自己，仍标记重复但只影响自己视角）')
const a2 = await submitAs('张三', 'DEV-A')
check('二次提交成功', a2.status === 200, '')
const sA2 = await j(`/api/student/submissions/status?lesson_id=${lessonId}&class_id=${cls.body.id}&device_id=DEV-A`)
check('设备 A 现在显示 2 次', sA2.body?.device?.total === 2, `total=${sA2.body?.device?.total}`)

console.log('\n[7] 无 device_id 时退化为按 IP 识别')
const sNoDev = await j(`/api/student/submissions/status?lesson_id=${lessonId}&class_id=${cls.body.id}`)
check('缺省 device_id 仍能查出本 IP 的提交', sNoDev.body?.device !== null, JSON.stringify(sNoDev.body?.device)?.slice(0, 80))
check('按 IP 统计到全部 3 次', sNoDev.body?.device?.total === 3, `total=${sNoDev.body?.device?.total}`)

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
}
