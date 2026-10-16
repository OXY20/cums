//! SSE 实时事件流。
//!
//! 学生端订阅后，教师开始/暂停/结束课堂时即时收到通知；
//! 断线时前端应重连并定期刷新，避免长期展示旧内容。

use crate::state::AppState;
use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::Router;
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/events", get(sse_events))
}

/// 事件流端点。
async fn sse_events(
    State(state): State<AppState>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.subscribe();

    let stream = BroadcastStream::new(receiver).filter_map(|result| match result {
        Ok(event) => {
            let payload = serde_json::json!({
                "session_id": event.session_id,
                "event_type": event.event_type,
                "payload": event.payload,
                "created_at": event.created_at,
            });
            Some(Ok(Event::default()
                .event(event.event_type)
                .data(payload.to_string())))
        }
        // 订阅者滞后时跳过该批次；前端定期刷新兜底。
        Err(_) => None,
    });

    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
