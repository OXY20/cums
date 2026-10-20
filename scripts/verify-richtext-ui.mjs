// 浏览器端验证富媒体编辑器。
//
// 用法：node scripts/verify-richtext-ui.mjs [baseUrl]
//
// 验证 Quill 编辑器实际渲染、工具栏可用、内容回填正确、
// 以及学生端富文本排版呈现。

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'
const CDP = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'

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

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const { token } = await loginRes.json()
if (!token) {
  console.error('登录失败')
  process.exit(2)
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

const courses = await api('/api/courses')
const course = courses.json.items.find((c) => c.title === '文字处理') ?? courses.json.items[0]
if (!course) {
  console.error('没有可用课程')
  process.exit(2)
}

/** 打开一个 CDP 页面并执行回调 */
async function withPage(url, fn) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
  const target = await res.json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)

  let nextId = 1
  const pending = new Map()
  const listeners = new Map()

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const handler = pending.get(message.id)
      if (handler) {
        pending.delete(message.id)
        message.error
          ? handler.reject(new Error(JSON.stringify(message.error)))
          : handler.resolve(message.result)
      }
      return
    }
    const handlers = listeners.get(message.method)
    if (handlers) for (const h of handlers) h(message.params)
  })

  const send = (method, params = {}) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  const on = (method, handler) => {
    if (!listeners.has(method)) listeners.set(method, [])
    listeners.get(method).push(handler)
  }

  const errors = []
  await send('Page.enable')
  await send('Runtime.enable')
  on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.text ?? 'unknown'))
  on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      errors.push(p.args?.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const loaded1 = new Promise((resolve) => on('Page.loadEventFired', resolve))
  await send('Page.navigate', { url: `${BASE}/login` })
  await Promise.race([loaded1, new Promise((r) => setTimeout(r, 12000))])
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('classroom.token', ${JSON.stringify(token)})`,
  })

  const loaded2 = new Promise((resolve) => on('Page.loadEventFired', resolve))
  await send('Page.navigate', { url })
  await Promise.race([loaded2, new Promise((r) => setTimeout(r, 15000))])
  await new Promise((r) => setTimeout(r, 3500))

  const evaluate = async (expression) => {
    const { result } = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    return result.value
  }

  try {
    await fn({ evaluate, errors })
  } finally {
    socket.close()
    await fetch(`${CDP}/json/close/${target.id}`).catch(() => {})
  }
}

console.log(`目标服务：${BASE}\n`)

// -------------------------------------------------------------------------
console.log('一、编辑器渲染与工具栏')
// -------------------------------------------------------------------------
await withPage(`${BASE}/admin/courses/${course.id}`, async ({ evaluate, errors }) => {
  check('Quill 编辑器已渲染', (await evaluate(`document.querySelectorAll('.ql-editor').length`)) > 0)
  check('工具栏已渲染', (await evaluate(`document.querySelectorAll('.ql-toolbar').length`)) > 0)

  // 检查工具栏各组按钮
  const groups = await evaluate(`(() => {
    const bar = document.querySelector('.ql-toolbar')
    if (!bar) return {}
    const q = (sel) => bar.querySelectorAll(sel).length
    return {
      size: q('.ql-size'),
      header: q('.ql-header'),
      bold: q('.ql-bold'),
      italic: q('.ql-italic'),
      underline: q('.ql-underline'),
      strike: q('.ql-strike'),
      color: q('.ql-color'),
      background: q('.ql-background'),
      listOrdered: q('.ql-list[value="ordered"]'),
      listBullet: q('.ql-list[value="bullet"]'),
      align: q('.ql-align'),
      blockquote: q('.ql-blockquote'),
      codeBlock: q('.ql-code-block'),
      link: q('.ql-link'),
      image: q('.ql-image'),
      video: q('.ql-video'),
      clean: q('.ql-clean'),
    }
  })()`)

  check('有字号选择器', groups.size > 0, JSON.stringify(groups))
  check('有标题选择器', groups.header > 0)
  check('有加粗', groups.bold > 0)
  check('有斜体', groups.italic > 0)
  check('有下划线', groups.underline > 0)
  check('有删除线', groups.strike > 0)
  check('有文字颜色', groups.color > 0)
  check('有背景色', groups.background > 0)
  check('有无序列表', groups.listBullet > 0)
  check('有有序列表', groups.listOrdered > 0)
  check('有对齐', groups.align > 0)
  check('有引用', groups.blockquote > 0)
  check('有代码块', groups.codeBlock > 0)
  check('有链接按钮', groups.link > 0)
  check('有图片按钮', groups.image > 0)
  check('有视频按钮', groups.video > 0)
  check('有清除格式', groups.clean > 0)
  check('无控制台错误', errors.length === 0, errors.join(' | '))
})

// -------------------------------------------------------------------------
console.log('\n二、已有内容正确回填')
// -------------------------------------------------------------------------
await withPage(`${BASE}/admin/courses/${course.id}`, async ({ evaluate, errors }) => {
  const info = await evaluate(`(() => {
    const editor = document.querySelector('.ql-editor')
    if (!editor) return null
    const html = editor.innerHTML
    return {
      html,
      text: editor.innerText,
      hasH2: editor.querySelectorAll('h2').length,
      hasStrong: editor.querySelectorAll('strong, b').length,
      hasList: editor.querySelectorAll('ul li, ol li').length,
      hasTable: editor.querySelectorAll('table').length,
      hasBlockquote: editor.querySelectorAll('blockquote').length,
      // Quill 2 把代码块渲染为 .ql-code-block-container 或 pre.ql-syntax
      hasCodeBlock:
        editor.querySelectorAll('.ql-code-block-container').length +
        editor.querySelectorAll('pre').length,
      hasLink: editor.querySelectorAll('a').length,
      hasColor: (html.match(/color:/g) || []).length,
      // 对齐可能来自内联样式或 Quill 的 class
      hasAlign:
        (html.match(/text-align/g) || []).length +
        editor.querySelectorAll('[class*="ql-align"]').length,
    }
  })()`)

  check('编辑器有内容', (info?.text?.length ?? 0) > 100, `文本长度 ${info?.text?.length}`)
  check('回填了标题', (info?.hasH2 ?? 0) >= 2, `h2 数量 ${info?.hasH2}`)
  check('回填了加粗', (info?.hasStrong ?? 0) > 0)
  check('回填了列表', (info?.hasList ?? 0) >= 5, `列表项 ${info?.hasList}`)
  check('回填了表格', (info?.hasTable ?? 0) > 0)
  check('回填了引用块', (info?.hasBlockquote ?? 0) > 0)
  check('回填了代码块', (info?.hasCodeBlock ?? 0) > 0, `代码块 ${info?.hasCodeBlock}`)
  check('回填了链接', (info?.hasLink ?? 0) > 0)
  check('回填了颜色样式', (info?.hasColor ?? 0) > 0)
  check('回填了居中对齐', (info?.hasAlign ?? 0) > 0, `对齐标记 ${info?.hasAlign}`)
  check('无控制台错误', errors.length === 0, errors.join(' | '))
})

// -------------------------------------------------------------------------
console.log('\n三、编辑并保存')
// -------------------------------------------------------------------------
const lessons = await api(`/api/courses/${course.id}/lessons`)
const lessonId = lessons.json.items[0]?.id

await withPage(`${BASE}/admin/courses/${course.id}`, async ({ evaluate, errors }) => {
  // 在编辑器末尾追加带格式的文字，然后点击保存
  const appended = await evaluate(`(() => {
    const editor = document.querySelector('.ql-editor')
    if (!editor) return false
    const quill = editor.__quill
    if (!quill) return false
    const length = quill.getLength()
    quill.insertText(length - 1, '\\n界面验证追加的段落', 'user')
    quill.formatLine(length, 1, { color: '#2563eb', size: 'large' }, 'user')
    return true
  })()`)

  check('可通过编辑器 API 修改内容', appended === true)

  // 点击保存按钮
  const clicked = await evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const target = buttons.find((b) => b.innerText.trim() === '保存正文')
    if (!target) return false
    target.click()
    return true
  })()`)
  check('找到并点击保存按钮', clicked === true)

  await new Promise((r) => setTimeout(r, 2500))
  check('无控制台错误', errors.length === 0, errors.join(' | '))
})

