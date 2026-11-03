//! 路由汇总与认证提取器。

pub mod admin;
pub mod auth;
pub mod blocks;
pub mod classes;
pub mod courses;
pub mod events;
pub mod files;
pub mod lessons;
pub mod meta;
pub mod resources;
pub mod sessions;
pub mod setup;
pub mod students;
pub mod submissions;

use crate::auth::{verify_token, Claims, Role};
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{FromRequestParts, State};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::middleware::Next;
use axum::response::Response;
use axum::Router;

/// 组装全部 API 路由。
///
/// 入参包含完整状态：安装守卫中间件需要在组装期就拿到 `AppState`，
/// 以便在请求进入时判断服务是否已完成首次安装。
pub fn api_router(state: AppState) -> Router {
    Router::new()
        .merge(setup::routes())
        .merge(auth::routes())
        .merge(classes::routes())
        .merge(courses::routes())
        .merge(lessons::routes())
        .merge(blocks::routes())
        .merge(sessions::routes())
        .merge(resources::routes())
        .merge(submissions::routes())
        .merge(students::routes())
        .merge(files::routes())
        .merge(events::routes())
        .merge(meta::routes())
        .merge(admin::routes())
        // 未完成安装时只放行安装向导自身，其余接口一律拒绝。
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            setup_guard,
        ))
        .with_state(state)
}

/// 安装状态守卫：未安装时拒绝除安装接口外的所有请求。
///
/// AGENT-DECISION: 守卫放在路由层而非各 handler 内，是为了让「未安装」
/// 成为全局不可绕过的状态——即使前端被绕过，也无法在未初始化时调用业务接口。
async fn setup_guard(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Result<Response, AppError> {
    if state.is_installed() {
        return Ok(next.run(request).await);
    }

    // 安装接口自身始终可用。
    let path = request.uri().path();
    if path.starts_with("/api/setup") {
        return Ok(next.run(request).await);
    }

    Err(AppError::Conflict(
        "系统尚未完成首次安装，请先运行安装向导".into(),
    ))
}

/// 已认证用户提取器：从 `Authorization: Bearer <token>` 解析。
#[derive(Debug, Clone)]
pub struct AuthUser(pub Claims);

impl AuthUser {
    /// 要求管理员角色。
    pub fn require_admin(&self) -> Result<(), AppError> {
        if self.0.role == Role::Admin {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }

    pub fn id(&self) -> i64 {
        self.0.sub
    }
}

/// 可选认证：带有效令牌时返回身份，未带或令牌无效时视为匿名访问。
///
/// AGENT-DECISION: 学生端没有账号，课程、课时与课堂详情必须匿名可读；
/// 但未发布的草稿课程不能借这条公开通道泄露。用一个「可选」提取器区分
/// 匿名与教师，比给同一接口再开一套教师专用路径更容易保持一致。
pub struct MaybeAuthUser(pub Option<Claims>);

impl MaybeAuthUser {
    /// 已登录的教师或管理员可以查看未发布内容。
    pub fn is_staff(&self) -> bool {
        matches!(
            self.0.as_ref().map(|claims| claims.role),
            Some(Role::Admin) | Some(Role::Teacher)
        )
    }
}

impl FromRequestParts<AppState> for MaybeAuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let Some(value) = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
        else {
            return Ok(Self(None));
        };

        let Some(token) = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .map(str::trim)
        else {
            return Ok(Self(None));
        };

        // 令牌无效不报错：匿名请求本就不带令牌，过期令牌也应退化为匿名浏览。
        Ok(Self(verify_token(&state.config, token).ok()))
    }
}

/// 未发布课程（草稿 / 归档）只对已登录教师开放。
///
/// 返回 `NotFound` 而不是 `Forbidden`：课程存在与否不应成为匿名用户可探测的信息。
pub async fn ensure_course_published(
    state: &AppState,
    course_id: i64,
    viewer: &MaybeAuthUser,
) -> Result<(), AppError> {
    if viewer.is_staff() {
        return Ok(());
    }

    let status: Option<String> = sqlx::query_scalar("SELECT status FROM courses WHERE id = ?1")
        .bind(course_id)
        .fetch_optional(&state.db)
        .await?;

    match status.as_deref() {
        Some("published") => Ok(()),
        _ => Err(AppError::NotFound(format!("课程 {course_id}"))),
    }
}

/// 课时所属课程未发布时，匿名访问一律按课时不存在处理。
pub async fn ensure_lesson_published(
    state: &AppState,
    lesson_id: i64,
    viewer: &MaybeAuthUser,
) -> Result<(), AppError> {
    if viewer.is_staff() {
        return Ok(());
    }

    let status: Option<String> = sqlx::query_scalar(
        "SELECT c.status FROM lessons l JOIN courses c ON c.id = l.course_id WHERE l.id = ?1",
    )
    .bind(lesson_id)
    .fetch_optional(&state.db)
    .await?;

    match status.as_deref() {
        Some("published") => Ok(()),
        _ => Err(AppError::NotFound(format!("课时 {lesson_id}"))),
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or(AppError::Unauthorized)?;

        let token = header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix("bearer "))
            .ok_or(AppError::Unauthorized)?
            .trim();

        let claims = verify_token(&state.config, token)?;
        Ok(AuthUser(claims))
    }
}
