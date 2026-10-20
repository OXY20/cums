/**
 * 按课程统计课时、提交、资源数量，用于判断哪些是测试残留。
 *
 * 只读查询。
 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('data/classroom.db', { readOnly: true })

const rows = db
  .prepare(
    `SELECT c.id, c.title, c.status, c.created_at,
            (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lessons,
            (SELECT COUNT(*) FROM homework_submissions s WHERE s.course_id = c.id) AS subs,
            (SELECT COUNT(*) FROM classroom_sessions cs
               JOIN lessons l2 ON l2.id = cs.lesson_id WHERE l2.course_id = c.id) AS sessions
     FROM courses c ORDER BY c.id`,
  )
  .all()

console.log('id\ttitle\tstatus\tlessons\tsubs\tsessions\tcreated')
for (const r of rows) {
  console.log(
    `${r.id}\t${r.title}\t${r.status}\t${r.lessons}\t${r.subs}\t${r.sessions}\t${r.created_at}`,
  )
}

console.log('\n== 非测试命中的课程 ==')
for (const r of rows) {
  if (!/测试|冒烟|演示|截图|调试/.test(r.title)) {
    console.log(`${r.id}\t${r.title}\t课时 ${r.lessons} 提交 ${r.subs} 授课 ${r.sessions}`)
  }
}

db.close()
