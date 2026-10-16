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

/** 时间戳格式化；后端返回 `YYYY-MM-DD HH:MM:SS` */
export function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  return value.replace('T', ' ').slice(0, 19)
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
