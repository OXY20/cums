/**
 * formatTime 边界情况验证。
 *
 * 直接导入真实实现，避免复刻逻辑时因转义差异产生假结论。
 *
 * 用法：node scripts/verify-format-time.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(
  join(here, '..', 'frontend', 'src', 'utils', 'format.ts'),
  'utf8',
)

// 从 TS 源码中抽出 formatTime 与 pad2 的实现，去掉 TS 类型标注后执行
const body = source
  .replace(/^\/\*\*[\s\S]*?\*\/\s*/m, '')
  .replace(/export function /g, 'function ')
  .replace(/:\s*string\s*\|\s*null\s*\|\s*undefined/g, '')
  .replace(/:\s*string/g, '')
  .replace(/:\s*number/g, '')

const fn = new Function(`${body}; return { formatTime, pad2 };`)()
const { formatTime } = fn

let passed = 0
let failed = 0
const failures = []
function check(name, actual, expected) {
  if (actual === expected) {
    passed += 1
    console.log(`  ✓ ${name} → ${actual}`)
  } else {
    failed += 1
    failures.push(`${name}：期望 ${expected}，实际 ${actual}`)
    console.log(`  ✗ ${name} → ${actual}（期望 ${expected}）`)
  }
}

const offsetMinutes = -new Date().getTimezoneOffset()
console.log(`设备时区：UTC${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes / 60}`)
console.log(`当前本地时间：${new Date().toString().slice(0, 33)}\n`)

console.log('[1] 各种输入格式')
check('SQLite UTC 无标记', formatTime('2026-10-19 17:28:13'), '2026-10-20 01:28:13')
check('chrono RFC3339 带 +00:00', formatTime('2026-10-19T17:28:13.123456+00:00'), '2026-10-20 01:28:13')
check('带 Z', formatTime('2026-10-19T17:28:13Z'), '2026-10-20 01:28:13')
check('带毫秒 Z', formatTime('2026-10-19T17:28:13.123Z'), '2026-10-20 01:28:13')
check('六位微秒 +00:00', formatTime('2026-10-19T17:28:13.123456+00:00'), '2026-10-20 01:28:13')

console.log('\n[2] 空值与异常输入')
check('null', formatTime(null), '—')
check('undefined', formatTime(undefined), '—')
check('空字符串', formatTime(''), '—')
check('纯空白', formatTime('   '), '—')
check('非法字符串（原样返回）', formatTime('not-a-date'), 'not-a-date')

console.log('\n[3] 关键断言：不能把 UTC 当本地时间')
const shown = formatTime('2026-10-19 17:28:13')
const isUtcText = shown === '2026-10-19 17:28:13'
console.log(`  UTC 样本 2026-10-19 17:28:13 → ${shown}`)
if (offsetMinutes !== 0) {
  check('非 UTC 时区下显示值不等于原始 UTC 字符串', String(isUtcText), 'false')
}

console.log('\n[4] 往返一致性：不同格式应得到同一结果')
const formats = [
  '2026-10-19 17:28:13',
  '2026-10-19T17:28:13Z',
  '2026-10-19T17:28:13+00:00',
  '2026-10-19T17:28:13.000Z',
  '2026-10-19T17:28:13.000000+00:00',
]
const results = formats.map((f) => formatTime(f))
const allSame = results.every((r) => r === results[0])
check('五种格式结果一致', String(allSame), 'true')
if (!allSame) {
  for (let i = 0; i < formats.length; i += 1) {
    console.log(`    ${formats[i]} → ${results[i]}`)
  }
}

console.log('\n[5] 跨日边界')
// UTC 前一天 23:30 在东八区应是次日 07:30
check('UTC 23:30 跨到次日（东八区）', formatTime('2026-10-19 23:30:00'), '2026-10-20 07:30:00')
// UTC 16:00 在东八区是次日 00:00
check('UTC 16:00 跨到次日零点', formatTime('2026-10-19 16:00:00'), '2026-10-20 00:00:00')

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exitCode = 1
}
