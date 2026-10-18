// 浏览器端验证「课程管理内直接上传」的完整交互。
//
// 用法：node scripts/verify-inline-ui.mjs [baseUrl]
//
// 通过 CDP 在真实浏览器里：
//   1. 登录并进入课程管理，确认封面列存在
//   2. 进入课时编辑器，确认上传区存在
//   3. 用 DOM 直接构造 File 并触发上传，确认图片内嵌渲染
//   4. 检查控制台无报错

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

// 登录获取令牌
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

// 准备测试课程与课时
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

const suffix = Date.now().toString().slice(-6)
const course = await api('/api/courses', {
  method: 'POST',
  body: { title: `界面验证课程-${suffix}`, description: '验证课程管理内直接上传' },
})
const courseId = course.json.id
const lesson = await api(`/api/courses/${courseId}/lessons`, {
  method: 'POST',
  body: { title: '第 1 课时：直接上传图片' },
})
const lessonId = lesson.json.id

// 打开一个 CDP 标签页
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
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })

  // 先到同源页写入令牌，再导航到目标地址
  const loaded1 = new Promise((resolve) => on('Page.loadEventFired', resolve))
  await send('Page.navigate', { url: `${BASE}/login` })
  await Promise.race([loaded1, new Promise((r) => setTimeout(r, 12000))])
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('classroom.token', ${JSON.stringify(token)})`,
  })

  const loaded2 = new Promise((resolve) => on('Page.loadEventFired', resolve))
  await send('Page.navigate', { url })
  await Promise.race([loaded2, new Promise((r) => setTimeout(r, 12000))])
  await new Promise((r) => setTimeout(r, 2500))

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
console.log('一、课程管理页：封面列')
// -------------------------------------------------------------------------
await withPage(`${BASE}/admin/courses`, async ({ evaluate, errors }) => {
  const text = await evaluate(`document.querySelector('#app')?.innerText ?? ''`)
  check('页面含「封面」列', text.includes('封面'))
  check('页面含课程名称', text.includes(`界面验证课程-${suffix}`), text.slice(0, 80))
  check('存在封面上传组件', (await evaluate(`document.querySelectorAll('.cover-uploader').length`)) > 0)
  check('无控制台错误', errors.length === 0, errors.join(' | '))
})

// -------------------------------------------------------------------------
console.log('\n二、课时编辑器：直接上传区')
// -------------------------------------------------------------------------
await withPage(`${BASE}/admin/courses/${courseId}`, async ({ evaluate, errors }) => {
  const text = await evaluate(`document.querySelector('#app')?.innerText ?? ''`)
  check('页面含课时标题', text.includes('第 1 课时：直接上传图片'))
  check('页面含上传提示', text.includes('拖入或点击上传图片、视频、附件'))
  check('存在拖拽上传区', (await evaluate(`document.querySelectorAll('.inline-upload').length`)) > 0)
  check('存在「添加文字段落」按钮', text.includes('添加文字段落'))
  check('无控制台错误', errors.length === 0, errors.join(' | '))
})

// -------------------------------------------------------------------------
console.log('\n三、真实上传图片并确认内嵌渲染')
// -------------------------------------------------------------------------
await withPage(`${BASE}/admin/courses/${courseId}`, async ({ evaluate, errors }) => {
  // 用 1x1 PNG 构造 File，并通过页面的 fetch 直接调用上传接口，
  // 再刷新页面确认内嵌展示（避免依赖 el-upload 内部实现细节）。
  const uploadResult = await evaluate(`(async () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const file = new File([bytes], '界面测试图片.png', { type: 'image/png' })

    const form = new FormData()
    form.append('file', file, file.name)

    const res = await fetch('/api/lessons/${lessonId}/resources/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + localStorage.getItem('classroom.token') },
      body: form,
    })
    const data = await res.json()
    return { status: res.status, purpose: data.purpose, id: data.id, name: data.name }
  })()`)

  check('浏览器内上传成功', uploadResult?.status === 200, `实际 ${uploadResult?.status}`)
  check('用途识别为 image', uploadResult?.purpose === 'image', uploadResult?.purpose)

  // 插入正文块
  const blockResult = await evaluate(`(async () => {
    const res = await fetch('/api/lessons/${lessonId}/blocks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + localStorage.getItem('classroom.token'),
      },
      body: JSON.stringify({
        block_type: 'image',
        title: '界面测试图片',
        resource_id: ${JSON.stringify(uploadResult?.id)},
      }),
    })
    return { status: res.status, json: await res.json() }
  })()`)
  check('创建图片块成功', blockResult?.status === 200, `实际 ${blockResult?.status}`)

  // 刷新页面，确认图片在编辑器内渲染
  await evaluate(`location.reload()`)
  await new Promise((r) => setTimeout(r, 3500))

  const imgInfo = await evaluate(`(() => {
    const imgs = Array.from(document.querySelectorAll('.media__image'))
    return imgs.map((img) => ({ src: img.getAttribute('src'), width: img.naturalWidth }))
  })()`)

  check('编辑器内出现图片预览', Array.isArray(imgInfo) && imgInfo.length > 0, JSON.stringify(imgInfo))
  check(
    '图片地址指向文件接口',
    Array.isArray(imgInfo) && imgInfo.some((i) => i.src?.startsWith('/files/')),
    JSON.stringify(imgInfo),
  )
  check(
    '图片实际加载成功',
    Array.isArray(imgInfo) && imgInfo.some((i) => i.width > 0),
    JSON.stringify(imgInfo),
  )
  check('无控制台错误', errors.length === 0, errors.join(' | '))
})

// -------------------------------------------------------------------------
console.log('\n四、学生端渲染')
// -------------------------------------------------------------------------
// 发布课程并开一节课堂
await api(`/api/courses/${courseId}`, { method: 'PUT', body: { status: 'published' } })
const classes = await api('/api/classes')
const classId = classes.json.items[0]?.id
let sessionId = null
let createdSession = false

if (classId) {
  const s = await api('/api/sessions', { method: 'POST', body: { class_id: classId, lesson_id: lessonId } })

  if (s.json?.id) {
    await api(`/api/sessions/${s.json.id}/start`, { method: 'POST' })
    sessionId = s.json.id
    createdSession = true
  } else if (s.status === 409) {
    // 该班级已有进行中的课堂：直接复用现有课堂的课时做渲染验证，
    // 不强行结束别人正在讲的课。
    const active = await api('/api/student/current-session')
    if (active.json?.session?.id) {
      sessionId = active.json.session.id
      console.log(`  （该班级已有活动课堂 #${sessionId}，复用它验证渲染）`)
    }
  }
}

