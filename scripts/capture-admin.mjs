// 教师端页面截图：先登录获取令牌，再注入浏览器后截图。
//
// 用法：node scripts/capture-admin.mjs [baseUrl] [输出目录]

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

function capture(url, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(here, 'capture.mjs'), url, join(OUT, file), '1440', '1000'],
      {
        stdio: 'inherit',
        // 通过环境变量传递令牌，避免出现在命令行参数中
        env: { ...process.env, CAPTURE_TOKEN: token },
      },
    )
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`截图失败：${file}`))))
  })
}

const pages = [
  { url: `${BASE}/admin/console`, file: 'admin-console.png' },
  { url: `${BASE}/admin/courses`, file: 'admin-courses.png' },
  { url: `${BASE}/admin/courses/1`, file: 'admin-course-detail.png' },
  { url: `${BASE}/admin/resources`, file: 'admin-resources.png' },
  { url: `${BASE}/admin/system`, file: 'admin-system.png' },
]

for (const page of pages) {
  await capture(page.url, page.file)
}

console.log(`\n教师端截图已保存到 ${OUT}`)
