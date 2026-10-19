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
 * 多文件提交（作业上传）。
 *
 * 与 [`uploadWithProgress`] 一样使用 XHR 以获得上传进度；
 * 区别在于可以附带表单字段与多个文件，对应作业提交接口。
 */
export function submitWithProgress<T>(
  path: string,
  files: File[],
  fields: Record<string, string>,
  onProgress?: (percent: number) => void,
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
        onProgress(Math.round((event.loaded / event.total) * 100))
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
  onProgress?: (percent: number) => void,
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
        onProgress(Math.round((event.loaded / event.total) * 100))
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
}

/** 提交详情：记录本体 + 文件列表 */
export interface SubmissionDetail extends Submission {
  files: SubmissionFile[]
  duplicate_of_name: string | null
}

/** 课时提交状态，用于上传前提醒 */
export interface LessonSubmissionStatus {
  lesson_id: number
  class_id: number | null
  total: number
  first_submission: Submission | null
}

/** 提交接口的响应，携带重复提醒 */
export interface CreateSubmissionResponse {
  submission: SubmissionDetail
  duplicate_warning: string | null
}

export interface SubmitHomeworkInput {
  studentName: string
  lessonId: number
  classId?: number | null
  note?: string
  files: File[]
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
    onProgress?: (percent: number) => void,
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
  uploadCourseCover: (courseId: number, file: File, onProgress?: (percent: number) => void) =>
    uploadWithProgress<Course>(`/api/courses/${courseId}/cover`, file, onProgress),
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
  uploadResource: (resourceId: number, file: File, onProgress?: (percent: number) => void) =>
    uploadWithProgress<Resource>(`/api/resources/${resourceId}/upload`, file, onProgress),

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
    onProgress?: (percent: number) => void,
  ) => {
    const fields: Record<string, string> = {
      student_name: input.studentName,
      lesson_id: String(input.lessonId),
    }
    if (input.classId !== null && input.classId !== undefined) {
      fields.class_id = String(input.classId)
    }
    if (input.note) fields.note = input.note

    return submitWithProgress<CreateSubmissionResponse>(
      '/api/student/submissions',
      input.files,
      fields,
      onProgress,
    )
  },

  /** 查询某课时是否已有提交，用于上传前提醒 */
  lessonSubmissionStatus: (lessonId: number, classId?: number | null) => {
    const suffix = classId !== null && classId !== undefined ? `&class_id=${classId}` : ''
    return request<LessonSubmissionStatus>(
      `/api/student/submissions/status?lesson_id=${lessonId}${suffix}`,
    )
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
    limit?: number
  } = {}) => {
    const params = new URLSearchParams()
    if (query.lessonId !== undefined) params.set('lesson_id', String(query.lessonId))
    if (query.classId !== undefined) params.set('class_id', String(query.classId))
    if (query.courseId !== undefined) params.set('course_id', String(query.courseId))
    if (query.duplicateOnly) params.set('duplicate_only', 'true')
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const suffix = params.toString() ? `?${params.toString()}` : ''
    return request<ListResponse<Submission>>(`/api/admin/submissions${suffix}`)
  },

  /** 教师端提交详情 */
  submission: (id: number) => request<SubmissionDetail>(`/api/admin/submissions/${id}`),

  /** 教师端标记审阅状态 */
  reviewSubmission: (id: number, status: SubmissionStatus) =>
    request<SubmissionDetail>(`/api/admin/submissions/${id}/review`, {
      method: 'POST',
      body: { status },
    }),

  health: () => request<Health>('/api/admin/health'),

  auditLogs: (limit = 100) =>
    request<{ items: AuditLogEntry[] }>(`/api/admin/audit-logs?limit=${limit}`),

  /** 公开的服务版本信息，无需登录 */
  version: () => request<{ name: string; version: string }>('/api/version'),
}
