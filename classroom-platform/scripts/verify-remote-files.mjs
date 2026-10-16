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
  'classroom-platform/README.md',
  'classroom-platform/.gitignore',
  'classroom-platform/backend/Cargo.toml',
  'classroom-platform/backend/Cargo.lock',
  'classroom-platform/backend/migrations/0001_init.sql',
  'classroom-platform/backend/src/main.rs',
  'classroom-platform/backend/src/routes/files.rs',
  'classroom-platform/frontend/package.json',
  'classroom-platform/frontend/src/App.vue',
  'classroom-platform/frontend/src/views/StudentHome.vue',
  'classroom-platform/frontend/src/views/admin/ConsoleView.vue',
  'classroom-platform/docs/ARCHITECTURE.md',
  'classroom-platform/docs/DEPLOYMENT.md',
  'classroom-platform/docs/TESTING.md',
  'classroom-platform/docs/screenshots/student-home.png',
  'classroom-platform/scripts/smoke-test.mjs',
]

// 不应出现在远端的内容（运行时数据、构建产物、含密钥的配置）
const mustNotExist = [
  'classroom-platform/data/classroom.db',
  'classroom-platform/app/config/config.toml',
  'classroom-platform/app/web/index.html',
  'classroom-platform/app/logs/server.log.2026-10-16',
  'classroom-platform/backend/target/CACHEDIR.TAG',
  'classroom-platform/frontend/node_modules/.package-lock.json',
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
