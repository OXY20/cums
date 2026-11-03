/**
 * API 客户端：统一处理认证头、错误格式与文件下载地址。
 */

/** 后端错误响应结构 */
export interface ApiErrorBody {
  error: { code: string; message: string }
}

/** 业务异常 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const TOKEN_KEY = 'classroom.token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

/** 统一的请求封装 */
export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = 'GET', body } = options
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (response.status === 204) return undefined as T

  const text = await response.text()
  const payload = text ? JSON.parse(text) : null

  if (!response.ok) {
    const detail = payload as ApiErrorBody | null
    throw new ApiError(
      response.status,
      detail?.error?.code ?? 'unknown',
      detail?.error?.message ?? `请求失败（${response.status}）`,
    )
  }

  return payload as T
}

/** 提交凭证在下载地址上的参数名 */
const SUBMISSION_TOKEN_PARAM = 'submission_token'

/** 教师端预览票在下载地址上的参数名 */
const PREVIEW_TICKET_PARAM = 'preview_ticket'

/**
 * 当前正在查看的提交凭证。
 *
 * 作业文件的预览组件（`SubmissionPreview`）只拿到资源 ID，
 * 拿不到提交凭证。把「当前打开的是哪份提交」放在模块级，
 * 预览组件无需改动就能让图片 / 视频 / PDF 的内联地址带上凭证。
 * 教师端从不设置它，因此教学资源与教师端下载不受影响。
 */
let activeSubmissionToken: string | null = null

/** 设置 / 清除当前查看的提交凭证；传入 null 表示离开该提交 */
export function setActiveSubmissionToken(token: string | null): void {
  activeSubmissionToken = token && token.trim() ? token : null
}

/** 读取当前查看的提交凭证 */
export function getActiveSubmissionToken(): string | null {
  return activeSubmissionToken
}

/** 解析实际使用的凭证：显式传入优先，否则退回当前查看中的提交 */
function resolveSubmissionToken(submissionToken?: string | null): string {
  if (submissionToken && submissionToken.trim()) return submissionToken
  return activeSubmissionToken ?? ''
}

/**
 * 当前正在查看的教师端预览票。
 *
 * 与提交凭证同理：`<img>` / `<video>` / `<iframe>` 无法携带
 * `Authorization` 头，教师端详情接口为每个文件下发一张短时效票，
 * 由预览组件自动拼进地址。学生端从不设置它。
 */
let activePreviewTickets: Record<number, string> = {}

/** 登记一批预览票（键为资源 ID）；传入空对象表示清除 */
export function setPreviewTickets(tickets: Record<number, string> | null): void {
  activePreviewTickets = tickets ?? {}
}

/** 取某个资源的预览票 */
export function getPreviewTicket(resourceId: number): string | null {
  return activePreviewTickets[resourceId] ?? null
}

/** 把附加参数（提交凭证 / 预览票）拼到地址上 */
function appendFileParams(
  base: string,
  resourceId: number,
  submissionToken?: string | null,
): string {
  const params = new URLSearchParams()
  const token = resolveSubmissionToken(submissionToken)
  if (token) params.set(SUBMISSION_TOKEN_PARAM, token)

  // 教师端预览票与提交凭证互不冲突：服务端任一有效即放行
  const ticket = getPreviewTicket(resourceId)
  if (ticket) params.set(PREVIEW_TICKET_PARAM, ticket)

  const query = params.toString()
  if (!query) return base
  return base.includes('?') ? `${base}&${query}` : `${base}?${query}`
}

/**
 * 资源下载地址；浏览器将按 Content-Disposition 处理文件名。
 *
 * 教学资源公开可下载；**作业文件**属于学生的提交内容，匿名访问时
 * 服务端要求带上提交凭证，此时把 `submissionToken` 作为查询参数拼上。
 * 教师端带 Bearer 令牌访问，不需要传这个参数。
 */
export function fileUrl(resourceId: number, submissionToken?: string | null): string {
  return appendFileParams(`/files/${resourceId}`, resourceId, submissionToken)
}

/**
 * 内嵌预览地址。
 *
 * `inline=1` 让服务端返回 `Content-Disposition: inline`，
 * PDF / 图片 / 视频才能在预览弹窗里直接展示而不是触发下载。
 * 作业文件同样需要提交凭证，已有 `inline=1` 时用 `&` 追加。
 */
export function inlineFileUrl(resourceId: number, submissionToken?: string | null): string {
  return appendFileParams(`/files/${resourceId}?inline=1`, resourceId, submissionToken)
}

/**
 * 上传进度信息。
 *
 * 除百分比外同时给出已传/总字节数，让调用方能算速度与剩余时间。
 * 解析成结构化对象而不是单个百分比，是因为「还要多久」需要原始字节数，
 * 从百分比反推会丢失精度（大文件尤其明显）。
 */
