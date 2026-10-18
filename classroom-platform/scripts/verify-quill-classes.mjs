// 验证 Quill 2 的排版 class 在保存后是否保留。
//
// 用法：node scripts/verify-quill-classes.mjs [baseUrl]
//
// Quill 2 用 class 表达字号（ql-size-large）、对齐（ql-align-center）、
// 缩进（ql-indent-1）与代码块（ql-code-block-container）。
// 若服务端清洗丢弃这些 class，教师设置的排版会在保存后全部失效。

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
  body: { title: `Quill类测试-${suffix}` },
})
const lesson = await api(`/api/courses/${course.json.id}/lessons`, {
  method: 'POST',
  token,
  body: { title: '排版类验证' },
})
const lessonId = lesson.json.id

// Quill 2 的真实输出格式
const quillHtml = [
  '<p class="ql-align-center">居中的段落</p>',
  '<p class="ql-align-right">右对齐的段落</p>',
  '<p class="ql-align-justify">两端对齐的段落</p>',
  '<p><span class="ql-size-small">小号字</span></p>',
  '<p><span class="ql-size-large">大号字</span></p>',
  '<p><span class="ql-size-huge">超大号字</span></p>',
  '<p class="ql-indent-1">一级缩进</p>',
  '<p class="ql-indent-2">二级缩进</p>',
  '<div class="ql-code-block-container"><div class="ql-code-block">const a = 1</div></div>',
  '<pre class="ql-syntax">code line</pre>',
  // 危险 class 必须被丢弃
  '<p class="evil-class ql-align-center">混合类名</p>',
].join('')

const saved = await api(`/api/lessons/${lessonId}`, {
  method: 'PUT',
  token,
  body: { content_html: quillHtml },
})
check('保存成功', saved.status === 200)

const html = saved.json?.content_html ?? ''
console.log(`\n清洗后 HTML：\n${html}\n`)

check('保留居中对齐类', html.includes('ql-align-center'))
check('保留右对齐类', html.includes('ql-align-right'))
check('保留两端对齐类', html.includes('ql-align-justify'))
check('保留小号字类', html.includes('ql-size-small'))
check('保留大号字类', html.includes('ql-size-large'))
check('保留超大号字类', html.includes('ql-size-huge'))
check('保留缩进类', html.includes('ql-indent-1') && html.includes('ql-indent-2'))
check('保留代码块容器类', html.includes('ql-code-block-container'))
check('保留代码块行类', html.includes('ql-code-block'))
check('保留语法高亮类', html.includes('ql-syntax'))
check('丢弃非白名单类', !html.includes('evil-class'))

// 清理
await api(`/api/courses/${course.json.id}`, { method: 'DELETE', token })

console.log(`\n${'='.repeat(56)}`)
console.log(`合计 ${passed + failed} 项：通过 ${passed}，失败 ${failed}`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
}
console.log('='.repeat(56))

process.exit(failed === 0 ? 0 : 1)
