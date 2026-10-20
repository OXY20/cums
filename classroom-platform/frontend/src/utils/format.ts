/**
 * 通用格式化工具。
 */

/** 人类可读的文件大小 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/** 补零到两位 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 时间戳格式化：把后端时间转成**运行设备本地时区**显示。
 *
 * 后端时间有两种来源，格式不同：
 *
 * | 来源 | 示例 | 时区 |
 * |------|------|------|
 * | SQLite `datetime('now')` | `2026-10-19 17:28:13` | UTC，**无时区标记** |
 * | chrono `Utc::now().to_rfc3339()` | `2026-10-19T17:28:13.123+00:00` | UTC，带标记 |
 *
 * 第一种必须显式补 `Z` 再解析。否则 `new Date('2026-10-19 17:28:13')`
 * 会被 JavaScript 当成**本地时间**，在东八区就凭空多出 8 小时偏差——
 * 这正是"提交时间比实际早 8 小时"的原因。
 *
 * 输出格式保持 `YYYY-MM-DD HH:MM:SS`，与后端一致，便于肉眼比对。
 */
export function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const text = value.trim()
  if (!text) return '—'

  // 已经带时区标记（Z 或 ±HH:MM）的直接解析，没有的按 UTC 补 Z
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)
  const iso = hasZone ? text : `${text.replace(' ', 'T')}Z`

  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    // 解析失败时退回原样展示（截断到秒），至少不显示 Invalid Date
    return text.replace('T', ' ').slice(0, 19)
  }

  // 取本地时区的年月日时分秒，而不是 toISOString（那还是 UTC）
  const year = date.getFullYear()
  const month = pad2(date.getMonth() + 1)
  const day = pad2(date.getDate())
  const hour = pad2(date.getHours())
  const minute = pad2(date.getMinutes())
  const second = pad2(date.getSeconds())
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

/** 课堂状态中文标签 */
export function sessionStatusText(status: string): string {
  switch (status) {
    case 'running':
      return '进行中'
    case 'paused':
      return '已暂停'
    case 'ended':
      return '已结束'
    default:
      return status
  }
}

/** 课程状态中文标签 */
export function courseStatusText(status: string): string {
  switch (status) {
    case 'draft':
      return '草稿'
    case 'published':
      return '已发布'
    case 'archived':
      return '已停用'
    default:
      return status
  }
}

/** 资源状态中文标签 */
export function resourceStatusText(status: string): string {
  switch (status) {
    case 'ready':
      return '可用'
    case 'staging':
      return '上传中'
    case 'missing':
      return '文件缺失'
    case 'corrupt':
      return '校验失败'
    default:
      return status
  }
}

/** 秒数转可读时长 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours} 小时 ${minutes} 分钟`
}

/** 提交状态中文标签 */
export function submissionStatusText(status: string): string {
  switch (status) {
    case 'submitted':
      return '已提交'
    case 'reviewed':
      return '已查看'
    case 'flagged':
      return '已标记问题'
    default:
      return status
  }
}

/**
 * 上传速度，单位 MB/s。
 *
 * 按 1 MB = 1024 KB = 1048576 字节换算，与 [formatBytes] 的进制保持一致，
 * 避免"进度条显示 10 MB、速度显示 9.5 MB/s"这种自相矛盾。
 *
 * 小数值保留两位：上传速度在 0.01–0.1 MB/s 时若只保留一位会全部显示成 0.0，
 * 学生看不出网络是否在动。
 */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '— MB/s'
  const mbps = bytesPerSecond / (1024 * 1024)
  if (mbps >= 10) return `${mbps.toFixed(1)} MB/s`
  if (mbps >= 0.01) return `${mbps.toFixed(2)} MB/s`
  return '< 0.01 MB/s'
}

/**
 * 剩余时间的可读描述。
 *
 * 未知或过小时返回 `—`：剩余时间基于瞬时速度推算，开头几秒抖动很大，
 * 给出"还剩 1 秒"这种数字反而误导。
 */
export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.ceil(seconds)
  if (total < 60) return `约 ${total} 秒`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes < 60) return rest > 0 ? `约 ${minutes} 分 ${rest} 秒` : `约 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes > 0 ? `约 ${hours} 小时 ${restMinutes} 分` : `约 ${hours} 小时`
}
