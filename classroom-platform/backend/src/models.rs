//! API 请求与响应数据结构。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/// 列表响应。
#[derive(Debug, Serialize)]
pub struct ListResponse<T> {
    pub items: Vec<T>,
    pub total: i64,
}

impl<T> ListResponse<T> {
    pub fn new(items: Vec<T>) -> Self {
        let total = items.len() as i64;
        Self { items, total }
    }
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub user: UserInfo,
    /// 令牌有效期（秒）
    pub expires_in: i64,
}

#[derive(Debug, Serialize)]
pub struct UserInfo {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
}

#[derive(Debug, sqlx::FromRow)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    pub role: String,
    pub is_active: i64,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    pub old_password: String,
    pub new_password: String,
}

// ---------------------------------------------------------------------------
// 课程
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CourseRow {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub cover_key: Option<String>,
    /// 封面图对应的资源 ID；为空表示未设置封面
    #[sqlx(default)]
    pub cover_resource_id: Option<i64>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    /// 课时数量（列表查询时附带）
    #[sqlx(default)]
    pub lesson_count: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateCourseRequest {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub cover_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCourseRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    pub cover_key: Option<String>,
    pub cover_resource_id: Option<i64>,
    pub status: Option<String>,
}

// ---------------------------------------------------------------------------
// 课时
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LessonRow {
    pub id: i64,
    pub course_id: i64,
    pub title: String,
    pub sort_order: i64,
    pub content_json: String,
    /// 富文本正文（已清洗的 HTML）
    pub content_html: String,
    /// 正文格式：`html`（富文本）或 `blocks`（旧版块结构）
    pub content_format: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateLessonRequest {
    pub title: String,
    #[serde(default)]
    pub content_json: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLessonRequest {
    pub title: Option<String>,
    pub content_json: Option<String>,
    /// 富文本正文；服务端会做白名单清洗后入库
    pub content_html: Option<String>,
    pub sort_order: Option<i64>,
}

/// 课时详情视图：附带图文块与关联资源，供编辑器一次加载。
#[derive(Debug, Serialize)]
pub struct LessonDetailView {
    #[serde(flatten)]
    pub lesson: LessonRow,
    pub blocks: Vec<LessonBlockRow>,
    pub resources: Vec<LessonResourceRow>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LessonStepRow {
    pub id: i64,
    pub lesson_id: i64,
    pub title: String,
    pub content: String,
    pub sort_order: i64,
}

// ---------------------------------------------------------------------------
// 资源
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ResourceRow {
    pub id: i64,
    pub name: String,
    pub storage_key: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub mime_type: String,
    pub version: i64,
    pub status: String,
    pub created_at: String,
}

/// 资源登记请求：先登记元数据，再上传文件。
#[derive(Debug, Deserialize)]
pub struct RegisterResourceRequest {
    pub name: String,
    pub size_bytes: i64,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RegisterResourceResponse {
    pub resource_id: i64,
    pub upload_token: String,
    pub storage_key: String,
}

/// 课时关联的资源，附带用途与排序信息。
///
/// `purpose` 决定前端如何呈现：`image` / `video` 内嵌展示，`attachment` 提供下载。
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LessonResourceRow {
    pub id: i64,
    pub name: String,
    pub storage_key: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub mime_type: String,
    pub version: i64,
    pub status: String,
    pub created_at: String,
    /// 用途：image / video / attachment
    pub purpose: String,
    pub required: i64,
    pub sort_order: i64,
}

/// 关联资源时的可选用途设置。
#[derive(Debug, Default, Deserialize)]
pub struct AttachResourceRequest {
    #[serde(default)]
    pub purpose: Option<String>,
}

// ---------------------------------------------------------------------------
// 课时正文块
// ---------------------------------------------------------------------------

/// 正文块：文字与媒体按 `sort_order` 混排。
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LessonBlockRow {
    pub id: i64,
    pub lesson_id: i64,
    pub block_type: String,
    pub text_content: String,
    pub title: String,
    pub resource_id: Option<i64>,
    pub sort_order: i64,
    /// 关联资源的展示信息（媒体块使用）
    #[sqlx(default)]
    pub resource_name: Option<String>,
    #[sqlx(default)]
    pub resource_size: Option<i64>,
    #[sqlx(default)]
    pub resource_mime: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateBlockRequest {
    /// `text` / `image` / `video` / `file`
    pub block_type: String,
    #[serde(default)]
    pub text_content: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub resource_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateBlockRequest {
    pub text_content: Option<String>,
    pub title: Option<String>,
    pub resource_id: Option<i64>,
    pub sort_order: Option<i64>,
}

/// 批量重排正文块。
#[derive(Debug, Deserialize)]
pub struct ReorderBlocksRequest {
    /// 按目标顺序排列的块 ID
    pub block_ids: Vec<i64>,
}

// ---------------------------------------------------------------------------
// 班级与机房
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ClassRow {
    pub id: i64,
    pub name: String,
    pub room_name: String,
    pub is_active: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateClassRequest {
    pub name: String,
    #[serde(default)]
    pub room_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateClassRequest {
    pub name: Option<String>,
    pub room_name: Option<String>,
    pub is_active: Option<i64>,
}

// ---------------------------------------------------------------------------
// 课堂场次
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SessionRow {
    pub id: i64,
    pub class_id: i64,
    pub teacher_id: i64,
    pub lesson_id: i64,
    pub status: String,
    pub started_at: String,
    pub paused_at: Option<String>,
    pub ended_at: Option<String>,
}

/// 学生端当前课堂视图。
#[derive(Debug, Serialize)]
pub struct CurrentSessionView {
    pub session: SessionRow,
    pub class_name: String,
    pub teacher_name: String,
    pub course_title: String,
    pub lesson_title: String,
    /// 结构化文字字段（旧版块内容或快照中的 fields）
    pub lesson_content: serde_json::Value,
    /// 富文本正文（已清洗的 HTML），为空表示使用 lesson_content
    pub lesson_html: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub class_id: i64,
    pub lesson_id: i64,
}

// ---------------------------------------------------------------------------
// 作业提交
// ---------------------------------------------------------------------------

/// 一条作业提交记录。
///
/// `client_ip` 由服务端从连接信息或可信代理头解析，客户端无法指定。
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SubmissionRow {
    pub id: i64,
    pub course_id: i64,
    pub lesson_id: i64,
    /// 班级可为空：学生端未选择班级时只按课时归属
    pub class_id: Option<i64>,
    /// 关联的课堂场次；学生端直接访问课程页时可能为空
    pub session_id: Option<i64>,
    pub student_name: String,
    pub client_ip: String,
    pub user_agent: String,
    pub note: String,
    /// 0 正常；1 表示该课时该班级已有其他人提交
    pub duplicate_flag: i64,
    /// 被重复的原始提交
    pub duplicate_of: Option<i64>,
    pub status: String,
    pub created_at: String,
    /// 冗余展示字段，列表查询时附带
    #[sqlx(default)]
    pub course_title: Option<String>,
    #[sqlx(default)]
    pub lesson_title: Option<String>,
    #[sqlx(default)]
    pub class_name: Option<String>,
    #[sqlx(default)]
    pub file_count: i64,
}

/// 提交包含的单个文件，复用资源库的存储与校验能力。
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SubmissionFileRow {
    pub resource_id: i64,
    pub name: String,
    pub size_bytes: i64,
    pub mime_type: String,
    pub sha256: String,
    /// 用途：image / video / attachment，决定前端如何预览
    pub purpose: String,
    pub sort_order: i64,
}

/// 提交详情：记录本体 + 文件列表。
#[derive(Debug, Serialize)]
pub struct SubmissionDetailView {
    #[serde(flatten)]
    pub submission: SubmissionRow,
    pub files: Vec<SubmissionFileRow>,
    /// 被重复提交的提交人姓名，供前端提示
    pub duplicate_of_name: Option<String>,
}

/// 课时提交状态：学生端上传前先查询，用于提醒「本班已有人提交」。
#[derive(Debug, Serialize)]
pub struct LessonSubmissionStatus {
    pub lesson_id: i64,
    pub class_id: Option<i64>,
    pub total: i64,
    /// 已有提交时给出最早一条，前端展示提交人与时间
    pub first_submission: Option<SubmissionRow>,
}

/// 提交成功后的响应，携带重复提醒。
#[derive(Debug, Serialize)]
pub struct CreateSubmissionResponse {
    pub submission: SubmissionDetailView,
    /// 本次提交被标记为重复时给出原因
    pub duplicate_warning: Option<String>,
}

// ---------------------------------------------------------------------------
// 监控
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub database: &'static str,
    pub uptime_seconds: i64,
    pub active_sessions: i64,
    pub active_downloads: i64,
    pub objects_bytes: u64,
}
