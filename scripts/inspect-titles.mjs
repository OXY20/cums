/**
 * 列出课程与班级，用于区分测试数据与演示数据。
 *
 * 只读查询。
 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('data/classroom.db', { readOnly: true })

console.log('=== 课程（按标题聚合）===')
const courses = db
  .prepare('SELECT title, COUNT(*) n FROM courses GROUP BY title ORDER BY n DESC')
  .all()
for (const c of courses) console.log(`  ${c.n} × ${c.title}`)

console.log('\n=== 班级（按名称前缀聚合）===')
const classes = db
  .prepare('SELECT name FROM classes ORDER BY name')
  .all()
const prefixes = new Map()
for (const c of classes) {
  // 去掉末尾的时间戳，按前缀归类
  const base = c.name.replace(/-\d{10,}$/, '')
  prefixes.set(base, (prefixes.get(base) ?? 0) + 1)
}
for (const [base, n] of [...prefixes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n} × ${base}`)
}

db.close()
