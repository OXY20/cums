// 为富媒体编辑器生成演示数据。
//
// 用法：node scripts/seed-richtext-demo.mjs [baseUrl]
//
// 构造一份包含标题、字号、颜色、对齐、列表、引用、代码块、链接、
// 图片与表格的课时正文，用于人工查看排版效果。

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

const login = await api('/api/auth/login', {
  method: 'POST',
  body: { username: 'admin', password: 'admin' },
})
const token = login.json?.token
if (!token) {
  console.error('登录失败')
  process.exit(1)
}

const courses = await api('/api/courses', { token })
const target = courses.json.items.find((c) => c.title === '文字处理') ?? courses.json.items[0]
if (!target) {
  console.error('没有可用课程')
  process.exit(1)
}

const lessons = await api(`/api/courses/${target.id}/lessons`, { token })
const lesson = lessons.json.items[0]
if (!lesson) {
  console.error('没有可用课时')
  process.exit(1)
}

const html = `
<h2>一、学习目标</h2>
<p>本节课你将掌握<strong>图片插入</strong>、<em>大小调整</em>与<u>文字环绕</u>的设置方法，
最终能独立完成一份图文混排的自我介绍文档。</p>

<h2>二、重点提示</h2>
<blockquote>图片比例要正确，避免拉伸变形；环绕方式选「四周型」效果最自然。</blockquote>

<p style="text-align: center">
  <strong>完成本课时后，请提交作业以获取评分</strong>
</p>

<h2>三、操作步骤</h2>
<ol>
  <li>打开教师下发的<strong>练习文档</strong></li>
  <li>将光标定位到正文第一段之后</li>
  <li>点击「插入 → 图片」，选择你的照片</li>
  <li>拖动角点调整大小，按住 <code>Shift</code> 保持比例</li>
  <li>右键图片 → 环绕方式 → 选择「四周型」</li>
  <li>保存文件并按学号命名后提交</li>
</ol>

<h2>四、参数说明</h2>
<table>
  <tbody>
    <tr><th>参数</th><th>推荐值</th><th>说明</th></tr>
    <tr><td>图片宽度</td><td>不超过 8 厘米</td><td>过宽会挤占正文空间</td></tr>
    <tr><td>环绕方式</td><td>四周型</td><td>文字自然环绕在图片四周</td></tr>
    <tr><td>边距</td><td>0.3 厘米</td><td>避免文字紧贴图片</td></tr>
  </tbody>
</table>

<h2>五、练习任务</h2>
<p>请完成一份不少于 <span style="color: #e11d48; font-size: 18px">300 字</span> 的自我介绍，
其中至少包含 <strong>1 张图片</strong>，并正确设置环绕方式。</p>

<p>参考资料：<a href="https://support.microsoft.com" target="_blank">微软官方帮助</a></p>

<h2>六、完成标准</h2>
<ul>
  <li>图片比例正确，无明显拉伸</li>
  <li>环绕方式设置得当，文字排版整洁</li>
  <li>文档整体美观，无错别字</li>
</ul>

<pre class="ql-syntax">文件命名格式：学号-姓名-图文混排.docx
示例：2025001-张三-图文混排.docx</pre>
`.trim()

const saved = await api(`/api/lessons/${lesson.id}`, {
  method: 'PUT',
  token,
  body: { content_html: html },
})

console.log(`课时：#${lesson.id} ${lesson.title}`)
console.log('保存结果:', saved.status, saved.json?.content_format)
console.log('正文长度:', saved.json?.content_html?.length ?? 0, '字符')

// 同步课时结构化字段，保持与富文本一致（供旧版渲染回退使用）
await api(`/api/lessons/${lesson.id}`, {
  method: 'PUT',
  token,
  body: {
    content_json: JSON.stringify({
      goal: '掌握在文档中插入图片并设置环绕方式的方法',
      steps: '1. 打开练习文档；2. 插入图片并调整大小；3. 设置环绕方式为「四周型」；4. 保存并提交。',
      task: '完成一份不少于 300 字的图文混排自我介绍文档',
      criteria: '图片比例正确、环绕方式设置得当、排版整洁',
    }),
  },
})

console.log('演示数据准备完成')
