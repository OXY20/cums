/**
 * 检查失效资源记录（数据库有、磁盘无文件）的来源。
 *
 * 只读查询，不修改数据库。
 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('data/classroom.db', { readOnly: true })

const rows = db
  .prepare("SELECT id, name, storage_key, created_at, status FROM resources WHERE name LIKE '%摘要%' ORDER BY id")
  .all()

console.log(`匹配 ${rows.length} 条：`)
for (const r of rows) {
  console.log(`  #${r.id} ${r.name} ${r.created_at} status=${r.status}`)
}

// 这些资源是否还被提交记录引用
const linked = db
  .prepare(
    `SELECT r.id, COUNT(f.submission_id) AS uses
     FROM resources r
     LEFT JOIN homework_submission_files f ON f.resource_id = r.id
     WHERE r.name LIKE '%摘要%'
     GROUP BY r.id`,
  )
  .all()
console.log('\n被提交引用的次数：')
for (const l of linked) console.log(`  #${l.id} 引用 ${l.uses} 次`)

db.close()
