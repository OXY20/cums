// 批量截图：登录后截取学生端与教师端关键页面。
//
// 用法：node scripts/capture-all.mjs [baseUrl] [输出目录]

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'
const here = dirname(fileURLToPath(import.meta.url))
const OUT = process.argv[3] ?? join(here, '..', 'docs', 'screenshots')

mkdirSync(OUT, { recursive: true })

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }),
})
const { token } = await loginRes.json()
if (!token) {
  console.error('登录失败，无法获取令牌')
  process.exit(2)
}
console.log('已获取登录令牌')

/** 顺序执行截图，避免多个 CDP 标签页互相干扰 */
function capture(url, file, withToken) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(here, 'capture.mjs'), url, join(OUT, file), '1440', '1000'],
      {
        stdio: 'inherit',
        env: { ...process.env, ...(withToken ? { CAPTURE_TOKEN: token } : {}) },
      },
    )
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`截图失败：${file}`))))
  })
}

const shots = [
  { url: `${BASE}/student`, file: 'student-home.png', auth: false },
  { url: `${BASE}/student/courses/1`, file: 'student-course.png', auth: false },
  { url: `${BASE}/login`, file: 'login.png', auth: false },
  { url: `${BASE}/admin/console`, file: 'admin-console.png', auth: true },
  { url: `${BASE}/admin/courses`, file: 'admin-courses.png', auth: true },
  { url: `${BASE}/admin/courses/1`, file: 'admin-course-detail.png', auth: true },
  { url: `${BASE}/admin/resources`, file: 'admin-resources.png', auth: true },
  { url: `${BASE}/admin/system`, file: 'admin-system.png', auth: true },
]

for (const shot of shots) {
  await capture(shot.url, shot.file, shot.auth)
}

console.log(`\n全部截图已保存到 ${OUT}`)
