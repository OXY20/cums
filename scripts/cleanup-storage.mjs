/**
 * 清理测试数据与占用的存储空间。
 *
 * 默认只做「预演」，打印将要删除的内容；加 --yes 才真正执行。
 *
 * 用法：
 *   node scripts/cleanup-storage.mjs                # 预演
 *   node scripts/cleanup-storage.mjs --yes          # 执行
 *   node scripts/cleanup-storage.mjs --min-mb 100 --yes   # 只清理大于 100 MB 的
 *
 * 清理范围（保守策略）：
 * 1. 孤立文件：磁盘存在但数据库无对应资源记录；
 * 2. 失效记录：数据库有记录但磁盘文件已丢失；
 * 3. 指定大小的测试资源：连同其提交记录一并删除（可选，需显式指定阈值）；
 * 4. staging 目录中的残留临时文件。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--yes')
const minMbIndex = args.indexOf('--min-mb')
const minMb = minMbIndex >= 0 ? Number(args[minMbIndex + 1]) : null
const keepFiles = args.includes('--keep-files')

const db = new DatabaseSync('data/classroom.db')
const objectsDir = 'storage/objects'
const stagingDir = 'storage/staging'

const fmt = (bytes) => {
  const n = Number(bytes)
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

console.log(apply ? '=== 执行清理 ===' : '=== 预演（加 --yes 才会真正删除）===')
console.log('')

// ---------------------------------------------------------------------------
// 1. 孤立文件
// ---------------------------------------------------------------------------
const knownKeys = new Set(
  db.prepare('SELECT storage_key FROM resources').all().map((r) => r.storage_key),
)

const orphanFiles = []
function scanOrphans(dir, prefix = '') {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = join(dir, entry.name)
    if (entry.isDirectory()) scanOrphans(full, rel)
    else if (!knownKeys.has(rel)) orphanFiles.push({ rel, full, size: statSync(full).size })
  }
}
scanOrphans(objectsDir)

console.log(`[1] 孤立文件（磁盘有、数据库无记录）：${orphanFiles.length} 个，${fmt(orphanFiles.reduce((s, f) => s + f.size, 0))}`)
for (const f of orphanFiles.slice(0, 10)) console.log(`    ${fmt(f.size)}  ${f.rel}`)
if (orphanFiles.length > 10) console.log(`    …另有 ${orphanFiles.length - 10} 个`)

if (apply) {
  for (const f of orphanFiles) {
    try {
      unlinkSync(f.full)
    } catch (err) {
      console.warn(`    删除失败 ${f.rel}：${err.message}`)
    }
  }
  console.log(`    已删除 ${orphanFiles.length} 个孤立文件`)
}

// ---------------------------------------------------------------------------
// 2. 失效记录
// ---------------------------------------------------------------------------
const missing = db
  .prepare('SELECT id, name, storage_key FROM resources')
  .all()
  .filter((r) => !existsSync(join(objectsDir, r.storage_key)))

console.log(`\n[2] 失效记录（数据库有、磁盘无文件）：${missing.length} 条`)
for (const m of missing.slice(0, 10)) console.log(`    #${m.id} ${m.name}`)
if (missing.length > 10) console.log(`    …另有 ${missing.length - 10} 条`)

if (apply && missing.length > 0) {
  const delLink = db.prepare('DELETE FROM homework_submission_files WHERE resource_id = ?')
  const delRes = db.prepare('DELETE FROM resources WHERE id = ?')
  for (const m of missing) {
    delLink.run(m.id)
    delRes.run(m.id)
  }
  console.log(`    已删除 ${missing.length} 条失效记录`)
}

// ---------------------------------------------------------------------------
// 3. 按大小清理测试资源（需显式指定 --min-mb）
// ---------------------------------------------------------------------------
if (minMb !== null) {
  const big = db
    .prepare(
      'SELECT id, name, size_bytes, storage_key FROM resources WHERE size_bytes >= ? ORDER BY size_bytes DESC',
    )
    .all(Math.round(minMb * 1024 * 1024))

  const totalBytes = big.reduce((s, r) => s + Number(r.size_bytes), 0)
  console.log(`\n[3] 大于 ${minMb} MB 的资源：${big.length} 个，${fmt(totalBytes)}`)

  for (const r of big) {
    const links = db
      .prepare(
        `SELECT hf.submission_id, hs.student_name, hs.created_at
         FROM homework_submission_files hf
         JOIN homework_submissions hs ON hs.id = hf.submission_id
         WHERE hf.resource_id = ?`,
      )
      .all(r.id)
    console.log(`    #${r.id} ${r.name}  ${fmt(r.size_bytes)}`)
    for (const l of links) {
      console.log(`       ← 提交 #${l.submission_id}（${l.student_name}，${l.created_at}）`)
    }
  }

  if (apply) {
    // 先删提交记录，再删资源与文件，避免留下悬空外键
    const affectedSubmissions = new Set()
    for (const r of big) {
      const links = db
        .prepare('SELECT submission_id FROM homework_submission_files WHERE resource_id = ?')
        .all(r.id)
      for (const l of links) affectedSubmissions.add(l.submission_id)
    }

    // 只删除「其全部文件都在本次清理范围内」的提交，避免误删还含其他文件的提交
    const bigIds = new Set(big.map((r) => r.id))
    let removedSubmissions = 0
    for (const sid of affectedSubmissions) {
      const files = db
        .prepare(
          `SELECT r.id FROM homework_submission_files hf
           JOIN resources r ON r.id = hf.resource_id
           WHERE hf.submission_id = ?`,
        )
        .all(sid)
      const allInScope = files.every((f) => bigIds.has(f.id))
      if (!allInScope) {
        console.log(`    跳过提交 #${sid}：还包含其他文件`)
        continue
      }
      db.prepare('DELETE FROM homework_submission_files WHERE submission_id = ?').run(sid)
      db.prepare('DELETE FROM homework_submissions WHERE id = ?').run(sid)
      removedSubmissions += 1
    }

    let removedFiles = 0
    for (const r of big) {
      db.prepare('DELETE FROM homework_submission_files WHERE resource_id = ?').run(r.id)
      db.prepare('DELETE FROM resources WHERE id = ?').run(r.id)
      if (!keepFiles) {
        const path = join(objectsDir, r.storage_key)
        if (existsSync(path)) {
          try {
            unlinkSync(path)
            removedFiles += 1
          } catch (err) {
            console.warn(`    删除文件失败 ${r.storage_key}：${err.message}`)
          }
        }
      }
    }
    console.log(`    已删除 ${big.length} 条资源、${removedSubmissions} 条提交、${removedFiles} 个文件`)
  }
} else {
  console.log('\n[3] 未指定 --min-mb，跳过按大小清理')
  const biggest = db
    .prepare('SELECT name, size_bytes FROM resources ORDER BY size_bytes DESC LIMIT 3')
    .all()
  if (biggest.length > 0) {
    console.log('    当前最大的资源：')
    for (const b of biggest) console.log(`      ${fmt(b.size_bytes)}  ${b.name}`)
    console.log('    如需清理，加 --min-mb <阈值> 重新运行')
  }
}

// ---------------------------------------------------------------------------
// 4. staging 残留
// ---------------------------------------------------------------------------
const stagingFiles = []
function scanStaging(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) scanStaging(full)
    else stagingFiles.push({ full, size: statSync(full).size })
  }
}
scanStaging(stagingDir)

console.log(`\n[4] staging 残留临时文件：${stagingFiles.length} 个，${fmt(stagingFiles.reduce((s, f) => s + f.size, 0))}`)
if (apply && stagingFiles.length > 0) {
  for (const f of stagingFiles) {
    try {
      unlinkSync(f.full)
    } catch {
      /* 占用中则跳过 */
    }
  }
  // 清掉空目录
  try {
    rmSync(stagingDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  console.log(`    已清理`)
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const after = db
  .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes),0) AS s FROM resources')
  .get()
console.log(`\n=== 结果 ===`)
console.log(`资源记录：${after.c} 条，声明总大小 ${fmt(after.s)}`)

let diskBytes = 0
let diskFiles = 0
function dirSize(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) dirSize(full)
    else {
      diskBytes += statSync(full).size
      diskFiles += 1
    }
  }
}
dirSize(objectsDir)
console.log(`磁盘占用：${fmt(diskBytes)}（${diskFiles} 个文件）`)

db.close()
