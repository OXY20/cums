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

/** 资源下载地址；浏览器将按 Content-Disposition 处理文件名 */
export function fileUrl(resourceId: number): string {
  return `/files/${resourceId}`
}

/**
 * 内嵌预览地址。
 *
 * `inline=1` 让服务端返回 `Content-Disposition: inline`，
 * PDF / 图片 / 视频才能在预览弹窗里直接展示而不是触发下载。
 */
export function inlineFileUrl(resourceId: number): string {
  return `/files/${resourceId}?inline=1`
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
  /** 1 表示该课时该班级已有其他人提交 */
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
}

/** 提交接口的响应，携带重复提醒 */
export interface CreateSubmissionResponse {
  submission: SubmissionDetail
  duplicate_warning: string | null
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

  /** 学生端回读自己的提交，用于上传成功后弹窗预览 */
  studentSubmission: (id: number) =>
    request<SubmissionDetail>(`/api/student/submissions/${id}`),

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
}
