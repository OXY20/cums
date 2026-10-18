//! 课堂场次接口：创建、开始、暂停、结束与当前课堂查询。

use crate::error::{AppError, AppResult};
use crate::models::{CreateSessionRequest, CurrentSessionView, ListResponse, SessionRow};
use crate::routes::AuthUser;
use crate::state::{AppState, SessionEvent};
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/student/current-session", get(current_session))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route("/api/sessions/{id}", get(get_session))
        .route("/api/sessions/{id}/start", post(start_session))
        .route("/api/sessions/{id}/pause", post(pause_session))
        .route("/api/sessions/{id}/end", post(end_session))
}

/// 学生端当前课堂查询参数。
#[derive(Debug, Deserialize)]
pub struct CurrentSessionQuery {
    /// 班级 ID；缺省时返回全局最近的进行中课堂。
    pub class_id: Option<i64>,
}

/// 学生端：获取当前正在进行的课堂。
///
/// 无进行中课堂时返回 `session: null`，前端展示等待状态。
async fn current_session(
    State(state): State<AppState>,
    Query(query): Query<CurrentSessionQuery>,
) -> AppResult<Json<Option<CurrentSessionView>>> {
    let row = match query.class_id {
        Some(class_id) => {
            sqlx::query_as::<_, SessionRow>(
                "SELECT id, class_id, teacher_id, lesson_id, status, started_at, paused_at, ended_at
                 FROM classroom_sessions
                 WHERE class_id = ?1 AND status IN ('running', 'paused')
                 ORDER BY started_at DESC LIMIT 1",
            )
            .bind(class_id)
            .fetch_optional(&state.db)
            .await?
        }
        None => {
            sqlx::query_as::<_, SessionRow>(
                "SELECT id, class_id, teacher_id, lesson_id, status, started_at, paused_at, ended_at
                 FROM classroom_sessions
                 WHERE status IN ('running', 'paused')
                 ORDER BY started_at DESC LIMIT 1",
            )
            .fetch_optional(&state.db)
            .await?
        }
    };

    match row {
        Some(session) => Ok(Json(Some(build_view(&state, session).await?))),
        None => Ok(Json(None)),
    }
}

/// 课堂列表（教师端）。
async fn list_sessions(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<ListResponse<SessionRow>>> {
    let rows = if user.0.role == crate::auth::Role::Admin {
        sqlx::query_as::<_, SessionRow>(
            "SELECT id, class_id, teacher_id, lesson_id, status, started_at, paused_at, ended_at
             FROM classroom_sessions ORDER BY started_at DESC LIMIT 200",
        )
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, SessionRow>(
            "SELECT id, class_id, teacher_id, lesson_id, status, started_at, paused_at, ended_at
             FROM classroom_sessions WHERE teacher_id = ?1
             ORDER BY started_at DESC LIMIT 200",
        )
        .bind(user.id())
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(ListResponse::new(rows)))
}

/// 课堂详情（含快照内容，历史稳定）。
async fn get_session(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<CurrentSessionView>> {
    let session = fetch_session(&state, id).await?;
    Ok(Json(build_view(&state, session).await?))
}

pub async fn fetch_session(state: &AppState, id: i64) -> AppResult<SessionRow> {
    sqlx::query_as::<_, SessionRow>(
        "SELECT id, class_id, teacher_id, lesson_id, status, started_at, paused_at, ended_at
         FROM classroom_sessions WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("课堂 {id}")))
}

/// 创建课堂场次（草稿状态，等待开始）。
///
/// 同一班级同一时间只允许一个活动课堂，由数据库唯一索引与事务共同保证。
async fn create_session(
    State(state): State<AppState>,
    user: AuthUser,
    Json(payload): Json<CreateSessionRequest>,
) -> AppResult<Json<SessionRow>> {
    // 教师只能操作被授权的班级。
    if user.0.role != crate::auth::Role::Admin {
        let allowed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM teacher_classes WHERE teacher_id = ?1 AND class_id = ?2",
        )
        .bind(user.id())
        .bind(payload.class_id)
        .fetch_one(&state.db)
        .await?;

        if allowed == 0 {
            return Err(AppError::Forbidden);
        }
    }

    let active: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM classroom_sessions
         WHERE class_id = ?1 AND status IN ('running', 'paused')",
    )
    .bind(payload.class_id)
    .fetch_optional(&state.db)
    .await?;

    if let Some(existing) = active {
        return Err(AppError::Conflict(format!(
            "该班级已有进行中的课堂（ID {existing}），请先结束"
        )));
    }

    // 保存课时内容快照，避免模板后续修改影响历史课堂。
    //
    // 快照同时保存结构化文字字段与富文本正文：
    // 后者已在保存课时时清洗过，这里原样快照即可。
    let lesson = crate::routes::lessons::fetch_lesson(&state, payload.lesson_id).await?;

    let snapshot = serde_json::json!({
        "fields": serde_json::from_str::<serde_json::Value>(&lesson.content_json)
            .unwrap_or_else(|_| serde_json::json!({})),
        "html": lesson.content_html,
        "format": lesson.content_format,
    })
    .to_string();

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO classroom_sessions (class_id, teacher_id, lesson_id, status, lesson_snapshot)
         VALUES (?1, ?2, ?3, 'paused', ?4) RETURNING id",
    )
    .bind(payload.class_id)
    .bind(user.id())
    .bind(payload.lesson_id)
    .bind(&snapshot)
    .fetch_one(&state.db)
    .await?;

    crate::routes::auth::audit(&state, Some(user.id()), "session.create", "session", &id.to_string())
        .await;

    fetch_session(&state, id).await.map(Json)
}

