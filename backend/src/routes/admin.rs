//! 管理端接口：服务健康状态与审计日志。

use crate::error::AppResult;
use crate::models::HealthResponse;
use crate::routes::AuthUser;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/admin/health", get(health))
        .route("/api/admin/audit-logs", get(audit_logs))
        .route("/api/admin/storage", get(storage_usage))
}

/// 服务健康状态：低开销查询，不写数据库。
async fn health(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<HealthResponse>> {
    user.require_admin()?;

    let database = if sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.db)
        .await
        .is_ok()
    {
        "ok"
    } else {
        "error"
    };

    let active_sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM classroom_sessions WHERE status IN ('running', 'paused')",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let active_downloads: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM download_jobs WHERE status = 'downloading'")
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    Ok(Json(HealthResponse {
        status: if database == "ok" { "ok" } else { "degraded" },
        version: env!("CARGO_PKG_VERSION"),
        database,
        uptime_seconds: crate::uptime_seconds(),
        active_sessions,
        active_downloads,
        objects_bytes: dir_size(&state.config.objects_dir).await,
    }))
}

/// 审计日志查询。
#[derive(Debug, Deserialize)]
struct AuditQuery {
    #[serde(default = "default_limit")]
    limit: i64,
}

fn default_limit() -> i64 {
    100
}

async fn audit_logs(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<AuditQuery>,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;

    let limit = query.limit.clamp(1, 1000);

    let rows = sqlx::query_as::<_, (i64, Option<i64>, String, String, String, String)>(
        "SELECT id, user_id, action, target_type, target_id, created_at
         FROM audit_logs ORDER BY id DESC LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.0,
                "user_id": row.1,
                "action": row.2,
                "target_type": row.3,
                "target_id": row.4,
                "created_at": row.5,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "items": items })))
}

/// 存储用量：资源目录大小与文件数。
async fn storage_usage(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    user.require_admin()?;

    let bytes = dir_size(&state.config.objects_dir).await;
    let files: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM resources WHERE status = 'ready'")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

    Ok(Json(serde_json::json!({
        "objects_bytes": bytes,
        "objects_dir": state.config.objects_dir.display().to_string(),
        "ready_resources": files,
    })))
}

/// 递归统计目录大小；失败时返回 0，不影响健康检查。
pub async fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(meta) = entry.metadata().await else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }

    total
}
