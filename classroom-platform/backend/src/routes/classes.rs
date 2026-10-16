//! 班级与机房管理接口，以及教师授课授权。

use crate::error::{AppError, AppResult};
use crate::models::{ClassRow, CreateClassRequest, ListResponse, UpdateClassRequest};
use crate::routes::AuthUser;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/classes", get(list_classes).post(create_class))
        .route(
            "/api/classes/{id}",
            get(get_class).put(update_class).delete(delete_class),
        )
        .route(
            "/api/classes/{id}/teachers",
            get(list_class_teachers).post(grant_teacher),
        )
        .route(
            "/api/classes/{id}/teachers/{teacher_id}",
            axum::routing::delete(revoke_teacher),
        )
        .route("/api/teachers", get(list_teachers))
}

/// 班级列表。
async fn list_classes(State(state): State<AppState>) -> AppResult<Json<ListResponse<ClassRow>>> {
    let rows = sqlx::query_as::<_, ClassRow>(
        "SELECT id, name, room_name, is_active, created_at, updated_at
         FROM classes ORDER BY name ASC",
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(ListResponse::new(rows)))
}

async fn get_class(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<ClassRow>> {
    fetch_class(&state, id).await.map(Json)
}

pub async fn fetch_class(state: &AppState, id: i64) -> AppResult<ClassRow> {
    sqlx::query_as::<_, ClassRow>(
        "SELECT id, name, room_name, is_active, created_at, updated_at FROM classes WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("班级 {id}")))
}

/// 创建班级（管理员）。
async fn create_class(
    State(state): State<AppState>,
    user: AuthUser,
    Json(payload): Json<CreateClassRequest>,
) -> AppResult<Json<ClassRow>> {
    user.require_admin()?;

    let name = payload.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("班级名称不能为空".into()));
    }

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO classes (name, room_name) VALUES (?1, ?2) RETURNING id",
    )
    .bind(name)
    .bind(payload.room_name.unwrap_or_default())
    .fetch_one(&state.db)
    .await
    .map_err(|err| match err {
        sqlx::Error::Database(ref db) if db.is_unique_violation() => {
            AppError::Conflict("班级名称已存在".into())
        }
        other => AppError::Database(other),
    })?;

    crate::routes::auth::audit(&state, Some(user.id()), "class.create", "class", &id.to_string()).await;

    fetch_class(&state, id).await.map(Json)
}

/// 更新班级。
async fn update_class(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(payload): Json<UpdateClassRequest>,
) -> AppResult<Json<ClassRow>> {
    user.require_admin()?;
    fetch_class(&state, id).await?;

    sqlx::query(
        "UPDATE classes SET
            name       = COALESCE(?1, name),
            room_name  = COALESCE(?2, room_name),
            is_active  = COALESCE(?3, is_active),
            updated_at = datetime('now')
         WHERE id = ?4",
    )
    .bind(payload.name.as_deref())
    .bind(payload.room_name.as_deref())
    .bind(payload.is_active)
    .bind(id)
    .execute(&state.db)
    .await?;

    crate::routes::auth::audit(&state, Some(user.id()), "class.update", "class", &id.to_string()).await;

    fetch_class(&state, id).await.map(Json)
}

/// 删除班级；存在授课记录时拒绝。
async fn delete_class(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;

    let used: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM classroom_sessions WHERE class_id = ?1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;

    if used > 0 {
        return Err(AppError::Conflict(
            "该班级已有授课记录，请改为停用而不是删除".into(),
        ));
    }

    let affected = sqlx::query("DELETE FROM classes WHERE id = ?1")
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!("班级 {id}")));
    }

    crate::routes::auth::audit(&state, Some(user.id()), "class.delete", "class", &id.to_string()).await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 查询班级已授权的教师。
async fn list_class_teachers(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let rows = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT u.id, u.username, u.display_name
         FROM teacher_classes tc JOIN users u ON u.id = tc.teacher_id
         WHERE tc.class_id = ?1 ORDER BY u.username",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| serde_json::json!({ "id": r.0, "username": r.1, "display_name": r.2 }))
        .collect();

    Ok(Json(serde_json::json!({ "items": items })))
}

/// 授权教师到班级（管理员）。
async fn grant_teacher(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(payload): Json<GrantTeacherRequest>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;

    sqlx::query("INSERT OR IGNORE INTO teacher_classes (teacher_id, class_id) VALUES (?1, ?2)")
        .bind(payload.teacher_id)
        .bind(id)
        .execute(&state.db)
        .await?;

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "class.grant_teacher",
        "class",
        &id.to_string(),
    )
    .await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 撤销教师授权。
async fn revoke_teacher(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, teacher_id)): Path<(i64, i64)>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;

    sqlx::query("DELETE FROM teacher_classes WHERE class_id = ?1 AND teacher_id = ?2")
        .bind(id)
        .bind(teacher_id)
        .execute(&state.db)
        .await?;

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "class.revoke_teacher",
        "class",
        &id.to_string(),
    )
    .await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 教师账号列表（管理员）。
async fn list_teachers(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;

    let rows = sqlx::query_as::<_, (i64, String, String, String, i64)>(
        "SELECT id, username, display_name, role, is_active FROM users ORDER BY role, username",
    )
    .fetch_all(&state.db)
    .await?;

    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "id": r.0,
                "username": r.1,
                "display_name": r.2,
                "role": r.3,
                "is_active": r.4,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "items": items })))
}

#[derive(Debug, serde::Deserialize)]
pub struct GrantTeacherRequest {
    pub teacher_id: i64,
}