export interface UploadProgress {
  /** 已上传字节数 */
  loaded: number
  /** 总字节数 */
  total: number
  /** 百分比，0–100 的整数 */
  percent: number
}

/**
 * 多文件提交（作业上传）。
 *
 * 与 [`uploadWithProgress`] 一样使用 XHR 以获得上传进度；
 * 区别在于可以附带表单字段与多个文件，对应作业提交接口。
 */
export function submitWithProgress<T>(
  path: string,
  files: File[],
  fields: Record<string, string>,
  onProgress?: (progress: UploadProgress) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) form.append(key, value)
    for (const file of files) form.append('file', file, file.name)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', path)

    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress({
          loaded: event.loaded,
          total: event.total,
          percent: Math.round((event.loaded / event.total) * 100),
        })
      }
    }

    xhr.onload = () => {
      let payload: unknown = null
      try {
        payload = JSON.parse(xhr.responseText)
      } catch {
        /* 保留 null，走通用错误分支 */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as T)
      } else {
        const detail = payload as ApiErrorBody | null
        reject(
          new ApiError(
            xhr.status,
            detail?.error?.code ?? 'submit_failed',
            detail?.error?.message ?? `提交失败（${xhr.status}）`,
          ),
        )
      }
    }

    xhr.onerror = () => reject(new ApiError(0, 'network_error', '网络错误，提交中断'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted', '提交已取消'))

    xhr.send(form)
  })
}

/**
 * 带进度的文件上传。
 *
 * 使用 XHR 而非 fetch：只有 XHR 能提供上传进度事件，
 * 大文件上传时教师需要看到进度与失败提示。
 */
export function uploadWithProgress<T>(
  path: string,
  file: File,
  onProgress?: (progress: UploadProgress) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file, file.name)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', path)

    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress({
          loaded: event.loaded,
          total: event.total,
          percent: Math.round((event.loaded / event.total) * 100),
        })
      }
    }

    xhr.onload = () => {
      let payload: unknown = null
      try {
        payload = JSON.parse(xhr.responseText)
      } catch {
        /* 保留 null，走通用错误分支 */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as T)
      } else {
        const detail = payload as ApiErrorBody | null
        reject(
          new ApiError(
            xhr.status,
            detail?.error?.code ?? 'upload_failed',
            detail?.error?.message ?? `上传失败（${xhr.status}）`,
          ),
        )
      }
    }

    xhr.onerror = () => reject(new ApiError(0, 'network_error', '网络错误，上传中断'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted', '上传已取消'))

    xhr.send(form)
  })
}

/** 根据文件名判断是否为图片，用于上传前过滤 */
export function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  return /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(file.name)
}

/** 根据文件名判断是否为视频 */
export function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true
  return /\.(mp4|webm|mov|mkv|avi)$/i.test(file.name)
}

/** 列表响应 */
export interface ListResponse<T> {
  items: T[]
  total: number
}

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface UserInfo {
  id: number
  username: string
  display_name: string
  role: 'admin' | 'teacher'
}

export interface LoginResponse {
  token: string
  user: UserInfo
  expires_in: number
}

export interface Course {
  id: number
  title: string
  description: string
  cover_key: string | null
  /** 封面图对应的资源 ID；为空表示未设置封面 */
  cover_resource_id: number | null
  status: 'draft' | 'published' | 'archived'
  created_at: string
  updated_at: string
  lesson_count: number
}

export interface Lesson {
  id: number
  course_id: number
  title: string
  sort_order: number
  content_json: string
  /** 富文本正文（已清洗的 HTML） */
  content_html: string
  /** 正文格式：html 为富文本，blocks 为旧版块结构 */
  content_format: 'html' | 'blocks'
  created_at: string
  updated_at: string
}

/** 资源用途：图片与视频内嵌展示，其余作为附件下载 */
export type ResourcePurpose = 'image' | 'video' | 'attachment'

export interface Resource {
  id: number
  name: string
  storage_key: string
  size_bytes: number
  sha256: string
  mime_type: string
  version: number
  status: 'staging' | 'ready' | 'missing' | 'corrupt'
  created_at: string
}

/** 课时关联的资源，含用途与排序 */
export interface LessonResource extends Resource {
  purpose: ResourcePurpose
  required: number
  sort_order: number
}

/** 正文块类型：文字与媒体按顺序混排 */
export type BlockType = 'text' | 'image' | 'video' | 'file'

export interface LessonBlock {
  id: number
  lesson_id: number
  block_type: BlockType
  text_content: string
  title: string
  resource_id: number | null
  sort_order: number
  /** 媒体块附带的资源信息 */
  resource_name: string | null
  resource_size: number | null
  resource_mime: string | null
}

