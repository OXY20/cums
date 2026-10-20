/**
 * 检查存储占用，列出可清理的测试文件。
 *
 * 用法：node scripts/inspect-storage.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { statSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dbPath = 'data/classroom.db'
const objectsDir = 'storage/objects'
const stagingDir = 'storage/staging'

const db = new DatabaseSync(dbPath)

function gb(bytes) {
  return `${(Number(bytes) / 1024 ** 3).toFixed(2)} GB`
}

function mb(bytes) {
  return `${(Number(bytes) / 1024 ** 2).toFixed(2)} MB`
}

console.log('=== 数据库中的资源记录 ===')
const totals = db
  .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes),0) AS s FROM resources')
  .get()
console.log(`资源条数：${totals.c}，声明总大小：${gb(totals.s)}`)

console.log('\n=== 大于 100 MB 的资源 ===')
const big = db
  .prepare(
    'SELECT id, name, size_bytes, status, storage_key, uploaded_by, created_at FROM resources WHERE size_bytes > 100000000 ORDER BY size_bytes DESC',
  )
  .all()
for (const row of big) {
  const path = join(objectsDir, row.storage_key)
  const exists = existsSync(path)
  const actual = exists ? statSync(path).size : 0
  console.log(`  #${row.id} ${row.name}`)
  console.log(`     声明 ${mb(row.size_bytes)} / 实际 ${exists ? mb(actual) : '文件缺失'}`)
  console.log(`     状态 ${row.status}，上传者 ${row.uploaded_by ?? '匿名'}，${row.created_at}`)
  console.log(`     路径 ${path}`)
}

console.log('\n=== 这些资源是否被提交记录引用 ===')
for (const row of big) {
  const links = db
    .prepare(
      `SELECT hf.submission_id, hs.student_name, hs.lesson_id
       FROM homework_submission_files hf
       JOIN homework_submissions hs ON hs.id = hf.submission_id
       WHERE hf.resource_id = ?`,
    )
    .all(row.id)
  if (links.length === 0) {
    console.log(`  #${row.id} 未被任何提交引用`)
  } else {
    for (const l of links) {
      console.log(`  #${row.id} ← 提交 #${l.submission_id}（${l.student_name}，课时 ${l.lesson_id}）`)
    }
  }
}

console.log('\n=== 实际磁盘占用 ===')
function dirSize(dir) {
  if (!existsSync(dir)) return { bytes: 0, files: 0 }
  let bytes = 0
  let files = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = dirSize(full)
      bytes += sub.bytes
      files += sub.files
    } else {
      bytes += statSync(full).size
      files += 1
    }
  }
  return { bytes, files }
}

const obj = dirSize(objectsDir)
const stg = dirSize(stagingDir)
console.log(`objects: ${gb(obj.bytes)}（${obj.files} 个文件）`)
console.log(`staging: ${gb(stg.bytes)}（${stg.files} 个文件）`)

console.log('\n=== 孤立文件（磁盘有、数据库无记录） ===')
const knownKeys = new Set(
  db.prepare('SELECT storage_key FROM resources').all().map((r) => r.storage_key),
)
const orphans = []
function scan(dir, prefix = '') {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) scan(join(dir, entry.name), rel)
    else if (!knownKeys.has(rel)) orphans.push({ rel, size: statSync(join(dir, entry.name)).size })
  }
}
scan(objectsDir)
if (orphans.length === 0) {
  console.log('  无')
} else {
  for (const o of orphans) console.log(`  ${mb(o.size)}  ${o.rel}`)
  console.log(`  合计 ${gb(orphans.reduce((s, o) => s + o.size, 0))}`)
}

console.log('\n=== 失效记录（数据库有、磁盘无文件） ===')
let missingCount = 0
for (const r of db.prepare('SELECT id, name, storage_key FROM resources').all()) {
  if (!existsSync(join(objectsDir, r.storage_key))) {
    missingCount += 1
    if (missingCount <= 10) console.log(`  #${r.id} ${r.name} → ${r.storage_key}`)
  }
}
if (missingCount === 0) console.log('  无')
else console.log(`  共 ${missingCount} 条`)

db.close()
