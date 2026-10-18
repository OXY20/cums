//! 资源库接口：登记、上传、列表与课时关联。

use crate::error::{AppError, AppResult};
use crate::models::{
    AttachResourceRequest, LessonResourceRow, ListResponse, RegisterResourceRequest,
    RegisterResourceResponse, ResourceRow,
};
use crate::routes::AuthUser;
use crate::state::AppState;
use axum::extract::{DefaultBodyLimit, Multipart, Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/resources", get(list_resources))
        .route("/api/resources/register", post(register_resource))
        // 大文件上传必须解除 axum 默认 2 MiB 请求体上限；
        // 实际大小由处理器按 storage.max_file_bytes 流式校验，内存占用恒定。
        .route(
            "/api/resources/{id}/upload",
            post(upload_resource).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/resources/{id}", get(get_resource).delete(delete_resource))
        // 课时内直传：一步完成登记、上传与关联，免去「先去资源库再回来关联」。
        .route(
            "/api/lessons/{lesson_id}/resources/upload",
            post(upload_lesson_resource).layer(DefaultBodyLimit::disable()),
        )
}

/// 资源列表。
async fn list_resources(
    State(state): State<AppState>,
    _user: AuthUser,
) -> AppResult<Json<ListResponse<ResourceRow>>> {
    let rows = sqlx::query_as::<_, ResourceRow>(
        "SELECT id, name, storage_key, size_bytes, sha256, mime_type, version, status, created_at
         FROM resources ORDER BY created_at DESC LIMIT 500",
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(ListResponse::new(rows)))
}

/// 资源详情。
async fn get_resource(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<ResourceRow>> {
    fetch_resource(&state, id).await.map(Json)
}

pub async fn fetch_resource(state: &AppState, id: i64) -> AppResult<ResourceRow> {
    sqlx::query_as::<_, ResourceRow>(
        "SELECT id, name, storage_key, size_bytes, sha256, mime_type, version, status, created_at
         FROM resources WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("资源 {id}")))
}

/// 第一步：登记资源元数据。
///
/// 客户端不能指定服务器路径；`storage_key` 由服务端生成。
async fn register_resource(
    State(state): State<AppState>,
    user: AuthUser,
    Json(payload): Json<RegisterResourceRequest>,
) -> AppResult<Json<RegisterResourceResponse>> {
    let name = payload.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("资源名称不能为空".into()));
    }

    let max_bytes = state.config.raw.storage.max_file_bytes as i64;
    if payload.size_bytes < 0 || payload.size_bytes > max_bytes {
        return Err(AppError::BadRequest(format!(
            "文件大小超出限制（上限 {} 字节）",
            max_bytes
        )));
    }

    // storage_key 使用 UUID 目录，避免同名覆盖与路径穿越。
    let storage_key = format!("{}/{}", &Uuid::new_v4().to_string()[..2], Uuid::new_v4());

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO resources (name, storage_key, size_bytes, sha256, mime_type, status, uploaded_by)
         VALUES (?1, ?2, ?3, ?4, ?5, 'staging', ?6) RETURNING id",
    )
    .bind(name)
    .bind(&storage_key)
    .bind(payload.size_bytes)
    .bind(payload.sha256.unwrap_or_default())
    .bind(
        payload
            .mime_type
            .unwrap_or_else(|| "application/octet-stream".to_string()),
    )
    .bind(user.id())
    .fetch_one(&state.db)
    .await?;

    crate::routes::auth::audit(&state, Some(user.id()), "resource.register", "resource", &id.to_string())
        .await;

    Ok(Json(RegisterResourceResponse {
        resource_id: id,
        upload_token: storage_key.clone(),
        storage_key,
    }))
}

/// 第二步：上传文件内容到 staging，校验通过后发布到 objects。
///
/// 采用"先写临时文件、校验 SHA-256、再原子改名"的流程，避免半成品文件被下载。
async fn upload_resource(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    multipart: Multipart,
) -> AppResult<Json<ResourceRow>> {
    let resource = fetch_resource(&state, id).await?;
    let updated = receive_content(&state, &resource, multipart).await?;

    crate::routes::auth::audit(&state, Some(user.id()), "resource.upload", "resource", &id.to_string())
        .await;

    Ok(Json(updated))
}

