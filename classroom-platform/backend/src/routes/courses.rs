//! 课程接口。

use crate::error::{AppError, AppResult};
use crate::models::{CourseRow, CreateCourseRequest, ListResponse, UpdateCourseRequest};
use crate::routes::AuthUser;
use crate::state::AppState;
use axum::extract::{DefaultBodyLimit, Multipart, Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use uuid::Uuid;

/// 课程查询的公共字段，保证各处返回结构一致。
const COURSE_SELECT: &str = "SELECT c.id, c.title, c.description, c.cover_key, c.cover_resource_id,
        c.status, c.created_at, c.updated_at,
        (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count
 FROM courses c";

pub fn routes() -> Router<AppState> {
    Router::new()
        // 学生端只看到已发布课程，草稿与归档课程不对外展示。
        .route("/api/student/courses", get(list_published_courses))
        .route("/api/courses", get(list_courses).post(create_course))
        .route(
            "/api/courses/{id}",
            get(get_course).put(update_course).delete(delete_course),
        )
        .route("/api/courses/{id}/copy", post(copy_course))
        // 封面上传：直接传图即可，无需先去资源库登记。
        .route(
            "/api/courses/{id}/cover",
            post(upload_cover).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/courses/{id}/cover", axum::routing::delete(clear_cover))
}

/// 学生端课程列表：仅已发布课程。
async fn list_published_courses(
    State(state): State<AppState>,
) -> AppResult<Json<ListResponse<CourseRow>>> {
    let rows = sqlx::query_as::<_, CourseRow>(&format!(
        "{COURSE_SELECT} WHERE c.status = 'published' ORDER BY c.updated_at DESC"
    ))
    .fetch_all(&state.db)
    .await?;

    Ok(Json(ListResponse::new(rows)))
}

/// 课程列表（教师端）：包含草稿与归档课程。
async fn list_courses(State(state): State<AppState>) -> AppResult<Json<ListResponse<CourseRow>>> {
    let rows = sqlx::query_as::<_, CourseRow>(&format!(
        "{COURSE_SELECT} ORDER BY c.updated_at DESC"
    ))
    .fetch_all(&state.db)
    .await?;

    Ok(Json(ListResponse::new(rows)))
}

/// 课程详情。
async fn get_course(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<CourseRow>> {
    let row = sqlx::query_as::<_, CourseRow>(&format!("{COURSE_SELECT} WHERE c.id = ?1"))
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
            title             = COALESCE(?1, title),
            description       = COALESCE(?2, description),
            cover_key         = COALESCE(?3, cover_key),
            cover_resource_id = COALESCE(?4, cover_resource_id),
            status            = COALESCE(?5, status),
            updated_at        = datetime('now')
         WHERE id = ?6",
    )
    .bind(payload.title.as_deref())
    .bind(payload.description.as_deref())
    .bind(payload.cover_key.as_deref())
    .bind(payload.cover_resource_id)
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
    let source = sqlx::query_as::<_, (String, String, Option<String>, Option<i64>)>(
        "SELECT title, description, cover_key, cover_resource_id FROM courses WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("课程 {id}")))?;

    let new_title = format!("{}（副本）", source.0);

    let new_id: i64 = sqlx::query_scalar(
        "INSERT INTO courses (title, description, cover_key, cover_resource_id, status, created_by)
         VALUES (?1, ?2, ?3, ?4, 'draft', ?5) RETURNING id",
    )
    .bind(&new_title)
    .bind(&source.1)
    .bind(&source.2)
    .bind(source.3)
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

/// 上传课程封面。
///
/// 一步完成：创建资源占位 → 接收图片 → 校验发布 → 写入课程封面引用。
/// 只接受图片类型，避免误传视频等大文件占据封面位。
async fn upload_cover(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    multipart: Multipart,
) -> AppResult<Json<CourseRow>> {
    // 课程必须存在，避免产生孤立封面资源。
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM courses WHERE id = ?1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("课程 {id}")));
    }

    let storage_key = format!("{}/{}", &Uuid::new_v4().to_string()[..2], Uuid::new_v4());
    let resource_id: i64 = sqlx::query_scalar(
        "INSERT INTO resources (name, storage_key, size_bytes, sha256, mime_type, status, uploaded_by)
         VALUES ('课程封面', ?1, 0, '', 'application/octet-stream', 'staging', ?2) RETURNING id",
    )
    .bind(&storage_key)
    .bind(user.id())
    .fetch_one(&state.db)
    .await?;

    let placeholder = crate::routes::resources::fetch_resource(&state, resource_id).await?;

    let resource = match crate::routes::resources::receive_content(&state, &placeholder, multipart).await
    {
        Ok(resource) => resource,
        Err(err) => {
            // 上传失败时清理占位记录与可能的残留文件。
            let _ = sqlx::query("DELETE FROM resources WHERE id = ?1")
                .bind(resource_id)
                .execute(&state.db)
                .await;
            return Err(err);
        }
    };

    if !resource.mime_type.starts_with("image/") {
        let _ = sqlx::query("DELETE FROM resources WHERE id = ?1")
            .bind(resource_id)
            .execute(&state.db)
            .await;
        let path = crate::routes::resources::safe_join(&state.config.objects_dir, &resource.storage_key)?;
        let _ = tokio::fs::remove_file(&path).await;
        return Err(AppError::BadRequest(
            "课程封面必须是图片（JPG / PNG / WebP 等）".into(),
        ));
    }

    // 替换封面时清理旧封面资源，避免磁盘上积累无用图片。
    let old_cover: Option<i64> =
        sqlx::query_scalar("SELECT cover_resource_id FROM courses WHERE id = ?1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?
            .flatten();

    sqlx::query(
        "UPDATE courses SET cover_resource_id = ?1, updated_at = datetime('now') WHERE id = ?2",
    )
    .bind(resource_id)
    .bind(id)
    .execute(&state.db)
    .await?;

    if let Some(old_id) = old_cover {
        if old_id != resource_id {
            delete_resource_quietly(&state, old_id).await;
        }
    }

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "course.upload_cover",
        "course",
        &id.to_string(),
    )
    .await;

    get_course(State(state), Path(id)).await
}

/// 移除课程封面。
async fn clear_cover(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<CourseRow>> {
    let old_cover: Option<i64> =
        sqlx::query_scalar("SELECT cover_resource_id FROM courses WHERE id = ?1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("课程 {id}")))?;

    sqlx::query("UPDATE courses SET cover_resource_id = NULL, updated_at = datetime('now') WHERE id = ?1")
        .bind(id)
        .execute(&state.db)
        .await?;

    if let Some(old_id) = old_cover {
        delete_resource_quietly(&state, old_id).await;
    }

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "course.clear_cover",
        "course",
        &id.to_string(),
    )
    .await;

    get_course(State(state), Path(id)).await
}

/// 删除资源记录与文件；失败不阻断主流程。
async fn delete_resource_quietly(state: &AppState, resource_id: i64) {
    if let Ok(resource) = crate::routes::resources::fetch_resource(state, resource_id).await {
        if let Ok(path) =
            crate::routes::resources::safe_join(&state.config.objects_dir, &resource.storage_key)
        {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
    let _ = sqlx::query("DELETE FROM resources WHERE id = ?1")
        .bind(resource_id)
        .execute(&state.db)
        .await;
}