// 从接口确认内容已保存
const detail = await api(`/api/lessons/${lessonId}`)
check(
  '保存后正文包含追加内容',
  (detail.json?.content_html ?? '').includes('界面验证追加的段落'),
  (detail.json?.content_html ?? '').slice(-120),
)
check('保存后正文保留颜色', (detail.json?.content_html ?? '').includes('color'))
check('保存后格式为 html', detail.json?.content_format === 'html')

// -------------------------------------------------------------------------
console.log('\n四、学生端排版呈现')
// -------------------------------------------------------------------------
await withPage(`${BASE}/student/courses/${course.id}`, async ({ evaluate, errors }) => {
  const info = await evaluate(`(() => {
    const box = document.querySelector('.rich-content')
    if (!box) return null
    const style = (el) => (el ? getComputedStyle(el) : null)
    const h2 = box.querySelector('h2')
    const table = box.querySelector('table')
    const blockquote = box.querySelector('blockquote')
    return {
      hasBox: true,
      text: box.innerText.slice(0, 60),
      h2Size: h2 ? parseFloat(style(h2).fontSize) : 0,
      tableBorder: table ? style(table.querySelector('td') || table).borderBottomWidth : '',
      quoteBorder: blockquote ? style(blockquote).borderLeftWidth : '',
      imgCount: box.querySelectorAll('img').length,
      linkCount: box.querySelectorAll('a').length,
      listCount: box.querySelectorAll('ul li, ol li').length,
    }
  })()`)

  check('学生端渲染富文本容器', info?.hasBox === true)
  check('学生端显示正文', (info?.text?.length ?? 0) > 20, info?.text)
  check('标题有放大字号', (info?.h2Size ?? 0) > 18, `${info?.h2Size}px`)
  check('表格有边框', (info?.tableBorder ?? '0px') !== '0px', info?.tableBorder)
  check('引用块有左侧边框', (info?.quoteBorder ?? '0px') !== '0px', info?.quoteBorder)
  check('列表正常渲染', (info?.listCount ?? 0) > 0, `${info?.listCount} 项`)
  check('链接正常渲染', (info?.linkCount ?? 0) > 0)
  check('无控制台错误', errors.length === 0, errors.join(' | '))
})

console.log(`\n${'='.repeat(56)}`)
console.log(`合计 ${passed + failed} 项：通过 ${passed}，失败 ${failed}`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
}
console.log('='.repeat(56))

process.exit(failed === 0 ? 0 : 1)
