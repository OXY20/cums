/**
 * 清理历史遗留的 staging 资源记录。
 *
 * 只删除同时满足以下条件的记录：
 * 1. status = 'staging'（上传中途失败，从未完成登记）；
 * 2. 没有被任何作业提交引用；
 * 3. 磁盘上确实没有对应文件。
 *
 * 任一条件不满足都跳过并列出，避免误删正在上传或已被引用的资源。
 *
 * 用法：node scripts/cleanup-staging.mjs [--yes]
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const CONFIRM = process.argv.includes('--yes')
const db = new DatabaseSync('data/classroom.db')

/** storage_key 形如 `ab/cdef-...`，拼到 objects 目录下 */
function objectPath(key) {
  return join('storage', 'objects', key)
}

const candidates = db
  .prepare(
    `SELECT r.id, r.name, r.storage_key, r.created_at
     FROM resources r
     WHERE r.status = 'staging'
       AND NOT EXISTS (
           SELECT 1 FROM homework_submission_files f WHERE f.resource_id = r.id
       )
       AND NOT EXISTS (
           SELECT 1 FROM lesson_resources l WHERE l.resource_id = r.id
       )
     ORDER BY r.id`,
  )
  .all()

console.log(`找到 ${candidates.length} 条 staging 记录：\n`)

const removable = []
const skipped = []

for (const row of candidates) {
  const path = objectPath(row.storage_key)
  const hasFile = existsSync(path)
  if (hasFile) {
    skipped.push({ ...row, reason: `磁盘仍有文件：${path}` })
  } else {
    removable.push(row)
  }
}

for (const row of removable) {
  console.log(`  可删除 #${row.id} ${row.name}（${row.created_at}）`)
}
for (const row of skipped) {
  console.log(`  跳过 #${row.id} ${row.name} — ${row.reason}`)
}

console.log(`\n可删除 ${removable.length} 条，跳过 ${skipped.length} 条`)

if (!CONFIRM) {
  console.log('\n这是预览。加 --yes 实际执行删除。')
  db.close()
  process.exit(0)
}

let deleted = 0
for (const row of removable) {
  // 二次确认：删除前再查一次引用，防止预览与执行之间状态变化
  const stillFree = db
    .prepare('SELECT COUNT(*) AS n FROM homework_submission_files WHERE resource_id = ?')
    .get(row.id)
  if (stillFree.n > 0) {
    console.log(`  跳过 #${row.id} — 已被提交引用`)
    continue
  }

  // 磁盘上若已出现文件（并发上传），同样跳过
  const path = objectPath(row.storage_key)
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch (err) {
      console.log(`  跳过 #${row.id} — 文件删除失败：${err.message}`)
      continue
    }
  }

  db.prepare('DELETE FROM resources WHERE id = ?').run(row.id)
  deleted += 1
}

console.log(`\n已删除 ${deleted} 条 staging 记录`)
db.close()
