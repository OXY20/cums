/**
 * 输出数据库全部表的建表语句与列信息。
 *
 * 只读查询。
 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('data/classroom.db', { readOnly: true })

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()

for (const { name } of tables) {
  const cols = db.prepare(`PRAGMA table_info(${name})`).all()
  const n = db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c
  console.log(`\n== ${name} (${n} rows) ==`)
  console.log('  ' + cols.map((c) => `${c.name}:${c.type}`).join(', '))
}

db.close()