/// 接收上传内容并发布资源。
///
/// 抽成独立函数，供「资源库上传」「课时内直传」「课程封面上传」共用，
/// 保证三处的校验、清理与发布逻辑完全一致。
pub async fn receive_content(
    state: &AppState,
    resource: &ResourceRow,
    mut multipart: Multipart,
) -> AppResult<ResourceRow> {
    let staging_path = safe_join(&state.config.staging_dir, &resource.storage_key)?;
    if let Some(parent) = staging_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut file = tokio::fs::File::create(&staging_path).await?;

    // 记录上传时实际提交的文件名，便于按扩展名判定资源类型。
    let mut uploaded_name: Option<String> = None;
    let mut uploaded_mime: Option<String> = None;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("上传解析失败：{e}")))?
    {
        if field.name() == Some("file") {
            uploaded_name = field.file_name().map(|n| n.to_string());
            uploaded_mime = field.content_type().map(|m| m.to_string());
        }

        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| AppError::BadRequest(format!("读取上传数据失败：{e}")))?
        {
            written += chunk.len() as u64;
            if written > state.config.raw.storage.max_file_bytes {
                drop(file);
                let _ = tokio::fs::remove_file(&staging_path).await;
                return Err(AppError::BadRequest("文件超出大小限制".into()));
            }
            hasher.update(&chunk);
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
        }
    }

    tokio::io::AsyncWriteExt::flush(&mut file).await?;
    drop(file);

    if written == 0 {
        let _ = tokio::fs::remove_file(&staging_path).await;
        return Err(AppError::BadRequest("上传内容为空".into()));
    }

    let digest = hex::encode(hasher.finalize());

    // 客户端预先提供了摘要时进行比对，识别传输损坏。
    if !resource.sha256.is_empty() && !resource.sha256.eq_ignore_ascii_case(&digest) {
        let _ = tokio::fs::remove_file(&staging_path).await;
        return Err(AppError::BadRequest(format!(
            "文件校验失败：期望 {}，实际 {}",
            resource.sha256, digest
        )));
    }

    let objects_path = safe_join(&state.config.objects_dir, &resource.storage_key)?;
    if let Some(parent) = objects_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::rename(&staging_path, &objects_path).await?;

    // 以实际提交的文件名与类型为准，避免浏览器把视频报成 octet-stream。
    let final_name = uploaded_name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| resource.name.clone());
    let final_mime = uploaded_mime
        .filter(|m| m != "application/octet-stream")
        .or_else(|| {
            mime_guess::from_path(&final_name)
                .first()
                .map(|m| m.to_string())
        })
        .unwrap_or_else(|| resource.mime_type.clone());

    sqlx::query(
        "UPDATE resources SET sha256 = ?1, size_bytes = ?2, name = ?3, mime_type = ?4,
            status = 'ready', updated_at = datetime('now') WHERE id = ?5",
    )
    .bind(&digest)
    .bind(written as i64)
    .bind(&final_name)
    .bind(&final_mime)
    .bind(resource.id)
    .execute(&state.db)
    .await?;

    fetch_resource(state, resource.id).await
}

/// 删除资源记录与文件。
async fn delete_resource(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let resource = fetch_resource(&state, id).await?;

    let path = safe_join(&state.config.objects_dir, &resource.storage_key)?;
    if path.exists() {
        let _ = tokio::fs::remove_file(&path).await;
    }

    sqlx::query("DELETE FROM resources WHERE id = ?1")
        .bind(id)
        .execute(&state.db)
        .await?;

    crate::routes::auth::audit(&state, Some(user.id()), "resource.delete", "resource", &id.to_string())
        .await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 课时关联的资源列表，含用途与排序。
pub async fn lesson_resources(
    State(state): State<AppState>,
    Path(lesson_id): Path<i64>,
) -> AppResult<Json<ListResponse<LessonResourceRow>>> {
    let rows = sqlx::query_as::<_, LessonResourceRow>(
        "SELECT r.id, r.name, r.storage_key, r.size_bytes, r.sha256, r.mime_type,
                r.version, r.status, r.created_at,
                lr.purpose, lr.required, lr.sort_order
         FROM lesson_resources lr
         JOIN resources r ON r.id = lr.resource_id
         WHERE lr.lesson_id = ?1
         ORDER BY lr.sort_order ASC, r.id ASC",
    )
    .bind(lesson_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(ListResponse::new(rows)))
}

/// 课时内直接上传：一步完成「登记 → 上传 → 关联」。
///
/// 教师无需先去资源库上传再回来关联，上传后立即出现在当前课时中。
async fn upload_lesson_resource(
    State(state): State<AppState>,
    user: AuthUser,
    Path(lesson_id): Path<i64>,
    multipart: Multipart,
) -> AppResult<Json<LessonResourceRow>> {
    // 课时必须存在，避免上传后产生孤立资源。
    crate::routes::lessons::fetch_lesson(&state, lesson_id).await?;

    let placeholder = create_staging_resource(&state, user.id(), "上传中").await?;

    let resource = match receive_content(&state, &placeholder, multipart).await {
        Ok(resource) => resource,
        Err(err) => {
            // 上传失败时清理占位记录，避免留下永远处于 staging 的脏数据。
            let _ = sqlx::query("DELETE FROM resources WHERE id = ?1")
                .bind(placeholder.id)
                .execute(&state.db)
                .await;
            return Err(err);
        }
    };

    let purpose = infer_purpose(&resource.mime_type, &resource.name);
    let row = attach_with_purpose(&state, lesson_id, resource.id, purpose).await?;

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "lesson_resource.upload",
        "lesson",
        &lesson_id.to_string(),
    )
    .await;

    Ok(Json(row))
}

