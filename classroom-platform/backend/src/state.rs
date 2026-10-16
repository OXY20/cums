//! 应用共享状态与课堂事件总线。

use crate::config::ResolvedConfig;
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::broadcast;

/// 课堂事件：写入 `session_events` 后广播给 SSE 订阅者。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionEvent {
    /// 关联课堂场次；为 `None` 时表示全局事件。
    pub session_id: Option<i64>,
    /// 事件类型，例如 `session.started`、`session.ended`。
    pub event_type: String,
    /// 事件负载。
    pub payload: serde_json::Value,
    /// 事件产生时间。
    pub created_at: String,
}

/// 全局应用状态。
#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Arc<ResolvedConfig>,
    /// 广播通道：容量有限，慢订阅者会收到 Lagged 并应重新拉取全量状态。
    pub events: broadcast::Sender<SessionEvent>,
}

impl AppState {
    pub fn new(db: SqlitePool, config: Arc<ResolvedConfig>) -> Self {
        let (events, _rx) = broadcast::channel(512);
        Self {
            db,
            config,
            events,
        }
    }

    /// 发布事件；没有订阅者时静默忽略。
    pub fn publish(&self, event: SessionEvent) {
        let _ = self.events.send(event);
    }

    /// 订阅课堂事件流。
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }
}
