/**
 * 清理「名单与作业统计」相关测试数据。
 *
 * 与 cleanup-test-data.mjs 互补：那个按课程标题清理，
 * 这个额外处理班级、名单、以及关联的文件资源。
 *
 * 默认预演，加 --yes 才执行。
 *
 * 用法：
 *   node scripts/cleanup-roster-data.mjs          # 预演
 *   node scripts/cleanup-roster-data.mjs --yes    # 执行
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--yes')

/** 验证脚本生成的测试数据前缀 */
const TEST_PREFIXES = [
  '名单测试班-',
  '名单测试课程-',
  '重复判定班-',
  '重复判定课程-',
  '界面测试班-',
  '界面测试课程-',
  '时区测试班-',
  '时区测试课程-',
  '速度测试班-',
  '速度测试课程-',
  '速度截图班-',
  '空名单班-',
  '选人测试班-',
  '选人测试课程-',
  '无名单选人班-',
  '无名单选人课程-',
  '调试班-',
  '调试课-',
]

const db = new DatabaseSync('data/classroom.db')
const objectsDir = 'storage/objects'
const matches = (name) => TEST_PREFIXES.some((p) => name.startsWith(p))

console.log(apply ? '=== 执行清理 ===' : '=== 预演（加 --yes 才会删除）===')
console.log('')

const testCourses = db.prepare('SELECT id, title FROM courses').all().filter((c) => matches(c.title))
const testClasses = db.prepare('SELECT id, name FROM classes').all().filter((c) => matches(c.name))

console.log(`[1] 待删课程：${testCourses.length} 门`)
for (const c of testCourses) console.log(`    #${c.id} ${c.title}`)

console.log(`\n[2] 待删班级：${testClasses.length} 个`)
for (const c of testClasses) console.log(`    #${c.id} ${c.name}`)

// 关联提交与文件
const courseIds = testCourses.map((c) => c.id)
let submissions = []
if (courseIds.length > 0) {
  const ph = courseIds.map(() => '?').join(',')
  submissions = db.prepare(`SELECT id FROM homework_submissions WHERE course_id IN (${ph})`).all(...courseIds)
}
const subIds = submissions.map((s) => s.id)

let resources = []
if (subIds.length > 0) {
  const ph = subIds.map(() => '?').join(',')
  resources = db
    .prepare(
      `SELECT DISTINCT r.id, r.storage_key, r.size_bytes
       FROM resources r
       JOIN homework_submission_files hf ON hf.resource_id = r.id
       WHERE hf.submission_id IN (${ph})`,
    )
    .all(...subIds)
}

const totalBytes = resources.reduce((s, r) => s + Number(r.size_bytes), 0)
console.log(`\n[3] 关联提交：${subIds.length} 条，文件：${resources.length} 个，${(totalBytes / 1024 ** 2).toFixed(2)} MB`)

if (apply) {
  db.exec('BEGIN')
  try {
    if (subIds.length > 0) {
      const ph = subIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM homework_submission_files WHERE submission_id IN (${ph})`).run(...subIds)
      db.prepare(`DELETE FROM homework_submissions WHERE id IN (${ph})`).run(...subIds)
    }

    let removedFiles = 0
    for (const r of resources) {
      db.prepare('DELETE FROM lesson_resources WHERE resource_id = ?').run(r.id)
      db.prepare('DELETE FROM resources WHERE id = ?').run(r.id)
      const path = join(objectsDir, r.storage_key)
      if (existsSync(path)) {
        try {
          unlinkSync(path)
          removedFiles += 1
        } catch {
          /* 占用中跳过 */
        }
      }
    }

    // 删除顺序很重要：课堂场次引用了课时与班级（ON DELETE RESTRICT），
    // 必须先清掉场次才能删课时和班级。
    if (courseIds.length > 0) {
      const ph = courseIds.map(() => '?').join(',')
      const lessonIds = db
        .prepare(`SELECT id FROM lessons WHERE course_id IN (${ph})`)
        .all(...courseIds)
        .map((l) => l.id)

      if (lessonIds.length > 0) {
        const lph = lessonIds.map(() => '?').join(',')
        db.prepare(`DELETE FROM session_events WHERE session_id IN (
            SELECT id FROM classroom_sessions WHERE lesson_id IN (${lph})
          )`).run(...lessonIds)
        db.prepare(`DELETE FROM classroom_sessions WHERE lesson_id IN (${lph})`).run(...lessonIds)
      }

      // 班级相关的场次也要清（可能引用了其他课程的课时）
      if (testClasses.length > 0) {
        const cph = testClasses.map(() => '?').join(',')
        const classIds = testClasses.map((c) => c.id)
        db.prepare(`DELETE FROM session_events WHERE session_id IN (
            SELECT id FROM classroom_sessions WHERE class_id IN (${cph})
          )`).run(...classIds)
        db.prepare(`DELETE FROM classroom_sessions WHERE class_id IN (${cph})`).run(...classIds)
      }

      db.prepare(`DELETE FROM courses WHERE id IN (${ph})`).run(...courseIds)
    }
    if (testClasses.length > 0) {
      const ph = testClasses.map(() => '?').join(',')
      db.prepare(`DELETE FROM classes WHERE id IN (${ph})`).run(...testClasses.map((c) => c.id))
    }

    db.exec('COMMIT')
    console.log(`\n已删除 ${testCourses.length} 门课程、${testClasses.length} 个班级、${subIds.length} 条提交、${removedFiles} 个文件`)
  } catch (err) {
    db.exec('ROLLBACK')
    console.error(`清理失败已回滚：${err.message}`)
    process.exitCode = 1
  }
}

const rc = db.prepare('SELECT COUNT(*) c FROM courses').get()
const rcl = db.prepare('SELECT COUNT(*) c FROM classes').get()
const rs = db.prepare('SELECT COUNT(*) c FROM homework_submissions').get()
const rr = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(size_bytes),0) s FROM resources').get()
const rstu = db.prepare('SELECT COUNT(*) c FROM class_students').get()

console.log('\n=== 结果 ===')
console.log(`课程 ${rc.c} 门 / 班级 ${rcl.c} 个 / 名单 ${rstu.c} 人 / 提交 ${rs.c} 条 / 资源 ${rr.c} 个（${(Number(rr.s) / 1024 ** 2).toFixed(2)} MB）`)

db.close()
