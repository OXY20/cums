//! 认证相关接口。

use crate::auth::{hash_password, issue_token, verify_password, Role};
use crate::error::{AppError, AppResult};
use crate::models::{
    ChangePasswordRequest, LoginRequest, LoginResponse, UserInfo, UserRow,
};
use crate::routes::AuthUser;
use crate::state::AppState;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/login", post(login))
        .route("/api/auth/me", get(me))
        .route("/api/auth/password", post(change_password))
}

/// 教师/管理员登录。
async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> AppResult<Json<LoginResponse>> {
    if payload.username.trim().is_empty() || payload.password.is_empty() {
        return Err(AppError::BadRequest("用户名和口令不能为空".into()));
    }

    let user = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, display_name, password_hash, role, is_active
         FROM users WHERE username = ?1",
    )
    .bind(payload.username.trim())
    .fetch_optional(&state.db)
    .await?;

    // 用户不存在与口令错误返回同一错误，避免账号枚举。
    let Some(user) = user else {
        return Err(AppError::Unauthorized);
    };

    if user.is_active == 0 || !verify_password(&payload.password, &user.password_hash) {
        return Err(AppError::Unauthorized);
    }

    let role = Role::parse(&user.role)?;
    let token = issue_token(&state.config, user.id, &user.username, role)?;

    audit(&state, Some(user.id), "auth.login", "user", &user.id.to_string()).await;

    Ok(Json(LoginResponse {
        token,
        expires_in: state.config.raw.auth.token_ttl_hours * 3600,
        user: UserInfo {
            id: user.id,
            username: user.username,
            display_name: user.display_name,
            role: user.role,
        },
    }))
}

/// 返回当前登录用户。
async fn me(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<UserInfo>> {
    let row = sqlx::query_as::<_, (i64, String, String, String)>(
        "SELECT id, username, display_name, role FROM users WHERE id = ?1 AND is_active = 1",
    )
    .bind(user.id())
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::Unauthorized)?;

    Ok(Json(UserInfo {
        id: row.0,
        username: row.1,
        display_name: row.2,
        role: row.3,
    }))
}

/// 修改当前用户口令。
async fn change_password(
    State(state): State<AppState>,
    user: AuthUser,
    Json(payload): Json<ChangePasswordRequest>,
) -> AppResult<Json<serde_json::Value>> {
    if payload.new_password.len() < 6 {
        return Err(AppError::BadRequest("新口令至少 6 位".into()));
    }

    let current: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?1")
        .bind(user.id())
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::Unauthorized)?;

    if !verify_password(&payload.old_password, &current) {
        return Err(AppError::BadRequest("原口令不正确".into()));
    }

    let new_hash = hash_password(&payload.new_password)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    sqlx::query("UPDATE users SET password_hash = ?1, updated_at = datetime('now') WHERE id = ?2")
        .bind(new_hash)
        .bind(user.id())
        .execute(&state.db)
        .await?;

    audit(&state, Some(user.id()), "auth.change_password", "user", &user.id().to_string()).await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 写入审计日志；失败不影响主流程。
pub async fn audit(
    state: &AppState,
    user_id: Option<i64>,
    action: &str,
    target_type: &str,
    target_id: &str,
) {
    let result = sqlx::query(
        "INSERT INTO audit_logs (user_id, action, target_type, target_id) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(user_id)
    .bind(action)
    .bind(target_type)
    .bind(target_id)
    .execute(&state.db)
    .await;

    if let Err(err) = result {
        tracing::warn!(error = %err, action, "审计日志写入失败");
    }
}
