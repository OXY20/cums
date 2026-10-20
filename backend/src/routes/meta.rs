//! 公开元信息接口：无需登录即可获取服务版本。

use crate::state::AppState;
use axum::routing::get;
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/version", get(version))
}

/// 服务名称与版本；供前端页脚展示。
async fn version() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "name": "机房教学资源平台",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}
