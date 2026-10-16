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
  created_at: string
  updated_at: string
}

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
  lesson: (id: number) => request<Lesson>(`/api/lessons/${id}`),
  createLesson: (courseId: number, body: { title: string; content_json?: string }) =>
    request<Lesson>(`/api/courses/${courseId}/lessons`, { method: 'POST', body }),
  updateLesson: (id: number, body: Partial<Lesson>) =>
    request<Lesson>(`/api/lessons/${id}`, { method: 'PUT', body }),
  deleteLesson: (id: number) => request<{ ok: boolean }>(`/api/lessons/${id}`, { method: 'DELETE' }),

  lessonResources: (lessonId: number) =>
    request<ListResponse<Resource>>(`/api/lessons/${lessonId}/resources`),
  attachResource: (lessonId: number, resourceId: number) =>
    request<{ ok: boolean }>(`/api/lessons/${lessonId}/resources/${resourceId}`, {
      method: 'POST',
    }),
  detachResource: (lessonId: number, resourceId: number) =>
    request<{ ok: boolean }>(`/api/lessons/${lessonId}/resources/${resourceId}`, {
      method: 'DELETE',
    }),

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
    onProgress?: (percent: number) => void,
  ): Promise<Resource> =>
    new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('file', file, file.name)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/resources/${resourceId}/upload`)

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
          resolve(payload as Resource)
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
    }),

  deleteResource: (id: number) =>
    request<{ ok: boolean }>(`/api/resources/${id}`, { method: 'DELETE' }),

  classes: () => request<ListResponse<ClassInfo>>('/api/classes'),
  createClass: (body: { name: string; room_name?: string }) =>
    request<ClassInfo>('/api/classes', { method: 'POST', body }),

  health: () => request<Health>('/api/admin/health'),

  auditLogs: (limit = 100) =>
    request<{ items: AuditLogEntry[] }>(`/api/admin/audit-logs?limit=${limit}`),

  /** 公开的服务版本信息，无需登录 */
  version: () => request<{ name: string; version: string }>('/api/version'),
}
