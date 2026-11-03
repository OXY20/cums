/**
 * 安装状态缓存。
 *
 * 路由守卫与安装向导都需要读写「是否已完成安装」，
 * 抽成独立模块避免 `router` 与 `SetupView` 之间形成循环依赖。
 */

/** 安装状态缓存：`null` 表示尚未查询。 */
let installed: boolean | null = null

/** 拉取安装状态；失败时保守地视为「未安装」，引导用户走向导。 */
export async function fetchInstalled(): Promise<boolean> {
  if (installed !== null) return installed
  try {
    const res = await fetch('/api/setup/status')
    if (!res.ok) {
      installed = false
      return installed
    }
    const data = (await res.json()) as { installed: boolean }
    installed = data.installed === true
  } catch {
    installed = false
  }
  return installed
}

/** 安装完成后刷新缓存，避免继续跳转向导。 */
export function markInstalled(): void {
  installed = true
}
