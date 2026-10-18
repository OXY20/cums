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

use crate::auth::{verify_token, Claims, Role};
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::Router;

/// 组装全部 API 路由。
pub fn api_router() -> Router<AppState> {
    Router::new()
        .merge(auth::routes())
        .merge(classes::routes())
        .merge(courses::routes())
        .merge(lessons::routes())
        .merge(blocks::routes())
        .merge(sessions::routes())
        .merge(resources::routes())
        .merge(files::routes())
        .merge(events::routes())
        .merge(meta::routes())
        .merge(admin::routes())
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