/** 课时详情：一次返回正文块与关联资源 */
export interface LessonDetail extends Lesson {
  blocks: LessonBlock[]
  resources: LessonResource[]
}

export interface ClassroomSession {
  id: number
  class_id: number
  teacher_id: number
  lesson_id: number
  status: 'running' | 'paused' | 'ended'
  started_at: string
  paused_at: string | null
  ended_at: string | null
}

export interface CurrentSession {
  session: ClassroomSession
  class_name: string
  teacher_name: string
  course_title: string
  lesson_title: string
  lesson_content: Record<string, unknown>
  /** 富文本正文（已清洗的 HTML），为空时回退到 lesson_content */
  lesson_html: string
}

export interface ClassInfo {
  id: number
  name: string
  room_name: string
  is_active: number
  created_at: string
  updated_at: string
}

export interface Health {
  status: string
  version: string
  database: string
  uptime_seconds: number
  active_sessions: number
  active_downloads: number
  objects_bytes: number
}

export interface AuditLogEntry {
  id: number
  user_id: number | null
  action: string
  target_type: string
  target_id: string
  created_at: string
}

// ---------------------------------------------------------------------------
// 首次安装向导
// ---------------------------------------------------------------------------

/** 向导中可调整的基础配置 */
export interface SetupSummary {
  /** 监听地址，如 `0.0.0.0:8080` */
  bind: string
  /** 数据库文件路径（相对数据根目录） */
  database_path: string
  /** 资源目录（相对数据根目录） */
  storage_dir: string
  /** 令牌有效期（小时） */
  token_ttl_hours: number
}

/** 安装状态 */
export interface SetupStatus {
  /** 是否已完成安装 */
  installed: boolean
  /** 未安装时回显的当前配置，已安装时为 null */
  defaults: SetupSummary | null
}

/** 安装请求 */
export interface SetupInstallPayload {
  username: string
  password: string
  password_confirm: string
  display_name: string
  bind: string
  database_path: string
  storage_dir: string
  token_ttl_hours: number
}

/** 安装结果 */
export interface SetupInstallResult {
  ok: boolean
  username: string
  display_name: string
  message: string
}

// ---------------------------------------------------------------------------
// 作业提交
// ---------------------------------------------------------------------------

/** 提交状态：已提交 / 已查看 / 已标记问题 */
export type SubmissionStatus = 'submitted' | 'reviewed' | 'flagged'

/**
 * 审阅标签：好 / 通过 / 不通过 / 其他。
 *
 * 空字符串表示「尚未评价」，因此类型里带上 `''`。
 * 四类标签覆盖教师实际批改习惯：多数是通过，特别好的是好，
 * 需要退回重做的是不通过，其余需要单独沟通的归入其他。
 */
export type ReviewLabel = '' | 'good' | 'pass' | 'fail' | 'other'

/** 标签的展示顺序与配色，界面与统计共用同一份定义 */
export const REVIEW_LABEL_META: { value: ReviewLabel; text: string; type: string }[] = [
  { value: 'good', text: '好', type: 'success' },
  { value: 'pass', text: '通过', type: 'primary' },
  { value: 'fail', text: '不通过', type: 'danger' },
  { value: 'other', text: '其他', type: 'info' },
]

/** 取标签的中文名；未知值原样返回，便于排查 */
export function reviewLabelText(label: string): string {
  const found = REVIEW_LABEL_META.find((item) => item.value === label)
  return found ? found.text : label || '未评价'
}

/** 提交中的单个文件，字段与服务端 resources 对齐 */
export interface SubmissionFile {
  resource_id: number
  name: string
  size_bytes: number
  mime_type: string
  sha256: string
  /** 用途由服务端根据 MIME 与扩展名推断，决定预览方式 */
  purpose: ResourcePurpose
  sort_order: number
  /**
   * 教师端预览票。
   *
   * `<img>` / `<video>` / `<iframe>` 不会携带 `Authorization` 头，
   * 教师端必须把这张短时效票拼到地址上，否则预览会 403。
   * 学生端回读走提交凭证，因此该字段为空。
   */
  preview_ticket?: string
}

/** 一条作业提交记录 */
export interface Submission {
  id: number
  course_id: number
  lesson_id: number
  class_id: number | null
  session_id: number | null
  student_name: string
  /** 学号；未从名单选择时为空字符串 */
  student_no: string
  /** 服务端记录的来源地址，客户端无法伪造 */
  client_ip: string
  user_agent: string
  note: string
  /** 1 表示同一学生（按学号）或同一台设备在本课时已提交过 */
  duplicate_flag: number
  duplicate_of: number | null
  status: SubmissionStatus
  created_at: string
  course_title: string | null
  lesson_title: string | null
  class_name: string | null
  file_count: number
  /** 审阅标签；空字符串表示尚未评价 */
  review_label: ReviewLabel
  /** 审阅分数 0–100；未打分为 null */
  review_score: number | null
  /** 教师评语 */
  review_comment: string
  /** 最近一次审阅时间；未审阅为 null */
  reviewed_at: string | null
  /** 学生撤回提交的时间；未撤回为 null，撤回后记录仍保留供教师核对 */
  withdrawn_at: string | null
}

