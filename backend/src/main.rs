//! 机房教学资源平台 - 后端服务入口。

mod auth;
mod config;
mod db;
mod error;
mod models;
mod richtext;
mod routes;
mod state;

use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

/// 进程启动时刻，用于健康检查中的运行时长。
static STARTED_AT: OnceLock<Instant> = OnceLock::new();

/// 服务已运行秒数。
pub fn uptime_seconds() -> i64 {
    STARTED_AT
        .get()
        .map(|start| start.elapsed().as_secs() as i64)
        .unwrap_or(0)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = STARTED_AT.set(Instant::now());

    // 部署时从可执行文件所在目录读取配置；开发时可用环境变量覆盖。
    let root_dir = std::env::var("CLASSROOM_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| std::path::PathBuf::from("."))
        });

    let config = Arc::new(config::ResolvedConfig::load(&root_dir)?);

    init_logging(&config)?;
    tracing::info!(root = %config.root_dir.display(), "机房教学资源平台后端启动中");
    tracing::info!(database = %config.database_path.display(), "数据库位置");
    tracing::info!(objects = %config.objects_dir.display(), "资源目录");

    let pool = db::init_pool(&config).await?;

    let state = state::AppState::new(pool, config.clone());

    // 后台清理：上传中途失败会在 staging 留下既无文件又无引用的占位记录，
    // 进程崩溃时也会残留孤立文件。启动后清理一次，之后定期清理。
    spawn_staging_cleanup(state.clone());

    let app = build_router(&state);
    let listener = bind_with_fallback(&config.raw.server.bind).await?;
    let addr = listener.local_addr()?;

    tracing::info!("服务已就绪：http://{addr}");

    // 未完成安装时提示管理员访问安装向导。
    if !config.raw.installed {
        tracing::info!("尚未完成首次安装，请访问 http://{addr}/setup 运行安装向导");
    }

    // 挂载连接信息：作业提交需要记录真实来源 IP，客户端无法自行指定。
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    tracing::info!("服务已停止");
    Ok(())
}

/// 后台清理 staging 残留。
///
/// 两类残留会随时间累积：
/// 1. 数据库里 `status = 'staging'` 但既没有文件、也没有被任何提交/课时引用的占位记录
///    （上传中途失败，或处理器在文件落盘后才发现参数不合法）；
/// 2. `storage/staging` 下没有任何数据库行指向的文件（进程崩溃在 written 之后、
///    事务提交之前）。
///
/// 只有「超过保留期」的记录才会被清理：正在上传中的请求也在 staging 里，
/// 立即清理会把正常上传的文件删掉。
fn spawn_staging_cleanup(state: state::AppState) {
    /// 残留保留期：一次上传不可能持续这么久，超过即可判定为废弃。
    const STALE_AFTER_SECS: i64 = 6 * 60 * 60;
    /// 清理间隔。
    const INTERVAL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

    tokio::spawn(async move {
        // 启动时先等一会，避免和刚启动的并发请求抢 IO
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;

        loop {
            match cleanup_stale_staging(&state, STALE_AFTER_SECS).await {
                Ok(0) => {}
                Ok(count) => tracing::info!(count, "已清理废弃的暂存资源"),
                Err(err) => tracing::warn!(error = %err, "清理暂存资源失败"),
            }

            tokio::time::sleep(INTERVAL).await;
        }
    });
}

/// 执行一次清理，返回清理掉的记录数。
async fn cleanup_stale_staging(
    state: &state::AppState,
    stale_after_secs: i64,
) -> anyhow::Result<usize> {
    let rows = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT id, name, storage_key FROM resources
         WHERE status = 'staging'
           AND created_at < datetime('now', ?1)
           AND NOT EXISTS (
               SELECT 1 FROM homework_submission_files f WHERE f.resource_id = resources.id
           )
           AND NOT EXISTS (
               SELECT 1 FROM lesson_resources l WHERE l.resource_id = resources.id
           )
         LIMIT 500",
    )
    .bind(format!("-{stale_after_secs} seconds"))
    .fetch_all(&state.db)
    .await?;

    let mut removed = 0usize;
    for (id, name, storage_key) in rows {
        let resource = crate::models::ResourceRow {
            id,
            name,
            storage_key,
            size_bytes: 0,
            sha256: String::new(),
            mime_type: String::new(),
            version: 0,
            status: "staging".to_string(),
            created_at: String::new(),
        };

        crate::routes::resources::purge_resource(state, &resource).await;
        removed += 1;
    }

    Ok(removed)
}

/// 组装路由：API + 可选的前端静态资源。
fn build_router(state: &state::AppState) -> axum::Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let mut app = routes::api_router(state.clone())
        .layer(TraceLayer::new_for_http())
        .layer(cors);

    // 前端构建产物存在时一并托管，学生只需访问一个地址。
    let static_dir = state
        .config
        .root_dir
        .join(&state.config.raw.server.static_dir);
    if !state.config.raw.server.static_dir.is_empty() && static_dir.exists() {
        tracing::info!(dir = %static_dir.display(), "托管前端静态资源");
        // 使用 fallback 而非 not_found_service：后者会强制 404 状态码，
        // 而 SPA 的前端路由（如 /student/courses/1）必须返回 200 才能正常渲染。
        app = app.fallback_service(
            ServeDir::new(&static_dir).fallback(ServeFile::new(static_dir.join("index.html"))),
        );
    }

    app
}

/// 绑定监听端口；被占用时自动尝试后续端口。
///
/// 教师机上常有其他服务，端口冲突不应导致启动失败。
async fn bind_with_fallback(bind: &str) -> anyhow::Result<tokio::net::TcpListener> {
    let base: SocketAddr = bind
        .parse()
        .map_err(|e| anyhow::anyhow!("监听地址无效 {bind}：{e}"))?;

    for offset in 0..20u16 {
        let candidate = SocketAddr::new(base.ip(), base.port().saturating_add(offset));
        match tokio::net::TcpListener::bind(candidate).await {
            Ok(listener) => {
                if offset > 0 {
                    tracing::warn!(%candidate, original = %base, "端口被占用，已回退到后续端口");
                }
                return Ok(listener);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                tracing::warn!(%candidate, "端口被占用，尝试下一个");
            }
            Err(err) => return Err(err.into()),
        }
    }

    Err(anyhow::anyhow!("连续 20 个端口均被占用，无法启动：{bind}"))
}

/// 初始化日志：同时输出到控制台与 `app/logs/server.log`。
fn init_logging(config: &config::ResolvedConfig) -> anyhow::Result<()> {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=warn,sqlx=warn"));

    let file_appender = tracing_appender::rolling::daily(&config.logs_dir, "server.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    // 守卫必须在进程生命周期内保持存活，否则日志会丢失。
    std::mem::forget(guard);

    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(non_blocking),
        )
        .init();

    Ok(())
}

/// 等待 Ctrl+C 或 SIGTERM，实现优雅退出。
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("无法注册 Ctrl+C 处理器");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("无法注册 SIGTERM 处理器")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!("收到中断信号，正在停止服务"),
        _ = terminate => tracing::info!("收到终止信号，正在停止服务"),
    }
}
