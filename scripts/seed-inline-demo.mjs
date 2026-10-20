// 为「直接上传」功能准备可视演示数据。
//
// 用法：node scripts/seed-inline-demo.mjs [baseUrl]
//
// 生成真实可渲染的图片（PNG）与视频占位内容，插入课时正文，
// 便于人工查看编辑器的内嵌预览效果。

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'

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
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

async function upload(path, token, buffer, filename, mime) {
  const boundary = `----seed${Date.now()}${Math.random().toString(16).slice(2)}`
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

/**
 * 生成一张纯色 PNG（带简单渐变），用于封面与插图。
 *
 * 手写 PNG 编码：IHDR + IDAT(zlib stored) + IEND，避免引入图像库依赖。
 */
function makePng(width, height, rgb) {
  const { deflateSync } = require_zlib()
  const bytesPerRow = 1 + width * 3
  const raw = Buffer.alloc(bytesPerRow * height)

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * bytesPerRow
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < width; x += 1) {
      // 斜向渐变，便于肉眼确认图片确实渲染
      const t = (x / width + y / height) / 2
      const offset = rowStart + 1 + x * 3
      raw[offset] = Math.round(rgb[0] * (0.55 + 0.45 * t))
      raw[offset + 1] = Math.round(rgb[1] * (0.55 + 0.45 * t))
      raw[offset + 2] = Math.round(rgb[2] * (0.55 + 0.45 * t))
    }
  }

  const idat = deflateSync(raw)

  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0)
    return Buffer.concat([length, typeBuf, data, crcBuf])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 延迟引入 zlib，保持脚本头部简洁 */
function require_zlib() {
  return globalThis.__zlib ?? (globalThis.__zlib = zlibModule())
}

function zlibModule() {
  // Node 内置模块；使用动态 import 的同步等价写法
  return process.getBuiltinModule('node:zlib')
}

/** CRC32，PNG 规范要求 */
function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

const login = await api('/api/auth/login', {
  method: 'POST',
  body: { username: 'admin', password: 'admin' },
})
const token = login.json.token
console.log('已登录')

// 找一门课程
const courses = await api('/api/courses', { token })
const target = courses.json.items.find((c) => c.title === '文字处理') ?? courses.json.items[0]
if (!target) {
  console.error('没有可用课程')
  process.exit(1)
}
console.log(`目标课程：#${target.id} ${target.title}`)

// 上传封面
const cover = makePng(480, 270, [37, 99, 235])
const coverRes = await upload(`/api/courses/${target.id}/cover`, token, cover, '课程封面.png', 'image/png')
console.log('封面上传:', coverRes.status, coverRes.json?.cover_resource_id ? '成功' : coverRes.json)

// 取第一课时
const lessons = await api(`/api/courses/${target.id}/lessons`, { token })
const lesson = lessons.json.items[0]
if (!lesson) {
  console.error('没有可用课时')
  process.exit(1)
}
console.log(`目标课时：#${lesson.id} ${lesson.title}`)

// 清空该课时已有的块，避免重复叠加
const existing = await api(`/api/lessons/${lesson.id}/blocks`, { token })
for (const block of existing.json.items ?? []) {
  await api(`/api/blocks/${block.id}`, { method: 'DELETE', token })
}

// 1. 文字块
await api(`/api/lessons/${lesson.id}/blocks`, {
  method: 'POST',
  token,
  body: {
    block_type: 'text',
    title: '学习目标',
    text_content: '掌握在文档中插入图片并设置环绕方式的方法，能够独立完成一份图文混排的自我介绍文档。',
  },
})

// 2. 图片块（直接上传后插入）
const image = makePng(640, 360, [16, 185, 129])
const imgRes = await upload(`/api/lessons/${lesson.id}/resources/upload`, token, image, '图文混排示例.png', 'image/png')
console.log('图片上传:', imgRes.status, imgRes.json?.purpose)
if (imgRes.json?.id) {
  await api(`/api/lessons/${lesson.id}/blocks`, {
    method: 'POST',
    token,
    body: { block_type: 'image', title: '图文混排示例', resource_id: imgRes.json.id },
  })
}

// 3. 视频块（用 PNG 内容冒充视频文件，仅用于验证内嵌播放器的 DOM 结构；
//    真实视频请通过界面拖入上传）
const videoBytes = Buffer.alloc(64 * 1024, 0)
const vidRes = await upload(`/api/lessons/${lesson.id}/resources/upload`, token, videoBytes, '示范操作.mp4', 'video/mp4')
console.log('视频上传:', vidRes.status, vidRes.json?.purpose)
if (vidRes.json?.id) {
  await api(`/api/lessons/${lesson.id}/blocks`, {
    method: 'POST',
    token,
    body: { block_type: 'video', title: '示范操作', resource_id: vidRes.json.id },
  })
}

// 4. 文字块
await api(`/api/lessons/${lesson.id}/blocks`, {
  method: 'POST',
  token,
  body: {
    block_type: 'text',
    title: '操作步骤',
    text_content: '1. 打开练习文档；\n2. 插入图片并调整大小；\n3. 设置环绕方式为「四周型」；\n4. 保存并提交。',
  },
})

// 5. 附件
const attachRes = await upload(
  `/api/lessons/${lesson.id}/resources/upload`,
  token,
  Buffer.from('这是练习素材文件的示例内容。\n', 'utf8'),
  '练习素材.txt',
  'text/plain',
)
console.log('附件上传:', attachRes.status, attachRes.json?.purpose)

const finalBlocks = await api(`/api/lessons/${lesson.id}/blocks`, { token })
console.log(`\n课时正文块共 ${finalBlocks.json.total} 个：`)
for (const b of finalBlocks.json.items) {
  console.log(`  - ${b.block_type}: ${b.title || b.text_content.slice(0, 20)}`)
}

console.log('\n演示数据准备完成')