/** 提交详情：记录本体 + 文件列表 */
export interface SubmissionDetail extends Submission {
  files: SubmissionFile[]
  duplicate_of_name: string | null
}

/** 当前设备在本课时的提交摘要 */
export interface DeviceSubmission {
  /** 该设备已提交的记录数 */
  total: number
  /** 该设备最近一次提交 */
  latest: Submission
}

/**
 * 作业上传的服务端限制。
 *
 * 由服务端的 `status` 接口下发，前端据此做上传前预校验；
 * 不在前端写死数字，避免配置调整后界面提示与真实上限不一致。
 */
export interface SubmissionLimits {
  /** 一次提交允许的文件数上限 */
  max_files: number
  /** 单个文件的字节数上限 */
  max_file_bytes: number
  /** 单次提交所有文件合计的字节数上限 */
  max_total_bytes: number
}

/**
 * 课时提交状态，用于上传前提醒。
 *
 * 提示以 `device` 为准（这台机器是否交过），
 * `classTotal` 仅作背景数字，不指名道姓，避免把教师视角的信息暴露给学生端。
 */
export interface LessonSubmissionStatus {
  lesson_id: number
  class_id: number | null
  /** 本班该课时提交总数（不区分设备） */
  class_total: number
  /** 当前设备的提交情况；无提交时为 null */
  device: DeviceSubmission | null
  /** 服务端当前允许的上传上限 */
  limits: SubmissionLimits
}

/**
 * 提交接口的响应。
 *
 * `access_token` 是本次提交的凭证：学生端没有登录态，
 * 凭它可以回读自己的提交、撤回提交、下载作业文件。
 */
export interface CreateSubmissionResponse {
  submission: SubmissionDetail
  duplicate_warning: string | null
  /** 撤回截止时间（服务端时间）；null 表示不可撤回 */
  withdraw_deadline: string | null
  /** 提交凭证，前端需持久化保存 */
  access_token: string
}

export interface SubmitHomeworkInput {
  studentName: string
  /** 学号；从班级名单选择自己时带上，便于教师统计「谁没交」 */
  studentNo?: string
  lessonId: number
  classId?: number | null
  note?: string
  /** 本设备标识，用于判断「本设备是否已提交」 */
  deviceId?: string
  files: File[]
}

// ---------------------------------------------------------------------------
// 提交凭证（access_token）
// ---------------------------------------------------------------------------
//
// 学生端没有登录态，提交凭证是学生回读、撤回自己作业、下载作业文件的唯一凭据。
// 按课时存一份：学生在同一节课重新提交时，旧凭据失效，留最新那份即可。

/** 提交凭证的持久化键 */
const SUBMISSION_TOKENS_KEY = 'classroom.submission.tokens'

/** 一条提交凭证的持久化形态 */
export interface StoredSubmissionToken {
  /** 对应的提交 ID */
  submissionId: number
  /** 提交凭证 */
  token: string
  /** 记录时间（ISO 字符串），便于排查过期问题 */
  at: string
  /** 撤回截止时间；null 表示已过期或不可撤回 */
  withdraw_deadline?: string | null
}

/** 按课时 ID 索引的凭证表 */
export type SubmissionTokenMap = Record<string, StoredSubmissionToken>

/**
 * 读取全部提交凭证。
 *
 * localStorage 在隐私模式或存储被禁用时会抛异常，
 * 这里统一吞掉并返回空表：凭证丢失只影响撤回，不影响提交流程。
 */
