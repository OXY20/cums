// 验证「课程管理内直接上传」相关接口。
//
// 用法：node scripts/verify-inline-upload.mjs [baseUrl]
//
// 覆盖：
//   1. 课程封面上传 / 替换 / 清除 / 拒绝非图片
//   2. 课时内直接上传图片、视频、附件（一步完成，自动关联并推断用途）
//   3. 课时正文块（文字/图片/视频）增删改与排序
//   4. 课时详情一次返回块与资源

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

/** 上传文件到指定端点（multipart） */
async function upload(path, token, buffer, filename, mime) {
  const boundary = `----inline${Date.now()}${Math.random().toString(16).slice(2)}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([head, buffer, tail])

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
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

/** 生成最小合法 PNG（1x1 像素） */
function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
}

async function main() {
  console.log(`目标服务：${BASE}`)

  const loginRes = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin' },
  })
  const token = loginRes.json?.token
  if (!token) {
    console.error('登录失败')
    process.exit(2)
  }

  const suffix = Date.now().toString().slice(-6)
  const course = await api('/api/courses', {
    method: 'POST',
    token,
    body: { title: `直传测试课程-${suffix}`, description: '验证课程管理内直接上传' },
  })
  const courseId = course.json.id

  const lesson = await api(`/api/courses/${courseId}/lessons`, {
    method: 'POST',
    token,
    body: { title: '第 1 课时：直接上传' },
  })
  const lessonId = lesson.json.id

  // -------------------------------------------------------------------------
  section('一、课程封面直接上传')
  // -------------------------------------------------------------------------

  const png = tinyPng()
  const coverUpload = await upload(`/api/courses/${courseId}/cover`, token, png, 'cover.png', 'image/png')
  check(
    '上传封面成功',
    coverUpload.status === 200,
    `实际 ${coverUpload.status} ${coverUpload.text.slice(0, 120)}`,
  )
  check('课程返回封面资源 ID', typeof coverUpload.json?.cover_resource_id === 'number')
  const coverId = coverUpload.json?.cover_resource_id

  const coverFetch = await fetch(`${BASE}/files/${coverId}`)
  const coverBytes = Buffer.from(await coverFetch.arrayBuffer())
  check('封面可通过文件接口访问', coverFetch.status === 200)
  check('封面内容与上传一致', coverBytes.equals(png))
  check(
    '封面 MIME 为图片类型',
    (coverFetch.headers.get('content-type') ?? '').startsWith('image/'),
    coverFetch.headers.get('content-type'),
  )

  const png2 = Buffer.concat([png, Buffer.from([0])])
  const coverReplace = await upload(`/api/courses/${courseId}/cover`, token, png2, 'cover2.png', 'image/png')
  check('替换封面成功', coverReplace.status === 200)
  const newCoverId = coverReplace.json?.cover_resource_id
  check('封面资源 ID 已更新', newCoverId !== coverId, `旧 ${coverId} → 新 ${newCoverId}`)

  const oldCoverFetch = await fetch(`${BASE}/files/${coverId}`)
  check('旧封面文件已清理', oldCoverFetch.status === 404, `实际 ${oldCoverFetch.status}`)

  const notImage = await upload(
    `/api/courses/${courseId}/cover`,
    token,
    Buffer.alloc(256, 1),
    'not-image.bin',
    'application/octet-stream',
  )
  check('拒绝非图片作为封面', notImage.status === 400, `实际 ${notImage.status}`)

  const clearCover = await api(`/api/courses/${courseId}/cover`, { method: 'DELETE', token })
  check('清除封面成功', clearCover.status === 200 && clearCover.json?.cover_resource_id === null)

  // -------------------------------------------------------------------------
  section('二、课时内直接上传（一步完成）')
  // -------------------------------------------------------------------------

  const imgUpload = await upload(
    `/api/lessons/${lessonId}/resources/upload`,
    token,
    tinyPng(),
    '插图.png',
    'image/png',
  )
  check(
    '课时内上传图片成功',
    imgUpload.status === 200,
    `实际 ${imgUpload.status} ${imgUpload.text.slice(0, 120)}`,
  )
  check('图片用途自动识别为 image', imgUpload.json?.purpose === 'image', `实际 ${imgUpload.json?.purpose}`)
  check('图片已自动关联到课时', typeof imgUpload.json?.id === 'number')
  check('资源状态为可用', imgUpload.json?.status === 'ready')
  check('保留上传时的文件名', imgUpload.json?.name === '插图.png', imgUpload.json?.name)
  check('MIME 修正为 image/png', imgUpload.json?.mime_type === 'image/png', imgUpload.json?.mime_type)
  const imageResourceId = imgUpload.json?.id

  // 上传一个带 mp4 扩展名的视频（内容不重要，验证类型推断与 MIME 修正）
  const fakeVideo = Buffer.alloc(4096, 7)
  const videoUpload = await upload(
    `/api/lessons/${lessonId}/resources/upload`,
    token,
    fakeVideo,
    '示范视频.mp4',
    'video/mp4',
  )
  check('课时内上传视频成功', videoUpload.status === 200)
  check('视频用途自动识别为 video', videoUpload.json?.purpose === 'video', `实际 ${videoUpload.json?.purpose}`)
  check('视频 MIME 为 video/mp4', videoUpload.json?.mime_type === 'video/mp4', videoUpload.json?.mime_type)
  const videoResourceId = videoUpload.json?.id

  const fileUpload = await upload(
    `/api/lessons/${lessonId}/resources/upload`,
    token,
    Buffer.from('练习素材内容', 'utf8'),
    '练习素材.txt',
    'text/plain',
  )
  check('课时内上传附件成功', fileUpload.status === 200)
  check(
    '文本附件用途识别为 attachment',
    fileUpload.json?.purpose === 'attachment',
    `实际 ${fileUpload.json?.purpose}`,
  )

  const lessonRes = await api(`/api/lessons/${lessonId}/resources`)
  check('课时资源列表包含三个资源', lessonRes.json?.total === 3, `实际 ${lessonRes.json?.total}`)
  check(
    '资源按用途区分',
    lessonRes.json.items.filter((r) => r.purpose === 'image').length === 1 &&
      lessonRes.json.items.filter((r) => r.purpose === 'video').length === 1 &&
      lessonRes.json.items.filter((r) => r.purpose === 'attachment').length === 1,
  )

  // -------------------------------------------------------------------------
  section('三、课时正文块')
  // -------------------------------------------------------------------------

  const textBlock = await api(`/api/lessons/${lessonId}/blocks`, {
    method: 'POST',
    token,
    body: { block_type: 'text', title: '学习目标', text_content: '掌握图文混排的基本方法' },
  })
  check('创建文字块', textBlock.status === 200 && textBlock.json?.block_type === 'text')

  const imageBlock = await api(`/api/lessons/${lessonId}/blocks`, {
    method: 'POST',
    token,
    body: {
      block_type: 'image',
      title: '示意图',
      resource_id: imageResourceId,
    },
  })
  check('创建图片块', imageBlock.status === 200 && imageBlock.json?.block_type === 'image')
  check('图片块带回资源名称', imageBlock.json?.resource_name === '插图.png', imageBlock.json?.resource_name)

  const videoBlock = await api(`/api/lessons/${lessonId}/blocks`, {
    method: 'POST',
    token,
    body: { block_type: 'video', title: '示范视频', resource_id: videoResourceId },
  })
  check('创建视频块', videoBlock.status === 200 && videoBlock.json?.block_type === 'video')

  const blocks = await api(`/api/lessons/${lessonId}/blocks`)
  check('正文块按顺序返回', blocks.json?.total === 3, `实际 ${blocks.json?.total}`)
  check(
    '块顺序为 文字 → 图片 → 视频',
    blocks.json.items.map((b) => b.block_type).join(',') === 'text,image,video',
    blocks.json.items.map((b) => b.block_type).join(','),
  )

  const emptyText = await api(`/api/lessons/${lessonId}/blocks`, {
    method: 'POST',
    token,
    body: { block_type: 'text', text_content: '   ' },
  })
  check('拒绝空文字块', emptyText.status === 400, `实际 ${emptyText.status}`)

  const blockNoResource = await api(`/api/lessons/${lessonId}/blocks`, {
    method: 'POST',
    token,
    body: { block_type: 'image' },
  })
  check('拒绝无资源的媒体块', blockNoResource.status === 400, `实际 ${blockNoResource.status}`)

  // 重排：把视频放到最前
  const ids = blocks.json.items.map((b) => b.id)
  const reorder = await api(`/api/lessons/${lessonId}/blocks/reorder`, {
    method: 'PUT',
    token,
    body: { block_ids: [ids[2], ids[0], ids[1]] },
  })
  check('重排正文块成功', reorder.status === 200)
  check(
    '重排后顺序为 视频 → 文字 → 图片',
    reorder.json.items.map((b) => b.block_type).join(',') === 'video,text,image',
    reorder.json.items.map((b) => b.block_type).join(','),
  )

  const editBlock = await api(`/api/blocks/${ids[1]}`, {
    method: 'PUT',
    token,
    body: { text_content: '修改后的学习目标' },
  })
  check('编辑文字块成功', editBlock.status === 200 && editBlock.json?.text_content === '修改后的学习目标')

  const deleteBlock = await api(`/api/blocks/${ids[0]}`, { method: 'DELETE', token })
  check('删除正文块成功', deleteBlock.status === 200)

  const afterDelete = await api(`/api/lessons/${lessonId}/blocks`)
  check('删除后剩两个块', afterDelete.json?.total === 2, `实际 ${afterDelete.json?.total}`)

  const deletedResource = await fetch(`${BASE}/files/${videoResourceId}`)
  check('删除块不影响资源本身', deletedResource.status === 200)

  // -------------------------------------------------------------------------
  section('四、课时详情一次加载')
  // -------------------------------------------------------------------------

  const detail = await api(`/api/lessons/${lessonId}`)
  check('课时详情包含标题', detail.json?.title === '第 1 课时：直接上传')
  check('课时详情包含正文块', Array.isArray(detail.json?.blocks) && detail.json.blocks.length === 2)
  check('课时详情包含关联资源', Array.isArray(detail.json?.resources) && detail.json.resources.length === 3)

  // -------------------------------------------------------------------------
  section('五、清理')
  // -------------------------------------------------------------------------

  await api(`/api/courses/${courseId}`, { method: 'DELETE', token })
  const checkDeleted = await api(`/api/courses/${courseId}`)
  check('测试课程已删除', checkDeleted.status === 404, `实际 ${checkDeleted.status}`)

  console.log(`\n${'='.repeat(56)}`)
  console.log(`合计 ${passed + failed} 项：通过 ${passed}，失败 ${failed}`)
  if (failures.length > 0) {
    console.log('\n失败项：')
    for (const item of failures) console.log(`  - ${item}`)
  }
  console.log('='.repeat(56))

  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试执行异常：', err)
  process.exit(2)
})
