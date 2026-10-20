// 确认远端分支上关键文件的存在性，以及运行时数据确实未提交。
//
// 用法：node scripts/verify-remote-files.mjs
// 需要环境变量 GITEA_TOKEN。

const HOST = process.env.GITEA_HOST ?? 'https://git.twentyy.cn'
const REPO = process.env.GITEA_REPO ?? 'DSZZ/cums'
const BRANCH = process.env.GITEA_BRANCH ?? 'feature/classroom-platform'
const token = process.env.GITEA_TOKEN

if (!token) {
  console.error('缺少 GITEA_TOKEN 环境变量')
  process.exit(2)
}

const headers = { Authorization: `token ${token}` }

/** 返回文件是否存在（200 存在，404 不存在） */
async function exists(path) {
  const url = `${HOST}/api/v1/repos/${REPO}/contents/${path}?ref=${encodeURIComponent(BRANCH)}`
  const res = await fetch(url, { headers })
  return res.status
}

// 应当存在于远端的文件
const mustExist = [
  'README.md',
  '.gitignore',
  'backend/Cargo.toml',
  'backend/Cargo.lock',
  'backend/migrations/0001_init.sql',
  'backend/src/main.rs',
  'backend/src/routes/files.rs',
  'frontend/package.json',
  'frontend/src/App.vue',
  'frontend/src/views/StudentHome.vue',
  'frontend/src/views/admin/ConsoleView.vue',
  'docs/ARCHITECTURE.md',
  'docs/DEPLOYMENT.md',
  'docs/TESTING.md',
  'docs/screenshots/student-home.png',
  'scripts/smoke-test.mjs',
]

// 不应出现在远端的内容（运行时数据、构建产物、含密钥的配置）
const mustNotExist = [
  'data/classroom.db',
  'app/config/config.toml',
  'app/web/index.html',
  'app/logs/server.log.2026-10-16',
  'backend/target/CACHEDIR.TAG',
  'frontend/node_modules/.package-lock.json',
]

let pass = 0
let fail = 0

console.log('=== 应存在的文件 ===')
for (const path of mustExist) {
  const status = await exists(path)
  const ok = status === 200
  ok ? pass++ : fail++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${path}  (HTTP ${status})`)
}

console.log()
console.log('=== 不应存在的内容 ===')
for (const path of mustNotExist) {
  const status = await exists(path)
  const ok = status === 404
  ok ? pass++ : fail++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${path}  (HTTP ${status})`)
}

console.log()
console.log(`合计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