/// 按 MIME 类型推断资源用途。
///
/// 图片与视频内嵌展示，其余一律作为附件提供下载。
fn infer_purpose(mime: &str, name: &str) -> &'static str {
    if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("video/") {
        "video"
    } else if mime.is_empty() || mime == "application/octet-stream" {
        // 浏览器未提供类型时按扩展名兜底。
        let ext = std::path::Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match ext.as_str() {
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" => "image",
            "mp4" | "webm" | "mov" | "mkv" | "avi" => "video",
            _ => "attachment",
        }
    } else {
        "attachment"
    }
}

/// 创建待上传的资源占位记录。
///
/// 直传时客户端无需预先提供大小与摘要，因此先落一条 `staging` 记录，
/// 上传完成后再回填真实元数据。
async fn create_staging_resource(
    state: &AppState,
    user_id: i64,
    name: &str,
) -> AppResult<ResourceRow> {
    let storage_key = format!("{}/{}", &Uuid::new_v4().to_string()[..2], Uuid::new_v4());

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO resources (name, storage_key, size_bytes, sha256, mime_type, status, uploaded_by)
         VALUES (?1, ?2, 0, '', 'application/octet-stream', 'staging', ?3) RETURNING id",
    )
    .bind(name)
    .bind(&storage_key)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    fetch_resource(state, id).await
}

/// 关联资源到课时，并指定用途。
pub async fn attach_resource(
    State(state): State<AppState>,
    user: AuthUser,
    Path((lesson_id, resource_id)): Path<(i64, i64)>,
    payload: Option<Json<AttachResourceRequest>>,
) -> AppResult<Json<LessonResourceRow>> {
    let resource = fetch_resource(&state, resource_id).await?;

    // 未显式指定用途时按资源类型推断，保证内嵌展示正确。
    let purpose = payload
        .and_then(|Json(body)| body.purpose)
        .unwrap_or_else(|| infer_purpose(&resource.mime_type, &resource.name).to_string());

    let row = attach_with_purpose(&state, lesson_id, resource_id, &purpose).await?;

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "lesson_resource.attach",
        "lesson",
        &lesson_id.to_string(),
    )
    .await;

    Ok(Json(row))
}

/// 写入关联记录并返回完整行；已存在时更新用途。
async fn attach_with_purpose(
    state: &AppState,
    lesson_id: i64,
    resource_id: i64,
    purpose: &str,
) -> AppResult<LessonResourceRow> {
    sqlx::query(
        "INSERT INTO lesson_resources (lesson_id, resource_id, purpose, required, sort_order)
         VALUES (?1, ?2, ?3, 0,
                 COALESCE((SELECT MAX(sort_order) + 1 FROM lesson_resources WHERE lesson_id = ?1), 1))
         ON CONFLICT(lesson_id, resource_id) DO UPDATE SET purpose = excluded.purpose",
    )
    .bind(lesson_id)
    .bind(resource_id)
    .bind(purpose)
    .execute(&state.db)
    .await?;

    sqlx::query_as::<_, LessonResourceRow>(
        "SELECT r.id, r.name, r.storage_key, r.size_bytes, r.sha256, r.mime_type,
                r.version, r.status, r.created_at,
                lr.purpose, lr.required, lr.sort_order
         FROM lesson_resources lr
         JOIN resources r ON r.id = lr.resource_id
         WHERE lr.lesson_id = ?1 AND lr.resource_id = ?2",
    )
    .bind(lesson_id)
    .bind(resource_id)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::from)
}

/// 解除课时与资源的关联。
pub async fn detach_resource(
    State(state): State<AppState>,
    user: AuthUser,
    Path((lesson_id, resource_id)): Path<(i64, i64)>,
) -> AppResult<Json<serde_json::Value>> {
    sqlx::query("DELETE FROM lesson_resources WHERE lesson_id = ?1 AND resource_id = ?2")
        .bind(lesson_id)
        .bind(resource_id)
        .execute(&state.db)
        .await?;

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "lesson_resource.detach",
        "lesson",
        &lesson_id.to_string(),
    )
    .await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 将 `storage_key` 安全地拼接到根目录下，拒绝路径穿越。
///
/// `storage_key` 由服务端生成，但此处仍做两层防御：
/// 1. 组件级校验：拒绝绝对路径、`..` 与盘符前缀；
/// 2. 目录级校验：父目录存在时比较规范化后的路径，防止符号链接逃逸。
///
/// 注意：Windows 上 `canonicalize` 会返回 `\\?\` 前缀，因此比较双方都必须规范化。
pub fn safe_join(root: &std::path::Path, storage_key: &str) -> AppResult<PathBuf> {
    use std::path::Component;

    let relative = std::path::Path::new(storage_key);
    let has_unsafe_component = relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    });

    if storage_key.is_empty() || relative.is_absolute() || has_unsafe_component {
        return Err(AppError::Forbidden);
    }

    let candidate = root.join(relative);

    // 目标文件可能尚不存在，因此只校验其父目录。
    let parent = candidate.parent().unwrap_or(root);
    if parent.exists() {
        let canonical_root = root.canonicalize()?;
        let canonical_parent = parent.canonicalize()?;
        if !canonical_parent.starts_with(&canonical_root) {
            return Err(AppError::Forbidden);
        }
    }

    Ok(candidate)
}
