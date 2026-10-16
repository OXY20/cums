//! 课时与课时步骤接口。

use crate::error::{AppError, AppResult};
use crate::models::{
    CreateLessonRequest, LessonRow, LessonStepRow, ListResponse, UpdateLessonRequest,
};
use crate::routes::AuthUser;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/courses/{course_id}/lessons",
            get(list_lessons).post(create_lesson),
        )
        .route(
            "/api/lessons/{id}",
            get(get_lesson).put(update_lesson).delete(delete_lesson),
        )
        .route(
            "/api/lessons/{id}/steps",
            get(list_steps).post(create_step),
        )
        .route("/api/lessons/{id}/resources", get(crate::routes::resources::lesson_resources))
        .route(
            "/api/lessons/{id}/resources/{resource_id}",
            post(crate::routes::resources::attach_resource)
                .delete(crate::routes::resources::detach_resource),
        )
}

/// 某课程下的课时列表。
async fn list_lessons(
    State(state): State<AppState>,
    Path(course_id): Path<i64>,
) -> AppResult<Json<ListResponse<LessonRow>>> {
    let rows = sqlx::query_as::<_, LessonRow>(
        "SELECT id, course_id, title, sort_order, content_json, created_at, updated_at
         FROM lessons WHERE course_id = ?1 ORDER BY sort_order ASC, id ASC",
    )
    .bind(course_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(ListResponse::new(rows)))
}

/// 课时详情。
async fn get_lesson(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<LessonRow>> {
    fetch_lesson(&state, id).await.map(Json)
}

pub async fn fetch_lesson(state: &AppState, id: i64) -> AppResult<LessonRow> {
    sqlx::query_as::<_, LessonRow>(
        "SELECT id, course_id, title, sort_order, content_json, created_at, updated_at
         FROM lessons WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("课时 {id}")))
}

/// 创建课时；未指定排序时追加到末尾。
async fn create_lesson(
    State(state): State<AppState>,
    user: AuthUser,
    Path(course_id): Path<i64>,
    Json(payload): Json<CreateLessonRequest>,
) -> AppResult<Json<LessonRow>> {
    let title = payload.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("课时标题不能为空".into()));
    }

    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM courses WHERE id = ?1")
        .bind(course_id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("课程 {course_id}")));
    }

    let sort_order = match payload.sort_order {
        Some(value) => value,
        None => {
            let max: Option<i64> =
                sqlx::query_scalar("SELECT MAX(sort_order) FROM lessons WHERE course_id = ?1")
                    .bind(course_id)
                    .fetch_one(&state.db)
                    .await?;
            max.unwrap_or(0) + 1
        }
    };

    let content = payload.content_json.unwrap_or_else(|| "{}".to_string());

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO lessons (course_id, title, sort_order, content_json)
         VALUES (?1, ?2, ?3, ?4) RETURNING id",
    )
    .bind(course_id)
    .bind(title)
    .bind(sort_order)
    .bind(content)
    .fetch_one(&state.db)
    .await?;

    crate::routes::auth::audit(&state, Some(user.id()), "lesson.create", "lesson", &id.to_string())
        .await;

    fetch_lesson(&state, id).await.map(Json)
}

/// 更新课时。
async fn update_lesson(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(payload): Json<UpdateLessonRequest>,
) -> AppResult<Json<LessonRow>> {
    fetch_lesson(&state, id).await?;

    sqlx::query(
        "UPDATE lessons SET
            title        = COALESCE(?1, title),
            content_json = COALESCE(?2, content_json),
            sort_order   = COALESCE(?3, sort_order),
            updated_at   = datetime('now')
         WHERE id = ?4",
    )
    .bind(payload.title.as_deref())
    .bind(payload.content_json.as_deref())
    .bind(payload.sort_order)
    .bind(id)
    .execute(&state.db)
    .await?;

    crate::routes::auth::audit(&state, Some(user.id()), "lesson.update", "lesson", &id.to_string())
        .await;

    fetch_lesson(&state, id).await.map(Json)
}

/// 删除课时；已被课堂引用时拒绝。
async fn delete_lesson(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let used: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM classroom_sessions WHERE lesson_id = ?1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;

    if used > 0 {
        return Err(AppError::Conflict("该课时已有授课记录，无法删除".into()));
    }

    let affected = sqlx::query("DELETE FROM lessons WHERE id = ?1")
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!("课时 {id}")));
    }

    crate::routes::auth::audit(&state, Some(user.id()), "lesson.delete", "lesson", &id.to_string())
        .await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 课时步骤列表。
async fn list_steps(
    State(state): State<AppState>,
    Path(lesson_id): Path<i64>,
) -> AppResult<Json<ListResponse<LessonStepRow>>> {
    let rows = sqlx::query_as::<_, LessonStepRow>(
        "SELECT id, lesson_id, title, content, sort_order
         FROM lesson_steps WHERE lesson_id = ?1 ORDER BY sort_order ASC, id ASC",
    )
    .bind(lesson_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(ListResponse::new(rows)))
}

/// 新增课时步骤。
async fn create_step(
    State(state): State<AppState>,
    user: AuthUser,
    Path(lesson_id): Path<i64>,
    Json(payload): Json<CreateLessonRequest>,
) -> AppResult<Json<LessonStepRow>> {
    fetch_lesson(&state, lesson_id).await?;

    let max: Option<i64> =
        sqlx::query_scalar("SELECT MAX(sort_order) FROM lesson_steps WHERE lesson_id = ?1")
            .bind(lesson_id)
            .fetch_one(&state.db)
            .await?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO lesson_steps (lesson_id, title, content, sort_order)
         VALUES (?1, ?2, ?3, ?4) RETURNING id",
    )
    .bind(lesson_id)
    .bind(payload.title.trim())
    .bind(payload.content_json.unwrap_or_default())
    .bind(max.unwrap_or(0) + 1)
    .fetch_one(&state.db)
    .await?;

    crate::routes::auth::audit(&state, Some(user.id()), "lesson_step.create", "lesson_step", &id.to_string())
        .await;

    let row = sqlx::query_as::<_, LessonStepRow>(
        "SELECT id, lesson_id, title, content, sort_order FROM lesson_steps WHERE id = ?1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}
