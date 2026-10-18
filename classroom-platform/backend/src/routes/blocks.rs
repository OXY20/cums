//! 课时正文块接口：文字与媒体按顺序混排。
//!
//! 支撑「在课程管理内直接编辑上传」：教师可插入文字段落、图片、视频，
//! 并按需调整顺序，无需先去资源库上传再回来关联。

use crate::error::{AppError, AppResult};
use crate::models::{
    CreateBlockRequest, LessonBlockRow, ListResponse, ReorderBlocksRequest, UpdateBlockRequest,
};
use crate::routes::AuthUser;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::routing::{get, put};
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/lessons/{lesson_id}/blocks",
            get(list_blocks).post(create_block),
        )
        .route(
            "/api/lessons/{lesson_id}/blocks/reorder",
            put(reorder_blocks),
        )
        .route(
            "/api/blocks/{id}",
            put(update_block).delete(delete_block),
        )
}

/// 列出某课时的全部正文块，媒体块附带资源信息。
async fn list_blocks(
    State(state): State<AppState>,
    Path(lesson_id): Path<i64>,
) -> AppResult<Json<ListResponse<LessonBlockRow>>> {
    let rows = fetch_blocks(&state, lesson_id).await?;
    Ok(Json(ListResponse::new(rows)))
}

/// 读取课时正文块（内部复用）。
pub async fn fetch_blocks(state: &AppState, lesson_id: i64) -> AppResult<Vec<LessonBlockRow>> {
    let rows = sqlx::query_as::<_, LessonBlockRow>(
        "SELECT b.id, b.lesson_id, b.block_type, b.text_content, b.title,
                b.resource_id, b.sort_order,
                r.name  AS resource_name,
                r.size_bytes AS resource_size,
                r.mime_type  AS resource_mime
         FROM lesson_blocks b
         LEFT JOIN resources r ON r.id = b.resource_id
         WHERE b.lesson_id = ?1
         ORDER BY b.sort_order ASC, b.id ASC",
    )
    .bind(lesson_id)
    .fetch_all(&state.db)
    .await?;

    Ok(rows)
}

/// 新增正文块。
async fn create_block(
    State(state): State<AppState>,
    user: AuthUser,
    Path(lesson_id): Path<i64>,
    Json(payload): Json<CreateBlockRequest>,
) -> AppResult<Json<LessonBlockRow>> {
    crate::routes::lessons::fetch_lesson(&state, lesson_id).await?;

    let block_type = payload.block_type.trim();
    if !matches!(block_type, "text" | "image" | "video" | "file") {
        return Err(AppError::BadRequest(format!(
            "不支持的块类型：{block_type}"
        )));
    }

    // 媒体块必须指向一个已就绪的资源。
    if block_type != "text" {
        let resource_id = payload
            .resource_id
            .ok_or_else(|| AppError::BadRequest("媒体块必须指定资源".into()))?;
        let resource = crate::routes::resources::fetch_resource(&state, resource_id).await?;
        if resource.status != "ready" {
            return Err(AppError::Conflict("资源尚未上传完成，无法插入".into()));
        }
    }

    if block_type == "text" && payload.text_content.trim().is_empty() {
        return Err(AppError::BadRequest("文字内容不能为空".into()));
    }

    let max: Option<i64> =
        sqlx::query_scalar("SELECT MAX(sort_order) FROM lesson_blocks WHERE lesson_id = ?1")
            .bind(lesson_id)
            .fetch_one(&state.db)
            .await?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO lesson_blocks (lesson_id, block_type, text_content, title, resource_id, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id",
    )
    .bind(lesson_id)
    .bind(block_type)
    .bind(&payload.text_content)
    .bind(payload.title.trim())
    .bind(payload.resource_id)
    .bind(max.unwrap_or(0) + 1)
    .fetch_one(&state.db)
    .await?;

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "lesson_block.create",
        "lesson",
        &lesson_id.to_string(),
    )
    .await;

    fetch_block(&state, id).await.map(Json)
}

async fn fetch_block(state: &AppState, id: i64) -> AppResult<LessonBlockRow> {
    sqlx::query_as::<_, LessonBlockRow>(
        "SELECT b.id, b.lesson_id, b.block_type, b.text_content, b.title,
                b.resource_id, b.sort_order,
                r.name  AS resource_name,
                r.size_bytes AS resource_size,
                r.mime_type  AS resource_mime
         FROM lesson_blocks b
         LEFT JOIN resources r ON r.id = b.resource_id
         WHERE b.id = ?1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("正文块 {id}")))
}

/// 更新正文块内容或顺序。
async fn update_block(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(payload): Json<UpdateBlockRequest>,
) -> AppResult<Json<LessonBlockRow>> {
    let existing = fetch_block(&state, id).await?;

    if let Some(text) = &payload.text_content {
        if existing.block_type == "text" && text.trim().is_empty() {
            return Err(AppError::BadRequest("文字内容不能为空".into()));
        }
    }

    sqlx::query(
        "UPDATE lesson_blocks SET
            text_content = COALESCE(?1, text_content),
            title        = COALESCE(?2, title),
            resource_id  = COALESCE(?3, resource_id),
            sort_order   = COALESCE(?4, sort_order),
            updated_at   = datetime('now')
         WHERE id = ?5",
    )
    .bind(payload.text_content.as_deref())
    .bind(payload.title.as_deref())
    .bind(payload.resource_id)
    .bind(payload.sort_order)
    .bind(id)
    .execute(&state.db)
    .await?;

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "lesson_block.update",
        "lesson",
        &existing.lesson_id.to_string(),
    )
    .await;

    fetch_block(&state, id).await.map(Json)
}

/// 删除正文块。
///
/// 仅删除块记录，资源本身保留在资源库中，因为同一资源可能被多个课时复用。
async fn delete_block(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let existing = fetch_block(&state, id).await?;

    sqlx::query("DELETE FROM lesson_blocks WHERE id = ?1")
        .bind(id)
        .execute(&state.db)
        .await?;

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "lesson_block.delete",
        "lesson",
        &existing.lesson_id.to_string(),
    )
    .await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 批量重排正文块：按给定 ID 顺序写回 `sort_order`。
async fn reorder_blocks(
    State(state): State<AppState>,
    user: AuthUser,
    Path(lesson_id): Path<i64>,
    Json(payload): Json<ReorderBlocksRequest>,
) -> AppResult<Json<ListResponse<LessonBlockRow>>> {
    let mut tx = state.db.begin().await?;

    for (index, block_id) in payload.block_ids.iter().enumerate() {
        sqlx::query(
            "UPDATE lesson_blocks SET sort_order = ?1, updated_at = datetime('now')
             WHERE id = ?2 AND lesson_id = ?3",
        )
        .bind((index + 1) as i64)
        .bind(block_id)
        .bind(lesson_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "lesson_block.reorder",
        "lesson",
        &lesson_id.to_string(),
    )
    .await;

    let rows = fetch_blocks(&state, lesson_id).await?;
    Ok(Json(ListResponse::new(rows)))
}
