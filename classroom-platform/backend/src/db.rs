//! 数据库连接池与迁移。

use crate::config::ResolvedConfig;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::str::FromStr;
use std::time::Duration;

/// 建立 SQLite 连接池并执行迁移。
///
/// 单机部署下启用 WAL 提升并发读性能，并强制开启外键约束。
pub async fn init_pool(config: &ResolvedConfig) -> anyhow::Result<SqlitePool> {
    let url = format!("sqlite://{}", config.database_path.display());

    let mut options = SqliteConnectOptions::from_str(&url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));

    if config.raw.database.wal {
        options = options
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal);
    }

    let pool = SqlitePoolOptions::new()
        .max_connections(config.raw.database.max_connections)
        .acquire_timeout(Duration::from_secs(15))
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}

/// 首次启动时确保存在一个管理员账号。
///
/// 默认口令仅用于初始化，登录后应立即修改。
pub async fn ensure_bootstrap_admin(pool: &SqlitePool) -> anyhow::Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role = 'admin'")
        .fetch_one(pool)
        .await?;

    if count > 0 {
        return Ok(());
    }

    let hash = crate::auth::hash_password("admin")?;
    sqlx::query(
        "INSERT INTO users (username, display_name, password_hash, role, is_active)
         VALUES (?1, ?2, ?3, 'admin', 1)",
    )
    .bind("admin")
    .bind("系统管理员")
    .bind(hash)
    .execute(pool)
    .await?;

    tracing::warn!("已创建初始管理员账号 admin，初始口令 admin，请登录后立即修改");
    Ok(())
}
