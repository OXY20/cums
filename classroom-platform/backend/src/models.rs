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
    pub sort_order: Option<i64>,
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
    pub lesson_content: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub class_id: i64,
    pub lesson_id: i64,
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
