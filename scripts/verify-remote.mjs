// 验证远端分支与提交信息编码是否正确。
//
// 用法：node scripts/verify-remote.mjs [分支名]
// 需要环境变量 GITEA_TOKEN（从 git credential fill 获取）。
//
// 设计说明：不硬编码任何提交信息文本，而是把远端 API 返回的提交信息
// 与本地 `git log` 的结果逐字对比。这样脚本可长期复用，
// 也不会因为提交信息变更而误报。
//
// 职责边界：本脚本只校验分支与提交信息；
// 文件存在性与运行时数据泄露检查由 verify-remote-files.mjs 负责，
// 因为 Gitea 的 compare 接口在跨分叉基点时不返回文件列表，不可依赖。

import { execFileSync } from 'node:child_process'

const BRANCH = process.argv[2] ?? process.env.GITEA_BRANCH ?? 'feature/classroom-platform'
const HOST = process.env.GITEA_HOST ?? 'https://git.twentyy.cn'
const REPO = process.env.GITEA_REPO ?? 'DSZZ/cums'
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

/** 读取本地分支的提交信息与 SHA */
function localCommit(ref) {
  // 用 -z 分隔，避免提交信息中的换行影响解析
  const sha = execFileSync('git', ['rev-parse', ref], { encoding: 'utf8' }).trim()
  const message = execFileSync('git', ['log', '-1', '--format=%B', sha], {
    encoding: 'utf8',
  })
  return { sha, message }
}

const remote = await getJson(`/branches/${encodeURIComponent(BRANCH)}`)
const local = localCommit(BRANCH)

console.log('=== 分支与提交 ===')
console.log('分支名:      ', remote.name)
console.log('远端 HEAD:   ', remote.commit.id.slice(0, 7))
console.log('本地 HEAD:   ', local.sha.slice(0, 7))
console.log('提交时间:    ', remote.commit.timestamp)
console.log()

// 归一化：统一换行并去掉首尾空白，避免平台差异造成假失败
const normalize = (text) => text.replace(/\r\n/g, '\n').trim()
const remoteMessage = normalize(remote.commit.message)
const localMessage = normalize(local.message)

console.log('=== 提交信息（远端）===')
for (const line of remoteMessage.split('\n')) console.log(`  ${line}`)
console.log()

const checks = [
  ['分支名正确', remote.name === BRANCH],
  ['远端与本地 HEAD 一致', remote.commit.id === local.sha],
  ['远端提交信息与本地逐字一致', remoteMessage === localMessage],
  ['提交信息无替换字符（编码未损坏）', !remoteMessage.includes('\uFFFD')],
]

if (remoteMessage !== localMessage) {
  console.log('=== 差异 ===')
  console.log('本地：', JSON.stringify(localMessage.slice(0, 200)))
  console.log('远端：', JSON.stringify(remoteMessage.slice(0, 200)))
  console.log()
}

console.log('=== 校验结果 ===')
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed += 1
}

console.log()
console.log(`合计 ${checks.length} 项：通过 ${checks.length - failed}，失败 ${failed}`)
console.log('提示：文件存在性与数据泄露检查请运行 verify-remote-files.mjs')
process.exit(failed === 0 ? 0 : 1)
