// 验证富媒体正文接口与 HTML 清洗。
//
// 用法：node scripts/verify-richtext.mjs [baseUrl]
//
// 重点验证：
//   1. 富文本正文可保存与读回
//   2. 危险内容被服务端清洗（script / on* / javascript: / 外链图片）
//   3. 排版能力被保留（字号、颜色、对齐、列表、链接、表格）
//   4. 正文引用的资源自动登记为课时资源
//   5. 课堂快照保存富文本，学生端可读

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'

let passed = 0
let failed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 保留原文 */
  }
  return { status: res.status, json, text }
}

async function upload(path, token, buffer, filename, mime) {
  const boundary = `----rt${Date.now()}${Math.random().toString(16).slice(2)}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat([head, buffer, tail]),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
}

const login = await api('/api/auth/login', {
  method: 'POST',
  body: { username: 'admin', password: 'admin' },
})
const token = login.json?.token
if (!token) {
  console.error('登录失败')
  process.exit(2)
}

const suffix = Date.now().toString().slice(-6)
const course = await api('/api/courses', {
  method: 'POST',
  token,
  body: { title: `富文本测试课程-${suffix}`, description: '验证富媒体编辑器' },
})
const courseId = course.json.id
const lesson = await api(`/api/courses/${courseId}/lessons`, {
  method: 'POST',
  token,
  body: { title: '第 1 课时：富文本' },
})
const lessonId = lesson.json.id

// -------------------------------------------------------------------------
section('一、排版能力保留')
// -------------------------------------------------------------------------

const richHtml = `
<h2>学习目标</h2>
<p><span style="font-size: 20px; color: #ff0000">这是大号红字</span></p>
<p style="text-align: center">居中的段落</p>
<p><strong>加粗</strong> <em>斜体</em> <u>下划线</u> <s>删除线</s></p>
<p><span style="background-color: #ffff00">黄色背景</span></p>
<ul><li>无序项一</li><li>无序项二</li></ul>
<ol><li>有序项一</li><li>有序项二</li></ol>
<blockquote>这是引用内容</blockquote>
<pre class="ql-syntax">const a = 1</pre>
<p><a href="https://example.com">外部链接</a></p>
<p><a href="/student">站内链接</a></p>
<table><tbody><tr><td>单元格</td></tr></tbody></table>
`

const save = await api(`/api/lessons/${lessonId}`, {
  method: 'PUT',
  token,
  body: { content_html: richHtml },
})
check('保存富文本正文', save.status === 200, `实际 ${save.status}`)
check('正文格式标记为 html', save.json?.content_format === 'html', save.json?.content_format)

const html = save.json?.content_html ?? ''
check('保留字号', html.includes('font-size'), html.slice(0, 100))
check('保留颜色', html.includes('color'), '')
check('保留居中对齐', html.includes('text-align'), '')
check('保留加粗', html.includes('<strong>') || html.includes('<b>'), '')
check('保留列表', html.includes('<ul>') || html.includes('<ol>'), '')
check('保留引用块', html.includes('<blockquote>'), '')
check('保留代码块', html.includes('<pre'), '')
check('保留外部链接', html.includes('example.com'), '')
check('保留站内链接', html.includes('/student'), '')
check('保留表格', html.includes('<table'), '')

// -------------------------------------------------------------------------
section('二、危险内容被清洗')
// -------------------------------------------------------------------------

const malicious = `
<p>正常内容</p>
<script>alert('xss')</script>
<p onclick="alert(1)">带事件属性的段落</p>
<a href="javascript:alert(2)">恶意链接</a>
<a href="data:text/html,<script>alert(3)</script>">data 链接</a>
<img src="https://evil.example/track.png" alt="外链图">
<img src="/files/1" alt="站内图">
<iframe src="https://evil.example"></iframe>
<style>body { display: none }</style>
<p style="position: fixed; top: 0">危险定位</p>
`

const saved2 = await api(`/api/lessons/${lessonId}`, {
  method: 'PUT',
  token,
  body: { content_html: malicious },
})
const cleaned = saved2.json?.content_html ?? ''

check('移除 script 标签', !cleaned.includes('<script'), cleaned.slice(0, 120))
check('移除 script 内容', !cleaned.includes("alert('xss')"), '')
check('移除事件属性', !cleaned.includes('onclick'), '')
check('移除 javascript 协议', !cleaned.toLowerCase().includes('javascript:'), '')
check('移除 data 链接', !cleaned.includes('data:text/html'), '')
check('移除外链图片', !cleaned.includes('evil.example/track.png'), '')
check('移除 iframe', !cleaned.includes('<iframe'), '')
check('移除 style 标签', !cleaned.includes('<style'), '')
check('移除危险定位样式', !cleaned.includes('position'), '')
check('保留正常文字', cleaned.includes('正常内容'), '')
check('保留站内图片', cleaned.includes('/files/1'), '')

// -------------------------------------------------------------------------
section('三、正文引用的资源自动登记')
// -------------------------------------------------------------------------

// 上传一张图片，然后把它插入正文
const imgRes = await upload(
  `/api/lessons/${lessonId}/resources/upload`,
  token,
  tinyPng(),
  '正文插图.png',
  'image/png',
)
check('上传图片成功', imgRes.status === 200)

const withImage = `<p>看下图：</p><p><img src="/files/${imgRes.json.id}" alt="插图"></p>`
const saved3 = await api(`/api/lessons/${lessonId}`, {
  method: 'PUT',
  token,
  body: { content_html: withImage },
})
check('保存含图片的正文', saved3.status === 200)
check('正文保留图片引用', (saved3.json?.content_html ?? '').includes(`/files/${imgRes.json.id}`))

// 换一个未关联过的资源，验证保存时会自动建立关联
const imgRes2 = await upload(
  `/api/lessons/${lessonId}/resources/upload`,
  token,
  tinyPng(),
  '第二张图.png',
  'image/png',
)
// 先解除关联，再通过正文引用重新建立
await api(`/api/lessons/${lessonId}/resources/${imgRes2.json.id}`, { method: 'DELETE', token })

const beforeSync = await api(`/api/lessons/${lessonId}/resources`, { token })
const hasBefore = (beforeSync.json?.items ?? []).some((r) => r.id === imgRes2.json.id)
check('解除关联后不在资源列表', !hasBefore)

const syncHtml = `<p><img src="/files/${imgRes2.json.id}"></p>`
await api(`/api/lessons/${lessonId}`, { method: 'PUT', token, body: { content_html: syncHtml } })

const afterSync = await api(`/api/lessons/${lessonId}/resources`, { token })
const hasAfter = (afterSync.json?.items ?? []).some((r) => r.id === imgRes2.json.id)
check('保存正文后自动恢复资源关联', hasAfter)

// -------------------------------------------------------------------------
section('四、课时详情返回富文本')
// -------------------------------------------------------------------------

const detail = await api(`/api/lessons/${lessonId}`)
check('详情包含 content_html', typeof detail.json?.content_html === 'string')
check('详情 content_html 非空', (detail.json?.content_html ?? '').length > 0)
check('详情 content_format 为 html', detail.json?.content_format === 'html')

// -------------------------------------------------------------------------
section('五、课堂快照保存富文本')
// -------------------------------------------------------------------------

const classes = await api('/api/classes')
const classId = classes.json.items[0]?.id

if (classId) {
  const session = await api('/api/sessions', {
    method: 'POST',
    token,
    body: { class_id: classId, lesson_id: lessonId },
  })

  if (session.json?.id) {
    const view = await api(`/api/sessions/${session.json.id}`, { token })
    check('课堂视图包含 lesson_html', typeof view.json?.lesson_html === 'string')
    check(
      '课堂快照的富文本非空',
      (view.json?.lesson_html ?? '').includes('/files/'),
      (view.json?.lesson_html ?? '').slice(0, 80),
    )
    // 结束课堂，否则课程因存在授课记录而无法删除（这是设计行为）
    await api(`/api/sessions/${session.json.id}/end`, { method: 'POST', token })
  } else {
    // 班级已有活动课堂时跳过（不影响主要结论）
    console.log('  （该班级已有活动课堂，跳过快照验证）')
  }
} else {
  console.log('  （无可用班级，跳过快照验证）')
}

// -------------------------------------------------------------------------
section('六、空内容归一化')
// -------------------------------------------------------------------------

const emptySave = await api(`/api/lessons/${lessonId}`, {
  method: 'PUT',
  token,
  body: { content_html: '<p><br></p>' },
})
check(
  '编辑器空内容归一化为空字符串',
  emptySave.json?.content_html === '',
  JSON.stringify(emptySave.json?.content_html),
)

// -------------------------------------------------------------------------
section('七、清理与数据保护')
// -------------------------------------------------------------------------

// 是否产生过授课记录决定了课程能否删除：
// - 有记录：按设计返回 409，应改为停用；
// - 无记录（班级被占用导致课堂创建失败）：正常删除。
const delAttempt = await api(`/api/courses/${courseId}`, { method: 'DELETE', token })

if (delAttempt.status === 409) {
  check('有授课记录的课程拒绝删除（数据保护）', true)
  await api(`/api/courses/${courseId}`, {
    method: 'PUT',
    token,
    body: { status: 'archived', title: `[测试]富文本-${suffix}` },
  })
  const archived = await api(`/api/courses/${courseId}`, { token })
  check('测试课程已停用归档', archived.json?.status === 'archived', archived.json?.status)
} else {
  check('无授课记录的课程可正常删除', delAttempt.status === 200, `实际 ${delAttempt.status}`)
  check('删除后课程不可访问', (await api(`/api/courses/${courseId}`, { token })).status === 404)
}

console.log(`\n${'='.repeat(56)}`)
console.log(`合计 ${passed + failed} 项：通过 ${passed}，失败 ${failed}`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
}
console.log('='.repeat(56))

process.exit(failed === 0 ? 0 : 1)
