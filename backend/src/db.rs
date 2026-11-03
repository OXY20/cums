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
