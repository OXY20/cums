/**
 * 按课时列出提交、批改与名单人数，用于确认演示数据的分布是否合理。
 *
 * 只读查询。
 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('data/classroom.db', { readOnly: true })

const rows = db
  .prepare(
    `SELECT l.id,
            c.title AS course,
            l.title AS lesson,
            cl.name AS klass,
            COUNT(h.id) AS subs,
            SUM(CASE WHEN h.review_label <> '' OR h.review_score IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
            (SELECT COUNT(*) FROM class_students s WHERE s.class_id = MAX(h.class_id)) AS roster
     FROM lessons l
     JOIN courses c ON c.id = l.course_id
     LEFT JOIN homework_submissions h ON h.lesson_id = l.id
     LEFT JOIN classes cl ON cl.id = h.class_id
     GROUP BY l.id
     ORDER BY l.id`,
  )
  .all()

console.log('课时\t课程\t班级\t提交\t批改\t名单\t未交')
for (const r of rows) {
  const roster = r.roster ?? 0
  const subs = r.subs ?? 0
  const reviewed = r.reviewed ?? 0
  // 提交份数可能多于人数（重复提交），未交按名单人数与去重人数算更准，
  // 这里只做粗略展示，精确口径由接口负责
  const missing = roster > 0 ? Math.max(0, roster - subs) : 0
  console.log(
    `${r.id}\t${r.course}\t${r.klass ?? '-'}\t${subs}\t${reviewed}\t${roster}\t${missing}`,
  )
}

console.log('\n== 批改时间范围 ==')
const range = db
  .prepare(
    `SELECT MIN(created_at) AS first_sub, MAX(created_at) AS last_sub,
            MIN(reviewed_at) AS first_review, MAX(reviewed_at) AS last_review
     FROM homework_submissions`,
  )
  .get()
console.log(JSON.stringify(range, null, 1))

db.close()