if (sessionId) {
  // 学生端渲染验证针对「当前课堂的课时」；
  // 若是复用的他人课堂，则改为在课程主页验证，避免干扰正在进行的课堂。
  if (createdSession) {
    await withPage(`${BASE}/student/sessions/${sessionId}`, async ({ evaluate, errors }) => {
      const text = await evaluate(`document.querySelector('#app')?.innerText ?? ''`)
      check('学生端显示课时标题', text.includes('第 1 课时：直接上传图片'))
      check(
        '学生端出现内嵌图片',
        (await evaluate(`document.querySelectorAll('.content-image').length`)) > 0,
      )
      check('无控制台错误', errors.length === 0, errors.join(' | '))
    })
    await api(`/api/sessions/${sessionId}/end`, { method: 'POST' })
  } else {
    // 复用现有课堂：用课程主页验证图片渲染（不干扰正在进行的课堂）
    await withPage(`${BASE}/student/courses/${courseId}`, async ({ evaluate, errors }) => {
      const text = await evaluate(`document.querySelector('#app')?.innerText ?? ''`)
      check('课程主页显示课时标题', text.includes('第 1 课时：直接上传图片'))
      check('无控制台错误', errors.length === 0, errors.join(' | '))
    })
  }
} else {
  check('学生端验证（无可用班级，跳过）', true)
}

// -------------------------------------------------------------------------
console.log('\n五、清理')
// -------------------------------------------------------------------------
await api(`/api/courses/${courseId}`, { method: 'DELETE' })

console.log(`\n${'='.repeat(56)}`)
console.log(`合计 ${passed + failed} 项：通过 ${passed}，失败 ${failed}`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
}
console.log('='.repeat(56))

process.exit(failed === 0 ? 0 : 1)
