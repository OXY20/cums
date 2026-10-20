/**
 * 清空课堂平台的全部业务数据，保留账号与迁移记录。
 *
 * 用途：测试过程中累积了大量「xxx测试课程-时间戳」之类的记录，
 * 直接重置数据库比逐条调用删除接口更快，也不会因为「有授课记录不能删」
 * 的外键保护而卡住。
 *
 * 用法：
 *   node scripts/reset-data.mjs          # 只统计，不删除
 *   node scripts/reset-data.mjs --yes    # 真正执行
 *
 * 注意：执行前必须先停止服务，否则 SQLite 写锁会冲突。
 */
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const APPLY = process.argv.includes('--yes')
const DB_PATH = 'data/classroom.db'
const OBJECTS_DIR = 'storage/objects'
const STAGING_DIR = 'storage/staging'

/**
 * 删除顺序按外键依赖排列：先删引用方，再删被引用方。
 *
 * `classroom_sessions` 对 `classes` / `lessons` 是 ON DELETE RESTRICT，
 * 必须先把授课记录清掉，否则删课程和班级会被拒绝。
 */
const ORDER = [
  'homework_submission_files',
  'homework_submissions',
  'session_events',
  'download_jobs',
  'classroom_sessions',
  'lesson_blocks',
  'lesson_resources',
  'lesson_steps',
  'resource_bundles',
  'resources',
  'lessons',
  'courses',
  'class_students',
  'teacher_classes',
  'classes',
  'audit_logs',
]

const db = new DatabaseSync(DB_PATH)

db.exec('PRAGMA foreign_keys = OFF')

console.log('待清理数据：')
const before = {}
for (const table of ORDER) {
  const n = db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get().c
  before[table] = n
  console.log(`  ${table.padEnd(26)} ${String(n).padStart(6)}`)
}

/** 统计目录下的文件数量与总字节数。 */
function dirStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (path) => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        files += 1
        try {
          bytes += statSync(full).size
        } catch {
          /* 并发删除时忽略 */
        }
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

const objects = dirStats(OBJECTS_DIR)
const staging = dirStats(STAGING_DIR)
console.log(`\n存储对象：${objects.files} 个文件，${(objects.bytes / 1024 / 1024).toFixed(1)} MiB`)
console.log(`暂存目录：${staging.files} 个文件`)

if (!APPLY) {
  console.log('\n这是预演。确认无误后加 --yes 执行。')
  db.close()
  process.exit(0)
}

db.exec('BEGIN')
for (const table of ORDER) {
  db.prepare(`DELETE FROM "${table}"`).run()
}
// 重置自增序列，让新数据的 ID 从 1 开始，看起来更像全新部署
db.prepare(
  `DELETE FROM sqlite_sequence WHERE name IN (${ORDER.map((t) => `'${t}'`).join(',')})`,
).run()
db.exec('COMMIT')
db.exec('VACUUM')
db.exec('PRAGMA foreign_keys = ON')

// 清理磁盘文件：数据库记录已删，文件留着就是孤儿
for (const dir of [OBJECTS_DIR, STAGING_DIR]) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    continue
  }
  for (const entry of entries) {
    rmSync(join(dir, entry.name), { recursive: true, force: true })
  }
}

console.log('\n已清空：')
for (const table of ORDER) {
  const after = db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get().c
  if (after !== 0) console.log(`  警告：${table} 仍有 ${after} 行`)
}
const objectsAfter = dirStats(OBJECTS_DIR)
console.log(`存储对象：${objectsAfter.files} 个文件（应为 0）`)
console.log('账号与迁移记录已保留。')

db.close()
