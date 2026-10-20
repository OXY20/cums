/**
 * 查看指定提交的详情，判断是否为测试数据。
 *
 * 用法：node scripts/inspect-submission.mjs <submission_id>
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const id = Number(process.argv[2])
if (!Number.isInteger(id) || id <= 0) {
  console.error('用法：node scripts/inspect-submission.mjs <submission_id>')
  process.exit(1)
}

const db = new DatabaseSync('data/classroom.db')

const sub = db
  .prepare(
    `SELECT h.*, c.title AS course_title, l.title AS lesson_title, cl.name AS class_name
     FROM homework_submissions h
     LEFT JOIN courses c ON c.id = h.course_id
     LEFT JOIN lessons l ON l.id = h.lesson_id
     LEFT JOIN classes cl ON cl.id = h.class_id
     WHERE h.id = ?`,
  )
  .get(id)

if (!sub) {
  console.log(`提交 #${id} 不存在`)
  db.close()
  process.exit(0)
}

console.log(`=== 提交 #${sub.id} ===`)
console.log(`学生姓名：${sub.student_name}`)
console.log(`学号：${sub.student_no || '（空）'}`)
console.log(`课程：${sub.course_title}（#${sub.course_id}）`)
console.log(`课时：${sub.lesson_title}（#${sub.lesson_id}）`)
console.log(`班级：${sub.class_name ?? '（无）'}`)
console.log(`来源 IP：${sub.client_ip}`)
console.log(`提交时间：${sub.created_at}`)
console.log(`重复标记：${sub.duplicate_flag}`)
console.log(`状态：${sub.status}`)

const files = db
  .prepare(
    `SELECT r.id, r.name, r.size_bytes, r.storage_key, r.status, hf.sort_order
     FROM homework_submission_files hf
     JOIN resources r ON r.id = hf.resource_id
     WHERE hf.submission_id = ?
     ORDER BY hf.sort_order`,
  )
  .all(id)

console.log(`\n=== 关联文件 ${files.length} 个 ===`)
let total = 0
for (const f of files) {
  const path = join('storage/objects', f.storage_key)
  const exists = existsSync(path)
  const actual = exists ? statSync(path).size : 0
  total += Number(f.size_bytes)
  console.log(`  #${f.id} ${f.name}`)
  console.log(`     ${(Number(f.size_bytes) / 1024 ** 2).toFixed(2)} MB，状态 ${f.status}，磁盘${exists ? '存在' : '缺失'}`)
}
console.log(`\n合计：${(total / 1024 ** 3).toFixed(2)} GB`)

db.close()
