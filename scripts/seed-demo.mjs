// 生成演示数据：班级、课程、课时、资源与一节进行中的课堂。
// 用法：node scripts/seed-demo.mjs [baseUrl]

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

const { json: login } = await api('/api/auth/login', {
  method: 'POST',
  body: { username: 'admin', password: 'admin' },
})
const token = login.token
console.log('已登录');

const cls = await api('/api/classes', {
  method: 'POST',
  token,
  body: { name: '25计应1班', room_name: '一号机房' },
})
console.log('班级:', cls.status, cls.json?.name ?? cls.json?.error?.message)

const courses = [
  {
    title: '文字处理',
    description: '计算机应用 · 文字录入、排版与表格制作',
    lessons: [
      {
        title: '图文混排',
        content: {
          goal: '掌握在文档中插入图片并设置环绕方式的方法',
          intro: '本节课学习图片插入、大小调整与文字环绕设置。',
          steps: '1. 打开练习文档；\n2. 插入图片并调整大小；\n3. 设置环绕方式为"四周型"；\n4. 保存并提交。',
          notes: '注意图片比例，避免拉伸变形。',
          task: '完成一份图文混排的自我介绍文档',
          criteria: '图片比例正确、环绕方式设置得当、排版整洁',
        },
      },
      { title: '表格制作', content: { goal: '掌握表格创建与合并单元格' } },
      { title: '页面排版', content: { goal: '掌握页眉页脚与分栏设置' } },
    ],
  },
  {
    title: '程序设计基础',
    description: '计算机应用 · 顺序、分支与循环结构',
    lessons: [
      { title: '变量与数据类型', content: { goal: '理解变量与基本数据类型' } },
      { title: '分支结构', content: { goal: '掌握 if-else 的使用' } },
      { title: '循环结构', content: { goal: '掌握 for 与 while 循环' } },
    ],
  },
  {
    title: '数据库原理',
    description: '计算机网络 · 关系模型与 SQL 基础',
    lessons: [
      { title: '关系模型', content: { goal: '理解关系与元组的概念' } },
      { title: 'SQL 查询', content: { goal: '掌握 SELECT 基本查询' } },
    ],
  },
  {
    title: '视频剪辑',
    description: '数字媒体 · 剪辑、转场与导出',
    lessons: [
      { title: '时间线基础', content: { goal: '熟悉时间线与轨道操作' } },
      { title: '转场与特效', content: { goal: '掌握常用转场效果' } },
    ],
  },
]

let firstLessonId = null
for (const course of courses) {
  const created = await api('/api/courses', {
    method: 'POST',
    token,
    body: { title: course.title, description: course.description },
  })
  const courseId = created.json.id

  for (const lesson of course.lessons) {
    const l = await api(`/api/courses/${courseId}/lessons`, {
      method: 'POST',
      token,
      body: { title: lesson.title, content_json: JSON.stringify(lesson.content) },
    })
    if (firstLessonId === null) firstLessonId = l.json.id
  }

  await api(`/api/courses/${courseId}`, { method: 'PUT', token, body: { status: 'published' } })
  console.log(`课程已发布：${course.title}（${course.lessons.length} 课时）`)
}

// 发布一节进行中的课堂，让学生端首页有内容
if (firstLessonId !== null && cls.json?.id) {
  const session = await api('/api/sessions', {
    method: 'POST',
    token,
    body: { class_id: cls.json.id, lesson_id: firstLessonId },
  })
  if (session.json?.id) {
    await api(`/api/sessions/${session.json.id}/start`, { method: 'POST', token })
    console.log(`已发布进行中课堂：场次 #${session.json.id}`)
  } else {
    console.log('课堂创建结果：', session.json)
  }
}

console.log('\n演示数据准备完成')