/// 开始上课。
async fn start_session(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<SessionRow>> {
    let session = fetch_session(&state, id).await?;
    ensure_owner(&session, &user)?;

    if session.status == "ended" {
        return Err(AppError::Conflict("课堂已结束，无法重新开始".into()));
    }

    sqlx::query(
        "UPDATE classroom_sessions SET status = 'running', paused_at = NULL,
            started_at = CASE WHEN started_at IS NULL THEN datetime('now') ELSE started_at END,
            updated_at = datetime('now')
         WHERE id = ?1",
    )
    .bind(id)
    .execute(&state.db)
    .await?;

    emit(&state, id, "session.started").await;
    fetch_session(&state, id).await.map(Json)
}

/// 暂停课堂。
async fn pause_session(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<SessionRow>> {
    let session = fetch_session(&state, id).await?;
    ensure_owner(&session, &user)?;

    if session.status != "running" {
        return Err(AppError::Conflict("只有进行中的课堂可以暂停".into()));
    }

    sqlx::query(
        "UPDATE classroom_sessions SET status = 'paused', paused_at = datetime('now'),
            updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(id)
    .execute(&state.db)
    .await?;

    emit(&state, id, "session.paused").await;
    fetch_session(&state, id).await.map(Json)
}

/// 结束课堂。
async fn end_session(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<SessionRow>> {
    let session = fetch_session(&state, id).await?;
    ensure_owner(&session, &user)?;

    if session.status == "ended" {
        return Err(AppError::Conflict("课堂已经结束".into()));
    }

    sqlx::query(
        "UPDATE classroom_sessions SET status = 'ended', ended_at = datetime('now'),
            updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(id)
    .execute(&state.db)
    .await?;

    emit(&state, id, "session.ended").await;
    fetch_session(&state, id).await.map(Json)
}

/// 教师只能操作自己的课堂；管理员不受限制。
fn ensure_owner(session: &SessionRow, user: &AuthUser) -> AppResult<()> {
    if user.0.role == crate::auth::Role::Admin || session.teacher_id == user.id() {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

/// 记录并广播课堂事件。
async fn emit(state: &AppState, session_id: i64, event_type: &str) {
    let payload = serde_json::json!({ "session_id": session_id });

    if let Err(err) = sqlx::query(
        "INSERT INTO session_events (session_id, event_type, payload_json) VALUES (?1, ?2, ?3)",
    )
    .bind(session_id)
    .bind(event_type)
    .bind(payload.to_string())
    .execute(&state.db)
    .await
    {
        tracing::warn!(error = %err, "课堂事件写入失败");
    }

    state.publish(SessionEvent {
        session_id: Some(session_id),
        event_type: event_type.to_string(),
        payload,
        created_at: chrono::Utc::now().to_rfc3339(),
    });
}

/// 组装学生端课堂视图。
///
/// 快照存在两种格式：
/// - 新格式：`{ fields: {...}, html: "...", format: "html" }`
/// - 旧格式：直接是结构化字段对象 `{ goal: "...", ... }`
///
/// 这里统一归一化，保证历史课堂仍可正常展示。
async fn build_view(state: &AppState, session: SessionRow) -> AppResult<CurrentSessionView> {
    let meta = sqlx::query_as::<_, (String, String, String, String, String)>(
        "SELECT cl.name, u.display_name, c.title, l.title, cs.lesson_snapshot
         FROM classroom_sessions cs
         JOIN classes cl ON cl.id = cs.class_id
         JOIN users   u  ON u.id  = cs.teacher_id
         JOIN lessons l  ON l.id  = cs.lesson_id
         JOIN courses c  ON c.id  = l.course_id
         WHERE cs.id = ?1",
    )
    .bind(session.id)
    .fetch_one(&state.db)
    .await?;

    let snapshot: serde_json::Value =
        serde_json::from_str(&meta.4).unwrap_or_else(|_| serde_json::json!({}));

    let (fields, html) = if let Some(object) = snapshot.as_object() {
        if object.contains_key("fields") || object.contains_key("html") {
            (
                object.get("fields").cloned().unwrap_or_else(|| serde_json::json!({})),
                object
                    .get("html")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
            )
        } else {
            // 旧格式：整个对象就是结构化字段
            (snapshot.clone(), String::new())
        }
    } else {
        (serde_json::json!({}), String::new())
    };

    Ok(CurrentSessionView {
        session,
        class_name: meta.0,
        teacher_name: meta.1,
        course_title: meta.2,
        lesson_title: meta.3,
        lesson_content: fields,
        lesson_html: html,
    })
}
