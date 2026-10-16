// 验证远端分支的提交信息与提交历史编码是否正确。
//
// 用法：node scripts/verify-remote.mjs
// 需要环境变量 GITEA_TOKEN（从 git credential fill 获取）。
//
// 职责边界：本脚本只校验分支与提交信息；
// 文件存在性与运行时数据泄露检查由 verify-remote-files.mjs 负责，
// 因为 Gitea 的 compare 接口在跨分叉基点时不返回文件列表，不可依赖。

const HOST = process.env.GITEA_HOST ?? 'https://git.twentyy.cn'
const REPO = process.env.GITEA_REPO ?? 'DSZZ/cums'
const BRANCH = process.env.GITEA_BRANCH ?? 'feature/classroom-platform'
const token = process.env.GITEA_TOKEN

if (!token) {
  console.error('缺少 GITEA_TOKEN 环境变量')
  process.exit(2)
}

const headers = { Authorization: `token ${token}` }

/** 请求 Gitea API，显式按 UTF-8 解码，避免控制台编码干扰判断 */
async function getJson(path) {
  const res = await fetch(`${HOST}/api/v1/repos/${REPO}${path}`, { headers })
  if (!res.ok) throw new Error(`${path} 返回 ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  return JSON.parse(buffer.toString('utf8'))
}

const branch = await getJson(`/branches/${encodeURIComponent(BRANCH)}`)

console.log('=== 远端分支 ===')
console.log('分支名:', branch.name)
console.log('最新提交:', branch.commit.id.slice(0, 7))
console.log('提交时间:', branch.commit.timestamp)
console.log()

// 逐行校验提交信息，确保中文编码正确
const lines = branch.commit.message.split('\n')
const expectedFirst = 'test: 新增远端推送验证脚本'

console.log('=== 提交信息 ===')
console.log('首行:', lines[0])
console.log('首行编码:', lines[0] === expectedFirst ? '正确' : '异常')
console.log()
console.log('完整信息：')
for (const line of lines) console.log(`  ${line}`)
console.log()

const checks = [
  ['分支名正确', branch.name === BRANCH],
  ['提交信息首行编码正确', lines[0] === expectedFirst],
  ['提交信息正文编码正确', branch.commit.message.includes('校验远端分支的提交信息编码')],
  ['提交信息无替换字符', !branch.commit.message.includes('\uFFFD')],
]

console.log('=== 校验结果 ===')
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed += 1
}

console.log()
console.log(`合计 ${checks.length} 项：通过 ${checks.length - failed}，失败 ${failed}`)
console.log()
console.log('提示：文件存在性与数据泄露检查请运行 verify-remote-files.mjs')
process.exit(failed === 0 ? 0 : 1)
