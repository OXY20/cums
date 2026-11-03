//! 应用共享状态与课堂事件总线。

use crate::config::ResolvedConfig;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
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
    /// 是否已完成首次安装。
    ///
    /// AGENT-DECISION: 单独用原子变量而不是直接改 `config.raw.installed`，
    /// 是因为 `config` 被 `Arc` 共享且在多处只读引用；安装完成后需要立即
    /// 生效（无需重启服务），因此用可原子更新的标志承载运行时状态，
    /// 配置文件里的 `installed` 仅作为重启后的持久化来源。
    installed: Arc<AtomicBool>,
    /// 广播通道：容量有限，慢订阅者会收到 Lagged 并应重新拉取全量状态。
    pub events: broadcast::Sender<SessionEvent>,
    /// 作业提交的固定窗口限流器，按来源地址计数。
    submit_guard: Arc<Mutex<SubmitRateLimiter>>,
}

impl AppState {
    pub fn new(db: SqlitePool, config: Arc<ResolvedConfig>) -> Self {
        let (events, _rx) = broadcast::channel(512);
        Self {
            db,
            installed: Arc::new(AtomicBool::new(config.raw.installed)),
            config,
            events,
            submit_guard: Arc::new(Mutex::new(SubmitRateLimiter::default())),
        }
    }

    /// 是否已完成首次安装。
    pub fn is_installed(&self) -> bool {
        self.installed.load(Ordering::Relaxed)
    }

    /// 标记安装完成；安装向导写入配置成功后调用。
    pub fn mark_installed(&self) {
        self.installed.store(true, Ordering::Relaxed);
    }

    /// 发布事件；没有订阅者时静默忽略。
    pub fn publish(&self, event: SessionEvent) {
        let _ = self.events.send(event);
    }

    /// 订阅课堂事件流。
    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }

    /// 尝试为某个来源地址占用一次提交配额。
    ///
    /// 返回 `None` 表示放行，`Some(秒数)` 表示被限流以及还需等待多久。
    /// 采用固定窗口而不是滑动窗口：机房场景下每个 IP 只会提交个位数次，
    /// 固定窗口足够挡住误触与脚本刷库，且不需要保留逐次时间戳。
    pub fn try_acquire_submission_slot(&self, client_key: &str) -> Option<u64> {
        let limit = self.config.raw.limits.submission_rate_limit;
        if limit == 0 {
            return None;
        }

        let window = Duration::from_secs(self.config.raw.limits.submission_rate_window_secs.max(1));

        // 限流器是纯内存结构，中毒后继续用旧值比让整个提交接口 500 更合理
        let mut guard = match self.submit_guard.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        guard.acquire(client_key, limit, window)
    }
}

/// 按来源地址计数的固定窗口限流器。
///
/// 只在内存里保存「当前窗口起点」与计数，进程重启后清零——
/// 限流是保护措施而不是审计凭据，不需要持久化。
#[derive(Default)]
struct SubmitRateLimiter {
    /// 每个来源地址对应 (窗口起点, 本窗口内已提交次数)
    slots: HashMap<String, (Instant, u32)>,
}

impl SubmitRateLimiter {
    /// 占用一次配额；返回 `None` 表示放行，`Some(秒)` 表示还需等待多久。
    fn acquire(&mut self, client_key: &str, limit: u32, window: Duration) -> Option<u64> {
        let now = Instant::now();

        // 表过大时先清掉过期窗口，避免长期运行后无限增长。
        // 阈值远大于一间机房的机器数，正常使用不会触发。
        if self.slots.len() > 4096 {
            self.slots
                .retain(|_, (started, _)| now.duration_since(*started) < window);
        }

        let slot = self.slots.entry(client_key.to_string()).or_insert((now, 0));

        // 窗口已过期则重新开窗计数
        if now.duration_since(slot.0) >= window {
            *slot = (now, 0);
        }

        if slot.1 >= limit {
            let left = window.saturating_sub(now.duration_since(slot.0));
            return Some(left.as_secs().max(1));
        }

        slot.1 += 1;
        None
    }
}
