/**
 * 填充演示数据：班级、名单、课程、课时、作业提交与批改记录。
 *
 * 目标不是「造几条假数据」，而是构造一个经得起翻看的教学现场：
 * - 三个真实感班级，每班 30 人名单；
 * - 四门课程，课时正文有实际内容；
 * - 六个课时有学生作业，涵盖文档、表格、图片、视频、代码、压缩包；
 * - 批改分布不均（有的班批完了，有的刚批一半，有的一个没批）；
 * - 个别学生交错文件重交一次，用来演示重复提交提醒。
 *
 * 用法：
 *   node scripts/seed-demo-data.mjs [baseUrl]
 *
 * 前置：服务已启动；scripts/fixtures/ 下的文件池已生成
 * （node scripts/make-fixtures.py 或 python scripts/make-fixtures.py）。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'
const FIXTURES = 'scripts/fixtures'

// ---------------------------------------------------------------------------
// 请求封装
// ---------------------------------------------------------------------------

async function call(path, { method = 'GET', token, body, raw } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 保留原文 */
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`)
  }
  return json
}

// ---------------------------------------------------------------------------
// 数据定义
// ---------------------------------------------------------------------------

/** 三个班级的名单：学号与姓名。 */
const CLASSES = [
  {
    name: '25级计应1班',
    room: '实训楼 302',
    prefix: '202501',
    students: [
      '陈思远', '林晓彤', '黄子豪', '刘雨桐', '蔡明轩',
      '杨佳怡', '吴俊杰', '周欣然', '徐嘉豪', '孙梦琪',
      '朱文博', '马诗涵', '胡宇航', '郭思琪', '何泽宇',
      '高雨萱', '罗浩宇', '梁静怡', '宋子涵', '谢俊熙',
      '唐可欣', '韩博文', '冯雅静', '曹睿泽', '邓紫涵',
      '彭嘉豪', '曾梦瑶', '萧子墨', '田雨欣', '董家豪',
    ],
  },
  {
    name: '25级计应2班',
    room: '实训楼 305',
    prefix: '202502',
    students: [
      '袁梓涵', '蒋雨泽', '沈佳琪', '傅浩宇', '钟可欣',
      '卢俊豪', '汪诗雅', '戴子轩', '崔梦洁', '谭宇航',
      '陆思彤', '范泽宇', '金雨萌', '石浩轩', '贾静怡',
      '夏梓萱', '韦俊宇', '方雅琳', '白子涵', '邹嘉怡',
      '孟浩天', '熊诗琪', '秦子豪', '邱雨欣', '侯佳明',
      '江梓豪', '尹静雯', '薛浩宇', '段梦琪', '雷鸣宇',
    ],
  },
  {
    name: '25级数媒1班',
    room: '实训楼 401',
    prefix: '202503',
    students: [
      '程思颖', '万子豪', '顾雨萱', '严浩宇', '温佳琪',
      '倪俊杰', '汤诗涵', '施子轩', '樊梦琳', '殷嘉豪',
      '常雅雯', '贺宇航', '路雨欣', '龚俊豪', '苗诗雅',
      '柏子涵', '费浩宇', '舒佳怡', '柯梦琪', '祝俊宇',
      '柯雨桐', '骆嘉豪', '项思远', '辛雅涵', '封浩宇',
      '卫诗琪', '关子豪', '甄雨薇', '屈俊杰', '百里明',
    ],
  },
]

/** 课程、课时与「这个课时谁交了什么」。 */
const COURSES = [
  {
    title: '计算机应用基础',
    description: 'Windows 操作、Word 图文混排、Excel 数据统计与 PowerPoint 演示文稿',
    cover: '封面-计算机应用基础.png',
    lessons: [
      {
        title: '第 1 课时 · Word 图文混排',
        html: [
          '<h2>本课目标</h2>',
          '<p>掌握在 Word 文档中插入图片并设置文字环绕方式的方法，完成一份图文并茂的自我介绍文档。</p>',
          '<h2>操作要点</h2>',
          '<ol>',
          '<li>标题使用黑体二号并居中，正文使用宋体小四、行距 1.5 倍、首行缩进两字符；</li>',
          '<li>插入图片后右键选择「环绕文字 → 四周型」，让文字自然贴合图片边缘；</li>',
          '<li>拖动图片四角缩放，按住 Shift 保持原始长宽比，避免拉伸变形；</li>',
          '<li>页脚插入居中页码，格式为「第 X 页」。</li>',
          '</ol>',
          '<h2>作业要求</h2>',
          '<p>提交一份不少于 300 字的图文混排文档，至少包含一张图片与一个三行以上的表格。可提交 .docx 文件，也可提交完成后的截图。</p>',
        ].join('\n'),
        klass: '25级计应1班',
        // 26 人提交，其中 20 份已批改
        submitters: 26,
        reviewed: 20,
        files: [
          ['图文混排作业.docx'],
          ['图文混排截图.png'],
          ['图文混排作业.docx', '图文混排截图.png'],
          ['图文混排截图.png', '实训现场照片.jpg'],
        ],
        session: true,
      },
      {
        title: '第 2 课时 · Excel 数据统计',
        html: [
          '<h2>本课目标</h2>',
          '<p>使用公式与函数完成成绩统计，理解相对引用与绝对引用的区别。</p>',
          '<h2>操作要点</h2>',
          '<ol>',
          '<li>用 <code>SUM</code>、<code>AVERAGE</code>、<code>MAX</code>、<code>MIN</code> 完成基础统计；</li>',
          '<li>总评成绩按「平时 40% + 期末 60%」计算，公式为 <code>=C2*0.4+D2*0.6</code>；</li>',
          '<li>设置单元格边框与标题底色，让表格层次清晰；</li>',
          '<li>调整列宽，避免内容被截断显示为 <code>####</code>。</li>',
          '</ol>',
          '<h2>作业要求</h2>',
          '<p>提交一份不少于 6 人的成绩统计表，必须包含公式计算结果。可提交 .xlsx 文件或截图。</p>',
        ].join('\n'),
        klass: '25级计应1班',
        submitters: 28,
        reviewed: 10,
        files: [['班级成绩表.xlsx'], ['成绩表截图.png'], ['班级成绩表.xlsx', '成绩表截图.png']],
        session: true,
      },
      {
        title: '第 3 课时 · PowerPoint 演示文稿',
        html: [
          '<h2>本课目标</h2>',
          '<p>掌握母版、版式与动画的基本用法，独立完成一份主题明确的汇报演示文稿。</p>',
          '<h2>操作要点</h2>',
          '<ol>',
          '<li>使用母版统一字体与配色，避免逐页手动调整；</li>',
          '<li>每页文字控制在 5 行以内，一页只说一个观点；</li>',
          '<li>动画只用于强调重点，全篇不超过三种效果。</li>',
          '</ol>',
          '<h2>作业要求</h2>',
          '<p>提交一份不少于 6 页的演示文稿截图，主题自选。</p>',
        ].join('\n'),
        klass: '25级计应1班',
        submitters: 0,
        reviewed: 0,
        files: [['演示文稿截图.png']],
        session: false,
      },
    ],
  },
  {
    title: '程序设计基础',
    description: 'Python 入门：变量、分支与循环结构',
    cover: '封面-程序设计基础.png',
    lessons: [
      {
        title: '第 1 课时 · 变量与数据类型',
        html: [
          '<h2>本课目标</h2>',
          '<p>理解变量、基本数据类型与类型转换，能读懂简单的 Python 程序。</p>',
          '<h2>操作要点</h2>',
          '<ol>',
          '<li>整数、浮点数、字符串、布尔值四种基本类型；</li>',
          '<li>用 <code>type()</code> 查看类型，用 <code>int()</code>、<code>str()</code> 做转换；</li>',
          '<li>变量名要有意义，避免 <code>a1</code>、<code>tmp</code> 这类无法表达意图的命名。</li>',
          '</ol>',
        ].join('\n'),
        klass: '25级计应1班',
        submitters: 27,
        reviewed: 27,
        files: [['代码截图.png'], ['分支代码截图.png']],
        session: false,
      },
      {
        title: '第 2 课时 · 分支结构',
        html: [
          '<h2>本课目标</h2>',
          '<p>掌握 if / elif / else 的写法与嵌套，能根据多个条件给出不同结果。</p>',
          '<h2>操作要点</h2>',
          '<ol>',
          '<li>条件表达式的结果必须是布尔值；</li>',
          '<li>Python 用缩进表示代码块，同一层级缩进必须一致；</li>',
          '<li>多分支优先判断范围更窄的条件，避免逻辑被前面的分支吃掉。</li>',
          '</ol>',
          '<h2>作业要求</h2>',
          '<p>编写一个成绩等级判定程序，输入分数输出优秀 / 良好 / 及格 / 不及格。提交源码或运行截图。</p>',
        ].join('\n'),
        klass: '25级计应1班',
        submitters: 24,
        reviewed: 0,
        files: [['等级判定.py'], ['分支代码截图.png'], ['等级判定.py', '分支代码截图.png']],
        session: false,
      },
      {
        title: '第 3 课时 · 循环结构',
        html: [
          '<h2>本课目标</h2>',
          '<p>掌握 for 与 while 循环，理解 range 的用法与循环嵌套。</p>',
          '<h2>操作要点</h2>',
          '<ol>',
          '<li><code>for i in range(n)</code> 从 0 遍历到 n-1；</li>',
          '<li>循环里累加要用循环外的变量保存结果；</li>',
          '<li>嵌套循环的内层循环次数会随外层变化，注意总执行次数。</li>',
          '</ol>',
          '<h2>作业要求</h2>',
          '<p>用循环实现九九乘法表或素数筛选，提交源码。</p>',
        ].join('\n'),
        klass: '25级计应2班',
        submitters: 25,
        reviewed: 12,
        files: [
          ['九九乘法表.py'],
          ['素数筛选.py'],
          ['成绩统计.py', '代码截图.png'],
        ],
        session: false,
      },
    ],
  },
  {
    title: '视频剪辑',
    description: '时间线操作、转场特效与成片导出',
    cover: '封面-视频剪辑.png',
    lessons: [
      {
        title: '第 1 课时 · 时间线基础',
        html: [
          '<h2>本课目标</h2>',
          '<p>熟悉时间线与轨道操作，能完成素材的粗剪与拼接。</p>',
          '<h2>操作要点</h2>',
          '<ol>',
          '<li>视频轨、音频轨、字幕轨各司其职，不要混放；</li>',
          '<li>用切割工具在播放头位置切开片段，删除多余部分；</li>',
          '<li>拖动片段边缘做微调，注意不要留下黑帧空隙。</li>',
          '</ol>',
          '<h2>作业要求</h2>',
          '<p>提交一段 30 秒以内的粗剪视频，或剪辑思路说明。</p>',
        ].join('\n'),
        klass: '25级数媒1班',
        submitters: 22,
        reviewed: 15,
        files: [
          ['操作演示.mp4'],
          ['剪辑思路.md'],
          ['操作演示.mp4', '剪辑思路.md'],
          ['快捷键备忘.md'],
        ],
        session: true,
      },
      {
        title: '第 2 课时 · 转场与特效',
        html: [
          '<h2>本课目标</h2>',
          '<p>掌握常用转场效果的适用场景，能用特效强化叙事节奏。</p>',
          '<h2>操作要点</h2>',
          '<ol>',
          '<li>叠化用于时间流逝，硬切用于动作衔接，闪白用于情绪转折；</li>',
          '<li>转场时长控制在 0.3–0.6 秒，过长会显得拖沓；</li>',
          '<li>特效服务于内容，不要为了炫技堆叠效果。</li>',
          '</ol>',
          '<h2>作业要求</h2>',
          '<p>提交一段包含至少两种转场的成片，附素材包。</p>',
        ].join('\n'),
        klass: '25级数媒1班',
        submitters: 19,
        reviewed: 6,
        files: [['剪辑成品.mp4'], ['剪辑成品.mp4', '素材包.zip'], ['素材包.zip']],
        session: false,
      },
    ],
  },
  {
    title: '计算机网络技术',
    description: '网络基础、IP 地址规划与交换机配置',
    cover: '封面-计算机网络技术.png',
    lessons: [
      {
        title: '第 1 课时 · 网络体系结构',
        html: [
          '<h2>本课目标</h2>',
          '<p>理解 OSI 七层模型与 TCP/IP 四层模型的对应关系。</p>',
          '<h2>操作要点</h2>',
          '<ol>',
          '<li>物理层传输比特，数据链路层传输帧，网络层传输分组；</li>',
          '<li>交换机工作在数据链路层，路由器工作在网络层；</li>',
          '<li>分层的意义在于每一层只需关心自己的职责。</li>',
          '</ol>',
        ].join('\n'),
        klass: '25级计应2班',
        submitters: 23,
        reviewed: 23,
        files: [['网络实验报告.pdf'], ['机房全景照片.jpg']],
        session: false,
      },
      {
        title: '第 2 课时 · IP 地址规划',
        html: [
          '<h2>本课目标</h2>',
          '<p>掌握子网划分方法，能为一个小型机房设计合理的地址规划。</p>',
          '<h2>操作要点</h2>',
          '<ol>',
          '<li>根据主机数量确定主机位，2^n - 2 ≥ 主机数；</li>',
          '<li>子网掩码决定网络位与主机位的分界；</li>',
          '<li>网络地址与广播地址不能分配给主机。</li>',
          '</ol>',
          '<h2>作业要求</h2>',
          '<p>为 60 台主机的机房设计地址规划，提交台账表或拓扑截图。</p>',
        ].join('\n'),
        klass: '25级计应2班',
        submitters: 18,
        reviewed: 8,
        files: [
          ['机房设备台账.xlsx'],
          ['台账截图.png'],
          ['网络拓扑截图.png'],
          ['机房设备台账.xlsx', '网络拓扑截图.png'],
        ],
        session: true,
      },
    ],
  },
]

/** 批改标签的分布：好 / 通过 / 不通过 / 其他。 */
const REVIEW_PLAN = [
  { label: 'good', score: 95, comment: '版式清晰，图文比例得当，细节处理到位' },
  { label: 'good', score: 92, comment: '内容完整，排版规范' },
  { label: 'good', score: 90 },
  { label: 'pass', score: 82 },
  { label: 'pass', score: 78 },
  { label: 'pass', score: 85, comment: '达到要求，但表格边框不统一，下次注意' },
  { label: 'pass', score: 76 },
  { label: 'fail', score: 52, comment: '图片被拉伸变形，且缺少题目要求的表格，请修正后重新提交' },
  { label: 'fail', score: 48, comment: '未按要求设置行距与缩进，全文格式与要求不符' },
  { label: 'other', score: 70, comment: '内容完整但缺少页脚页码，补上即可通过' },
]

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 生成「学号-姓名-作业名.ext」形式的文件名，让提交记录看起来像真的。 */
function studentFileName(studentNo, studentName, baseName) {
  const dot = baseName.lastIndexOf('.')
  const stem = dot === -1 ? baseName : baseName.slice(0, dot)
  const ext = dot === -1 ? '' : baseName.slice(dot)
  return `${studentNo}-${studentName}-${stem}${ext}`
}

/** 按 MIME 猜测，避免浏览器把 docx 报成 octet-stream。 */
function mimeOf(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return (
    {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      mp4: 'video/mp4',
      md: 'text/markdown',
      py: 'text/x-python',
      zip: 'application/zip',
      txt: 'text/plain',
    }[ext] ?? 'application/octet-stream'
  )
}

const fixtureCache = new Map()
function fixture(name) {
  if (!fixtureCache.has(name)) {
    const path = join(FIXTURES, name)
    if (!existsSync(path)) {
      throw new Error(`缺少素材文件：${path}（先运行 make-fixtures.py）`)
    }
    fixtureCache.set(name, readFileSync(path))
  }
  return fixtureCache.get(name)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const login = await call('/api/auth/login', {
  method: 'POST',
  body: { username: 'admin', password: 'admin' },
})
const token = login.token
console.log('已登录')

// ---- 班级与名单 ----
const classIds = new Map()
const rosters = new Map()

for (const klass of CLASSES) {
  const created = await call('/api/classes', {
    method: 'POST',
    token,
    body: { name: klass.name, room_name: klass.room },
  })
  classIds.set(klass.name, created.id)

  const roster = klass.students.map((name, i) => ({
    studentNo: `${klass.prefix}${String(i + 1).padStart(2, '0')}`,
    studentName: name,
  }))
  rosters.set(klass.name, roster)

  await call(`/api/classes/${created.id}/students/import`, {
    method: 'POST',
    token,
    body: { text: roster.map((r) => `${r.studentNo} ${r.studentName}`).join('\n'), replace: true },
  })
  console.log(`班级已建：${klass.name}（${roster.length} 人）`)
}

// ---- 课程与课时 ----
const lessonIds = new Map() // `${课程}|${课时标题}` → id
const createdLessons = [] // 用于后续造提交

for (const course of COURSES) {
  const c = await call('/api/courses', {
    method: 'POST',
    token,
    body: { title: course.title, description: course.description },
  })
  await call(`/api/courses/${c.id}`, { method: 'PUT', token, body: { status: 'published' } })

  // 封面单独走上传接口：它要求真实图片文件，不能用 JSON 塞路径
  if (course.cover) {
    const form = new FormData()
    form.append('file', new File([fixture(course.cover)], course.cover, { type: 'image/png' }))
    await call(`/api/courses/${c.id}/cover`, { method: 'POST', token, raw: form })
  }

  for (const lesson of course.lessons) {
    const l = await call(`/api/courses/${c.id}/lessons`, {
      method: 'POST',
      token,
      body: { title: lesson.title },
    })
    await call(`/api/lessons/${l.id}`, {
      method: 'PUT',
      token,
      body: { content_html: lesson.html, content_format: 'html' },
    })
    lessonIds.set(`${course.title}|${lesson.title}`, l.id)
    createdLessons.push({ course, lesson, lessonId: l.id })
  }
  console.log(`课程已建：${course.title}（${course.lessons.length} 课时）`)
}

// ---- 课堂场次（已结束，用于课程详情里的授课记录）----
const sessionInfo = []
for (const item of createdLessons) {
  if (!item.lesson.session) continue
  const classId = classIds.get(item.lesson.klass)
  const s = await call('/api/sessions', {
    method: 'POST',
    token,
    body: { class_id: classId, lesson_id: item.lessonId },
  })
  await call(`/api/sessions/${s.id}/start`, { method: 'POST', token })
  await call(`/api/sessions/${s.id}/end`, { method: 'POST', token })
  sessionInfo.push({ lessonId: item.lessonId, classId, sessionId: s.id })
}
console.log(`课堂记录已建：${sessionInfo.length} 节（已结束）`)

// ---- 学生提交 ----
const submissionIds = new Map() // lessonId → [{ id, studentNo, studentName }]
let uploadedFiles = 0

for (const item of createdLessons) {
  const { lesson } = item
  if (lesson.submitters === 0) {
    submissionIds.set(item.lessonId, [])
    continue
  }

  const roster = rosters.get(lesson.klass)
  const classId = classIds.get(lesson.klass)
  const picked = roster.slice(0, lesson.submitters)
  const list = []

  for (let i = 0; i < picked.length; i += 1) {
    const student = picked[i]
    const fileSet = lesson.files[i % lesson.files.length]

    const form = new FormData()
    form.append('student_name', student.studentName)
    form.append('student_no', student.studentNo)
    form.append('lesson_id', String(item.lessonId))
    form.append('class_id', String(classId))
    // 每台机器一个稳定标识，演示「本设备已提交」判断
    form.append('device_id', `pc-${classId}-${String(i + 1).padStart(2, '0')}`)

    for (const name of fileSet) {
      const bytes = fixture(name)
      form.append(
        'file',
        new File([bytes], studentFileName(student.studentNo, student.studentName, name), {
          type: mimeOf(name),
        }),
      )
      uploadedFiles += 1
    }

    const created = await call('/api/student/submissions', { method: 'POST', raw: form })
    list.push({
      id: created.submission.id,
      studentNo: student.studentNo,
      studentName: student.studentName,
    })
  }

  submissionIds.set(item.lessonId, list)
  console.log(`提交已建：${lesson.title} · ${lesson.klass} → ${list.length} 份`)
}

// ---- 交错文件重交（演示重复提交提醒）----
//
// 只挑两个课时各一名学生，交完第一份后把另一个文件当作「交错了」再交一次。
// 重复判定按学号，因此第二次会被标记 duplicate_flag 并由接口返回提示。
let duplicateCount = 0
for (const item of createdLessons.slice(0, 2)) {
  const list = submissionIds.get(item.lessonId)
  if (!list || list.length === 0) continue

  const student = list[1]
  const roster = rosters.get(item.lesson.klass)
  const classId = classIds.get(item.lesson.klass)
  const retryFile = item.lesson.files[item.lesson.files.length - 1][0]

  const form = new FormData()
  form.append('student_name', student.studentName)
  form.append('student_no', student.studentNo)
  form.append('lesson_id', String(item.lessonId))
  form.append('class_id', String(classId))
  form.append('note', '上一条附件选错了，重新提交')
  form.append('device_id', `pc-${classId}-02`)

  const bytes = fixture(retryFile)
  form.append(
    'file',
    new File(
      [bytes],
      studentFileName(student.studentNo, student.studentName, retryFile),
      { type: mimeOf(retryFile) },
    ),
  )

  const created = await call('/api/student/submissions', { method: 'POST', raw: form })
  if (created.duplicate_warning) {
    duplicateCount += 1
    console.log(`  重复提示：${student.studentName} → ${created.duplicate_warning}`)
    list.push({
      id: created.submission.id,
      studentNo: student.studentNo,
      studentName: student.studentName,
    })
  }
}
console.log(`重复提交已建：${duplicateCount} 条（用于演示提醒）`)

// ---- 批改 ----
let reviewedTotal = 0
for (const item of createdLessons) {
  const { lesson } = item
  if (lesson.reviewed === 0) continue

  const list = submissionIds.get(item.lessonId) ?? []
  const target = list.slice(0, lesson.reviewed)

  for (let i = 0; i < target.length; i += 1) {
    // 用不同的起点偏移，让每个课时的标签分布不完全一样
    const plan = REVIEW_PLAN[(i + item.lessonId) % REVIEW_PLAN.length]
    await call(`/api/admin/submissions/${target[i].id}/review`, {
      method: 'POST',
      token,
      body: plan,
    })
    reviewedTotal += 1
  }
  console.log(`批改已建：${lesson.title} → ${target.length} 份`)
}

// ---- 分散时间戳 ----
//
// 接口写入的 created_at 全是「现在」，列表里所有提交挤在同一秒不真实。
// 这里直接改库，把提交摊到对应课时的授课日晚上，批改时间再往后推。
const db = new DatabaseSync('data/classroom.db')
db.exec('PRAGMA busy_timeout = 15000')

/** 有提交的课时，按创建顺序排列。 */
const withSubmissions = createdLessons.filter(
  (item) => (submissionIds.get(item.lessonId) ?? []).length > 0,
)

// 从今天往前排：最后一个课时落在 3 天前，往前每个课时隔 2 天。
// 用相对时间而不是写死日期，隔几天重跑也不会出现「未来交作业」。
const DAY = 86400_000
const lastDay = new Date(Date.now() - 3 * DAY)
lastDay.setUTCHours(0, 0, 0, 0)
const firstDay = new Date(lastDay.getTime() - (withSubmissions.length - 1) * 2 * DAY)

db.exec('BEGIN')
for (let k = 0; k < withSubmissions.length; k += 1) {
  const item = withSubmissions[k]
  const list = submissionIds.get(item.lessonId) ?? []
  const day = new Date(firstDay.getTime() + k * 2 * DAY)

  // 提交时间落在当天 19:00–21:20（UTC 11:00 起），每人错开约 4 分钟
  for (let i = 0; i < list.length; i += 1) {
    const t = new Date(day.getTime() + 11 * 3600_000 + i * 4 * 60_000 + (i % 7) * 23_000)
    const stamp = t.toISOString().slice(0, 19).replace('T', ' ')
    db.prepare('UPDATE homework_submissions SET created_at = ?1 WHERE id = ?2').run(
      stamp,
      list[i].id,
    )
  }

  // 课堂开始时间对齐到当天 19:00，结束时间 21:30
  const start = new Date(day.getTime() + 11 * 3600_000)
  const end = new Date(day.getTime() + 13 * 3600_000 + 30 * 60_000)
  db.prepare(
    `UPDATE classroom_sessions SET started_at = ?1, ended_at = ?2, created_at = ?1, updated_at = ?2
     WHERE lesson_id = ?3`,
  ).run(
    start.toISOString().slice(0, 19).replace('T', ' '),
    end.toISOString().slice(0, 19).replace('T', ' '),
    item.lessonId,
  )
}

// 批改时间设为提交后 1–3 天，且不晚于现在
const nowStamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
db.prepare(
  `UPDATE homework_submissions
   SET reviewed_at = datetime(created_at, '+1 day', '+' || (id % 3) || ' hours')
   WHERE reviewed_at IS NOT NULL`,
).run()
db.prepare(
  `UPDATE homework_submissions
   SET reviewed_at = ?1
   WHERE reviewed_at IS NOT NULL AND reviewed_at > ?1`,
).run(nowStamp)

// 审计日志保持真实写入时间：那是「谁在什么时候改了什么」的凭据，
// 为了好看去改它会让排查失去依据，所以这里刻意不动。

db.exec('COMMIT')
db.close()

const fmtDay = (d) => d.toISOString().slice(0, 10)
console.log(`\n时间戳已分散：${fmtDay(firstDay)} 至 ${fmtDay(lastDay)}，批改时间已对齐`)

// ---- 汇总 ----
const stat = await call('/api/courses', { token })
console.log('\n=== 填充完成 ===')
console.log(`课程：${stat.items.length}`)
console.log(`班级：${classIds.size}`)
console.log(`上传文件：${uploadedFiles} 个`)
console.log(`批改记录：${reviewedTotal} 份`)

const check = new DatabaseSync('data/classroom.db', { readOnly: true })
const n = (sql) => check.prepare(sql).get().n
console.log(`提交总数：${n('SELECT COUNT(*) n FROM homework_submissions')}`)
console.log(`  其中重复标记：${n('SELECT COUNT(*) n FROM homework_submissions WHERE duplicate_flag = 1')}`)
console.log(`  其中已批改：${n("SELECT COUNT(*) n FROM homework_submissions WHERE review_label <> '' OR review_score IS NOT NULL")}`)
console.log(`名单总数：${n('SELECT COUNT(*) n FROM class_students')}`)
for (const row of check
  .prepare("SELECT review_label, COUNT(*) c FROM homework_submissions GROUP BY review_label ORDER BY c DESC")
  .all()) {
  console.log(`  标签 ${row.review_label || '(未评价)'}：${row.c}`)
}
check.close()
