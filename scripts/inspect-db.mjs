/**
 * 检查数据库最终状态：迁移、数据量、批改分布。
 *
 * 只读查询。
 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('data/classroom.db', { readOnly: true })

console.log('迁移：')
for (const r of db
  .prepare('SELECT version, description, success FROM _sqlx_migrations ORDER BY version')
  .all()) {
  console.log(`  ${r.version} ${r.description} success=${r.success}`)
}

const count = (sql) => db.prepare(sql).get().n
console.log(`\n课程：${count('SELECT COUNT(*) n FROM courses')}`)
console.log(`班级：${count('SELECT COUNT(*) n FROM classes')}`)
console.log(`课时：${count('SELECT COUNT(*) n FROM lessons')}`)
console.log(`名单：${count('SELECT COUNT(*) n FROM class_students')}`)
console.log(`提交：${count('SELECT COUNT(*) n FROM homework_submissions')}`)
console.log(`资源：${count('SELECT COUNT(*) n FROM resources')}`)

const reviewed = count(
  "SELECT COUNT(*) n FROM homework_submissions WHERE review_label <> '' OR review_score IS NOT NULL",
)
console.log(`已批改：${reviewed}`)

const byLabel = db
  .prepare(
    `SELECT review_label, COUNT(*) n FROM homework_submissions GROUP BY review_label ORDER BY n DESC`,
  )
  .all()
if (byLabel.length > 0) {
  console.log('\n标签分布：')
  for (const row of byLabel) {
    console.log(`  ${row.review_label || '(未评价)'} = ${row.n}`)
  }
}

db.close()