export function listSubmissionTokens(): SubmissionTokenMap {
  try {
    const raw = localStorage.getItem(SUBMISSION_TOKENS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as SubmissionTokenMap
  } catch {
    return {}
  }
}

/**
 * 保存一条提交凭证。
 *
 * `withdrawDeadline` 由服务端给出，界面据此决定是否显示撤回按钮；
 * 收取时就记下来，后续打开结果弹窗无需再查询。
 */
export function saveSubmissionToken(
  lessonId: number,
  submissionId: number,
  token: string,
  withdrawDeadline?: string | null,
): void {
  if (!token) return
  try {
    const map = listSubmissionTokens()
    map[String(lessonId)] = {
      submissionId,
      token,
      at: new Date().toISOString(),
      withdraw_deadline: withdrawDeadline ?? null,
    }
    localStorage.setItem(SUBMISSION_TOKENS_KEY, JSON.stringify(map))
  } catch {
    /* 存储不可用时静默跳过，不阻断提交 */
  }
}

/**
 * 取某课时的提交凭证。
 *
 * 传入 `submissionId` 时要求两者匹配：同一课时重复提交会产生新凭证，
 * 旧的那份已失效，不能拿它去撤回或下载。
 */
export function getSubmissionToken(
  lessonId: number,
  submissionId?: number,
): StoredSubmissionToken | null {
  const map = listSubmissionTokens()
  const found = map[String(lessonId)]
  if (!found || typeof found.token !== 'string' || !found.token) return null
  if (submissionId !== undefined && found.submissionId !== submissionId) return null
  return found
}

/** 删除某课时的提交凭证（撤回成功或确认丢失时调用） */
export function dropSubmissionToken(lessonId: number): void {
  try {
    const map = listSubmissionTokens()
    if (!(String(lessonId) in map)) return
    delete map[String(lessonId)]
    localStorage.setItem(SUBMISSION_TOKENS_KEY, JSON.stringify(map))
  } catch {
    /* 存储不可用时静默跳过 */
  }
}

// ---------------------------------------------------------------------------
// 班级学生名单与作业统计
// ---------------------------------------------------------------------------

/** 班级名单中的一条学生记录 */
export interface ClassStudent {
  id: number
  class_id: number
  student_no: string
  student_name: string
  created_at: string
}

/** 名单导入结果 */
export interface ImportStudentsResult {
  /** 新增条数 */
  inserted: number
  /** 学号已存在、仅更新姓名的条数 */
  updated: number
  /** 解析失败的行 */
  invalid: InvalidStudentRow[]
  /** 导入后名单总人数 */
  total: number
}

export interface InvalidStudentRow {
  line: number
  raw: string
  reason: string
}

/** 课程作业总览 */
export interface CourseHomeworkOverview {
  course_id: number
  course_title: string
  class_id: number | null
  class_name: string | null
  /** 名单人数；未指定班级时为 0 */
  roster_total: number
  /** 这门课实际用过的班级；只有一个班时前端自动选中 */
  used_class_ids: number[]
  lessons: LessonHomeworkSummary[]
}

/** 单课时作业汇总 */
export interface LessonHomeworkSummary {
  lesson_id: number
  lesson_title: string
  sort_order: number
  /** 提交份数（含重复提交） */
  submitted_count: number
  /** 去重后的提交人数 */
  submitter_count: number
  /** 被标记为重复的份数 */
  duplicate_count: number
  /** 名单中尚未提交的人数 */
  missing_count: number
}

/** 某课时的提交看板 */
export interface LessonSubmissionBoard {
  lesson_id: number
  lesson_title: string
  course_id: number
  course_title: string
  class_id: number | null
  class_name: string | null
  roster_total: number
  /** 已提交（按学生去重） */
  submitted: StudentSubmissionState[]
  /** 未提交 */
  missing: MissingStudent[]
  /** 名单外的提交者 */
  unlisted: StudentSubmissionState[]
}

export interface StudentSubmissionState {
  student_no: string
  student_name: string
  submission_count: number
  latest_at: string
  latest_submission_id: number
  has_duplicate: boolean
  client_ip: string
  status: SubmissionStatus
}

export interface MissingStudent {
  student_no: string
  student_name: string
}

// ---------------------------------------------------------------------------
// 作业审阅
// ---------------------------------------------------------------------------

/**
 * 一次审阅的变更内容。
 *
 * 字段缺席 = 不修改；显式传 `null` / `''` = 清除。
 * 这样教师点「好」不会顺手把已打的 95 分清空。
 */
export interface ReviewInput {
  status?: SubmissionStatus
  /** 传空串清除标签 */
  label?: ReviewLabel
  /** 传 null 清除分数 */
  score?: number | null
  /** 传空串清除评语 */
  comment?: string
}

/** 课时审阅统计 */
export interface ReviewStats {
  total: number
  good: number
  pass: number
  fail: number
  other: number
  /** 已提交但尚未评价 */
  unreviewed: number
  /** 打了分数的份数 */
  scored: number
  /** 平均分；无人打分为 null */
  average_score: number | null
  /** 名单中尚未提交的人数 */
  missing: number
}

/**
 * 课时审阅看板：按提交展开。
 *
 * 与 `LessonSubmissionBoard` 的区别是**不按学生聚合**：
 * 一个学生交两次就是两条，教师需要分别批改。
 */
export interface LessonReviewBoard {
  lesson_id: number
  lesson_title: string
  course_id: number
  course_title: string
  class_id: number | null
  class_name: string | null
  roster_total: number
  stats: ReviewStats
  items: SubmissionDetail[]
}

/** 批量审阅结果 */
export interface BatchReviewResult {
  updated: number
  stats: ReviewStats | null
}

// ---------------------------------------------------------------------------
// 接口封装
// ---------------------------------------------------------------------------

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>('/api/auth/login', { method: 'POST', body: { username, password } }),

  me: () => request<UserInfo>('/api/auth/me'),

  changePassword: (old_password: string, new_password: string) =>
    request<{ ok: boolean }>('/api/auth/password', {
      method: 'POST',
      body: { old_password, new_password },
    }),

  currentSession: (classId?: number) =>
    request<CurrentSession | null>(
      `/api/student/current-session${classId ? `?class_id=${classId}` : ''}`,
    ),

  session: (id: number) => request<CurrentSession>(`/api/sessions/${id}`),

  sessions: () => request<ListResponse<ClassroomSession>>('/api/sessions'),

  createSession: (class_id: number, lesson_id: number) =>
    request<ClassroomSession>('/api/sessions', { method: 'POST', body: { class_id, lesson_id } }),

  startSession: (id: number) =>
    request<ClassroomSession>(`/api/sessions/${id}/start`, { method: 'POST' }),
  pauseSession: (id: number) =>
    request<ClassroomSession>(`/api/sessions/${id}/pause`, { method: 'POST' }),
  endSession: (id: number) =>
    request<ClassroomSession>(`/api/sessions/${id}/end`, { method: 'POST' }),

  courses: () => request<ListResponse<Course>>('/api/courses'),

  /** 学生端课程列表：仅已发布课程 */
  studentCourses: () => request<ListResponse<Course>>('/api/student/courses'),

  course: (id: number) => request<Course>(`/api/courses/${id}`),
  createCourse: (body: { title: string; description?: string }) =>
    request<Course>('/api/courses', { method: 'POST', body }),
  updateCourse: (id: number, body: Partial<Course>) =>
    request<Course>(`/api/courses/${id}`, { method: 'PUT', body }),
  deleteCourse: (id: number) => request<{ ok: boolean }>(`/api/courses/${id}`, { method: 'DELETE' }),
  copyCourse: (id: number) => request<Course>(`/api/courses/${id}/copy`, { method: 'POST' }),

  lessons: (courseId: number) => request<ListResponse<Lesson>>(`/api/courses/${courseId}/lessons`),
  /** 课时详情：一次返回正文块与关联资源 */
  lesson: (id: number) => request<LessonDetail>(`/api/lessons/${id}`),
  createLesson: (courseId: number, body: { title: string; content_json?: string }) =>
    request<Lesson>(`/api/courses/${courseId}/lessons`, { method: 'POST', body }),
  updateLesson: (id: number, body: Partial<Lesson>) =>
    request<Lesson>(`/api/lessons/${id}`, { method: 'PUT', body }),
  deleteLesson: (id: number) => request<{ ok: boolean }>(`/api/lessons/${id}`, { method: 'DELETE' }),

  lessonResources: (lessonId: number) =>
    request<ListResponse<LessonResource>>(`/api/lessons/${lessonId}/resources`),

  /** 课时内直接上传：一步完成上传与关联，自动识别用途 */
  uploadLessonResource: (
    lessonId: number,
    file: File,
    onProgress?: (progress: UploadProgress) => void,
  ) => uploadWithProgress<LessonResource>(`/api/lessons/${lessonId}/resources/upload`, file, onProgress),

  attachResource: (lessonId: number, resourceId: number, purpose?: ResourcePurpose) =>
    request<LessonResource>(`/api/lessons/${lessonId}/resources/${resourceId}`, {
      method: 'POST',
      body: purpose ? { purpose } : undefined,
    }),
  detachResource: (lessonId: number, resourceId: number) =>
    request<{ ok: boolean }>(`/api/lessons/${lessonId}/resources/${resourceId}`, {
      method: 'DELETE',
    }),

  // ---- 正文块 ----
  blocks: (lessonId: number) =>
    request<ListResponse<LessonBlock>>(`/api/lessons/${lessonId}/blocks`),
  createBlock: (
    lessonId: number,
    body: { block_type: BlockType; text_content?: string; title?: string; resource_id?: number },
  ) => request<LessonBlock>(`/api/lessons/${lessonId}/blocks`, { method: 'POST', body }),
  updateBlock: (
    blockId: number,
    body: { text_content?: string; title?: string; resource_id?: number; sort_order?: number },
  ) => request<LessonBlock>(`/api/blocks/${blockId}`, { method: 'PUT', body }),
  deleteBlock: (blockId: number) =>
    request<{ ok: boolean }>(`/api/blocks/${blockId}`, { method: 'DELETE' }),
  reorderBlocks: (lessonId: number, blockIds: number[]) =>
    request<ListResponse<LessonBlock>>(`/api/lessons/${lessonId}/blocks/reorder`, {
      method: 'PUT',
      body: { block_ids: blockIds },
    }),

  /** 上传课程封面（仅接受图片） */
  uploadCourseCover: (
    courseId: number,
    file: File,
    onProgress?: (progress: UploadProgress) => void,
  ) => uploadWithProgress<Course>(`/api/courses/${courseId}/cover`, file, onProgress),
  clearCourseCover: (courseId: number) =>
    request<Course>(`/api/courses/${courseId}/cover`, { method: 'DELETE' }),

  resources: () => request<ListResponse<Resource>>('/api/resources'),

  /**
   * 学生端下载中心：已发布课程课时关联的资源。
   *
   * 与教师端 `resources()` 分开，是因为 `/api/resources` 需要登录，
   * 且会列出草稿课程素材与未被引用的暂存文件。
   */
  studentResources: () => request<ListResponse<Resource>>('/api/student/resources'),
  registerResource: (body: { name: string; size_bytes: number; sha256?: string }) =>
    request<{ resource_id: number; upload_token: string; storage_key: string }>(
      '/api/resources/register',
      { method: 'POST', body },
    ),

  /**
   * 上传资源内容。
   *
   * 使用 XHR 而非 fetch：只有 XHR 能提供上传进度事件，
   * 大文件上传时教师需要看到进度与失败提示。
   */
  uploadResource: (
    resourceId: number,
    file: File,
    onProgress?: (progress: UploadProgress) => void,
  ) => uploadWithProgress<Resource>(`/api/resources/${resourceId}/upload`, file, onProgress),

  deleteResource: (id: number) =>
    request<{ ok: boolean }>(`/api/resources/${id}`, { method: 'DELETE' }),

  classes: () => request<ListResponse<ClassInfo>>('/api/classes'),
  createClass: (body: { name: string; room_name?: string }) =>
    request<ClassInfo>('/api/classes', { method: 'POST', body }),

  // ---- 作业提交 ----

  /**
   * 提交作业（多文件）。
   *
   * 学生端无登录态也能调用；姓名与班级作为表单字段提交，
   * 来源 IP 由服务端记录，前端不参与。
   */
  submitHomework: (
    input: SubmitHomeworkInput,
    onProgress?: (progress: UploadProgress) => void,
  ) => {
    const fields: Record<string, string> = {
      student_name: input.studentName,
      lesson_id: String(input.lessonId),
    }
    if (input.classId !== null && input.classId !== undefined) {
      fields.class_id = String(input.classId)
    }
    if (input.deviceId) fields.device_id = input.deviceId
    if (input.studentNo) fields.student_no = input.studentNo
    if (input.note) fields.note = input.note

    return submitWithProgress<CreateSubmissionResponse>(
      '/api/student/submissions',
      input.files,
      fields,
      onProgress,
    )
  },

  /**
   * 查询当前设备在某课时的提交情况，用于上传前提醒。
   *
   * `deviceId` 是本机生成的稳定标识，让服务端能认出「这台机器」，
   * 而不是按人统计——机房电脑多人轮用，按设备判断才有意义。
   */
  lessonSubmissionStatus: (
    lessonId: number,
    options: { classId?: number | null; deviceId?: string } = {},
  ) => {
    const params = new URLSearchParams({ lesson_id: String(lessonId) })
    if (options.classId !== null && options.classId !== undefined) {
      params.set('class_id', String(options.classId))
    }
    if (options.deviceId) params.set('device_id', options.deviceId)
    return request<LessonSubmissionStatus>(`/api/student/submissions/status?${params.toString()}`)
  },

  /**
   * 学生端回读自己的提交，用于上传成功后弹窗预览。
   *
   * 接口要求带上提交凭证（`access_token`），否则返回 403；
   * 凭据来自提交响应或 `getSubmissionToken`。
   */
  studentSubmission: (id: number, accessToken: string) => {
    const params = new URLSearchParams({ access_token: accessToken })
    return request<SubmissionDetail>(`/api/student/submissions/${id}?${params.toString()}`)
  },

  /**
   * 撤回自己的提交。
   *
   * 服务端只允许在撤回截止时间之前撤回，过期返回 409、凭据不匹配返回 403、
   * 记录不存在返回 404；失败时把后端 message 原样抛给界面展示。
   */
  withdrawSubmission: (id: number, accessToken: string) =>
    request<{ ok: boolean }>(`/api/student/submissions/${id}/withdraw`, {
      method: 'POST',
      body: { access_token: accessToken },
    }),

  /** 教师端提交记录列表 */
  submissions: (query: {
    lessonId?: number
    classId?: number
    courseId?: number
    duplicateOnly?: boolean
    /** 按审阅标签筛选；`unreviewed` 表示尚未评价 */
    reviewLabel?: ReviewLabel | 'unreviewed'
    limit?: number
  } = {}) => {
    const params = new URLSearchParams()
    if (query.lessonId !== undefined) params.set('lesson_id', String(query.lessonId))
    if (query.classId !== undefined) params.set('class_id', String(query.classId))
    if (query.courseId !== undefined) params.set('course_id', String(query.courseId))
    if (query.duplicateOnly) params.set('duplicate_only', 'true')
    if (query.reviewLabel) params.set('review_label', query.reviewLabel)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const suffix = params.toString() ? `?${params.toString()}` : ''
    return request<ListResponse<Submission>>(`/api/admin/submissions${suffix}`)
  },

  /** 教师端提交详情 */
  submission: (id: number) => request<SubmissionDetail>(`/api/admin/submissions/${id}`),

  /** 教师端审阅单份提交：状态 / 标签 / 分数 / 评语可任选其一 */
  reviewSubmission: (id: number, input: ReviewInput) =>
    request<SubmissionDetail>(`/api/admin/submissions/${id}/review`, {
      method: 'POST',
      body: input,
    }),

  /** 教师端批量审阅：对所选提交施加同一套评价 */
  batchReviewSubmission: (ids: number[], input: ReviewInput, lessonId?: number) =>
    request<BatchReviewResult>('/api/admin/submissions/batch-review', {
      method: 'POST',
      body: { ids, ...input, lesson_id: lessonId ?? null },
    }),

  // ---- 班级学生名单 ----

  /**
   * 学生端读取正在上课班级的名单。
   *
   * 学生端未登录，不能调用需要认证的 `/api/classes/{id}/students`；
   * 这个公开接口只返回「有活动课堂」的班级名单。
   */
  studentClassRoster: (classId: number) =>
    request<ListResponse<ClassStudent>>(`/api/student/class-roster?class_id=${classId}`),

  /** 班级名单 */
  classStudents: (classId: number) =>
    request<ListResponse<ClassStudent>>(`/api/classes/${classId}/students`),

  /** 新增单个学生（学号已存在时更新姓名） */
  addClassStudent: (classId: number, studentNo: string, studentName: string) =>
    request<ClassStudent>(`/api/classes/${classId}/students`, {
      method: 'POST',
      body: { student_no: studentNo, student_name: studentName },
    }),

  /** 批量导入名单；replace 为真时先清空原名单 */
  importClassStudents: (classId: number, text: string, replace = false) =>
    request<ImportStudentsResult>(`/api/classes/${classId}/students/import`, {
      method: 'POST',
      body: { text, replace },
    }),

  /** 删除名单中的学生 */
  removeClassStudent: (classId: number, studentId: number) =>
    request<{ ok: boolean }>(`/api/classes/${classId}/students/${studentId}`, {
      method: 'DELETE',
    }),

  // ---- 作业统计 ----

  /** 课程作业总览：每个课时的提交与未交情况 */
  homeworkOverview: (courseId: number, classId?: number | null) =>
    request<CourseHomeworkOverview>(
      `/api/courses/${courseId}/homework-overview${
        classId !== null && classId !== undefined ? `?class_id=${classId}` : ''
      }`,
    ),

  /** 课时提交看板：谁交了、谁没交 */
  submissionBoard: (lessonId: number, classId?: number | null) =>
    request<LessonSubmissionBoard>(
      `/api/lessons/${lessonId}/submission-board${
        classId !== null && classId !== undefined ? `?class_id=${classId}` : ''
      }`,
    ),

  /** 课时审阅看板：按提交展开，供批量批改 */
  lessonReviewBoard: (lessonId: number, classId?: number | null) =>
    request<LessonReviewBoard>(
      `/api/lessons/${lessonId}/review-board${
        classId !== null && classId !== undefined ? `?class_id=${classId}` : ''
      }`,
    ),

  health: () => request<Health>('/api/admin/health'),

  auditLogs: (limit = 100) =>
    request<{ items: AuditLogEntry[] }>(`/api/admin/audit-logs?limit=${limit}`),

  /** 公开的服务版本信息，无需登录 */
  version: () => request<{ name: string; version: string }>('/api/version'),

  // ---- 首次安装向导 ----

  /** 查询安装状态；未安装时返回可修改的基础配置默认值 */
  setupStatus: () => request<SetupStatus>('/api/setup/status'),

  /** 执行安装：创建管理员账号并写入基础配置 */
  setupInstall: (payload: SetupInstallPayload) =>
    request<SetupInstallResult>('/api/setup/install', {
      method: 'POST',
      body: payload,
    }),
}
