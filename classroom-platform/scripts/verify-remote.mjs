// 验证远端分支的提交信息与文件清单编码是否正确。
//
// 用法：node scripts/verify-remote.mjs
// 需要环境变量 GITEA_TOKEN（从 git credential fill 获取）。

const HOST = process.env.GITEA_HOST ?? 'https://git.twentyy.cn'
const REPO = process.env.GITEA_REPO ?? 'DSZZ/cums'
const BRANCH = process.env.GITEA_BRANCH ?? 'feature/classroom-platform'
const token = process.env.GITEA_TOKEN

if (!token) {
  console.error('缺少 GITEA_TOKEN 环境变量')
  process.exit(2)
}

const headers = { Authorization: `token ${token}` }

async function getJson(path) {
  const res = await fetch(`${HOST}/api/v1/repos/${REPO}${path}`, { headers })
  if (!res.ok) throw new Error(`${path} 返回 ${res.status}`)
  // 显式按 UTF-8 解码，避免控制台编码干扰
  const buffer = Buffer.from(await res.arrayBuffer())
  return JSON.parse(buffer.toString('utf8'))
}

const branch = await getJson(`/branches/${encodeURIComponent(BRANCH)}`)
console.log('=== 远端分支 ===')
console.log('分支名:', branch.name)
console.log('最新提交:', branch.commit.id.slice(0, 7))
console.log('提交时间:', branch.commit.timestamp)
console.log()

const expected = 'fix: 测试断言改为数据驱动，避免依赖特定环境状态'
console.log('=== 提交信息编码校验 ===')
console.log('远端首行:', branch.commit.message.split('\n')[0])
console.log('期望首行:', expected)
console.log('结果:', branch.commit.message.startsWith(expected) ? '编码正确' : '编码异常')
console.log()

// 统计整个分支相对 master 新增的文件
const masterSha = (await getJson('/branches/master')).commit.id
const compare = await getJson(`/compare/${masterSha}...${branch.commit.id}`)

console.log('=== 相对 master 的变更 ===')
console.log('提交数:', compare.total_commits)
console.log('文件数:', compare.files?.length ?? 0)
console.log()

const platformFiles = (compare.files ?? []).filter((f) =>
  f.filename.startsWith('classroom-platform/'),
)
console.log('classroom-platform 下文件:', platformFiles.length)

// 确认运行时数据与构建产物未被提交
const forbidden = [
  'classroom-platform/data/',
  'classroom-platform/storage/',
  'classroom-platform/backups/',
  'classroom-platform/app/web/',
  'classroom-platform/app/logs/',
  'classroom-platform/app/config/config.toml',
  'classroom-platform/backend/target/',
  'classroom-platform/frontend/node_modules/',
]
const leaked = platformFiles.filter((f) => forbidden.some((p) => f.filename.startsWith(p)))

console.log()
console.log('=== 运行时数据泄露检查 ===')
if (leaked.length === 0) {
  console.log('通过：数据库、资源、日志、构建产物与含密钥的配置均未提交')
} else {
  console.log('异常：以下不应提交的文件出现在远端')
  for (const f of leaked) console.log('  -', f.filename)
}

const ok =
  branch.name === BRANCH &&
  branch.commit.message.startsWith(expected) &&
  leaked.length === 0

console.log()
console.log(ok ? 'RESULT: 远端内容校验通过' : 'RESULT: 远端内容存在问题')
process.exit(ok ? 0 : 1)
