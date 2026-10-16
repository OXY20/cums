//! 课程接口。

use crate::error::{AppError, AppResult};
use crate::models::{CourseRow, CreateCourseRequest, ListResponse, UpdateCourseRequest};
use crate::routes::AuthUser;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new()
        // 学生端只看到已发布课程，草稿与归档课程不对外展示。
        .route("/api/student/courses", get(list_published_courses))
        .route("/api/courses", get(list_courses).post(create_course))
        .route(
            "/api/courses/{id}",
            get(get_course).put(update_course).delete(delete_course),
        )
        .route("/api/courses/{id}/copy", axum::routing::post(copy_course))
}

/// 学生端课程列表：仅已发布课程。
async fn list_published_courses(
    State(state): State<AppState>,
) -> AppResult<Json<ListResponse<CourseRow>>> {
    let rows = sqlx::query_as::<_, CourseRow>(
        "SELECT c.id, c.title, c.description, c.cover_key, c.status, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count
         FROM courses c
         WHERE c.status = 'published'
         ORDER BY c.updated_at DESC",
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(ListResponse::new(rows)))
}

/// 课程列表（教师端）：包含草稿与归档课程。
async fn list_courses(State(state): State<AppState>) -> AppResult<Json<ListResponse<CourseRow>>> {
    let rows = sqlx::query_as::<_, CourseRow>(
        "SELECT c.id, c.title, c.description, c.cover_key, c.status, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count
         FROM courses c
         ORDER BY c.updated_at DESC",
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(ListResponse::new(rows)))
}

/// 课程详情。
async fn get_course(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<CourseRow>> {
    let row = sqlx::query_as::<_, CourseRow>(
        "SELECT c.id, c.title, c.description, c.cover_key, c.status, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count
         FROM courses c WHERE c.id = ?1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("课程 {id}")))?;

    Ok(Json(row))
}

/// 创建课程（需要教师或管理员身份）。
async fn create_course(
    State(state): State<AppState>,
    user: AuthUser,
    Json(payload): Json<CreateCourseRequest>,
) -> AppResult<Json<CourseRow>> {
    let title = payload.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("课程名称不能为空".into()));
    }

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO courses (title, description, cover_key, status, created_by)
         VALUES (?1, ?2, ?3, 'draft', ?4) RETURNING id",
    )
    .bind(title)
    .bind(&payload.description)
    .bind(&payload.cover_key)
    .bind(user.id())
    .fetch_one(&state.db)
    .await?;

    crate::routes::auth::audit(&state, Some(user.id()), "course.create", "course", &id.to_string())
        .await;

    get_course(State(state), Path(id)).await
}

/// 更新课程。
async fn update_course(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(payload): Json<UpdateCourseRequest>,
) -> AppResult<Json<CourseRow>> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM courses WHERE id = ?1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("课程 {id}")));
    }

    if let Some(status) = &payload.status {
        if !matches!(status.as_str(), "draft" | "published" | "archived") {
            return Err(AppError::BadRequest("课程状态无效".into()));
        }
    }

    sqlx::query(
        "UPDATE courses SET
            title       = COALESCE(?1, title),
            description = COALESCE(?2, description),
            cover_key   = COALESCE(?3, cover_key),
            status      = COALESCE(?4, status),
            updated_at  = datetime('now')
         WHERE id = ?5",
    )
    .bind(payload.title.as_deref())
    .bind(payload.description.as_deref())
    .bind(payload.cover_key.as_deref())
    .bind(payload.status.as_deref())
    .bind(id)
    .execute(&state.db)
    .await?;

    crate::routes::auth::audit(&state, Some(user.id()), "course.update", "course", &id.to_string())
        .await;

    get_course(State(state), Path(id)).await
}

/// 删除课程；存在历史课堂时拒绝，避免破坏历史记录。
async fn delete_course(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let used: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM classroom_sessions cs
         JOIN lessons l ON l.id = cs.lesson_id
         WHERE l.course_id = ?1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    if used > 0 {
        return Err(AppError::Conflict(
            "该课程已有授课记录，请改为停用而不是删除".into(),
        ));
    }

    let affected = sqlx::query("DELETE FROM courses WHERE id = ?1")
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!("课程 {id}")));
    }

    crate::routes::auth::audit(&state, Some(user.id()), "course.delete", "course", &id.to_string())
        .await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 复制课程模板及其课时。
async fn copy_course(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<CourseRow>> {
    let source = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT title, description, cover_key FROM courses WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("课程 {id}")))?;

    let new_title = format!("{}（副本）", source.0);

    let new_id: i64 = sqlx::query_scalar(
        "INSERT INTO courses (title, description, cover_key, status, created_by)
         VALUES (?1, ?2, ?3, 'draft', ?4) RETURNING id",
    )
    .bind(&new_title)
    .bind(&source.1)
    .bind(&source.2)
    .bind(user.id())
    .fetch_one(&state.db)
    .await?;

    sqlx::query(
        "INSERT INTO lessons (course_id, title, sort_order, content_json)
         SELECT ?1, title, sort_order, content_json FROM lessons WHERE course_id = ?2",
    )
    .bind(new_id)
    .bind(id)
    .execute(&state.db)
    .await?;

    crate::routes::auth::audit(&state, Some(user.id()), "course.copy", "course", &new_id.to_string())
        .await;

    get_course(State(state), Path(new_id)).await
}
