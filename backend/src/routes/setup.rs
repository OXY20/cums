//! 首次安装向导接口。
//!
//! 服务首次启动时 `config.toml` 中 `installed = false`，进入安装模式：
//! 仅本模块的接口可用，其余业务接口由 `setup_guard` 拦截。
//! 管理员在向导中创建账号并确认基础配置后，标记 `installed = true`，
//! 服务恢复正常业务。

use crate::auth::hash_password;
use crate::error::{AppError, AppResult};
use crate::models::{SetupInstallRequest, SetupInstallResponse, SetupStatusResponse, SetupSummary};
use crate::state::AppState;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use std::path::PathBuf;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/setup/status", get(status))
        .route("/api/setup/install", post(install))
}

/// 安装状态查询；供前端决定是否跳转安装向导。
async fn status(State(state): State<AppState>) -> Json<SetupStatusResponse> {
    let installed = state.is_installed();
    Json(SetupStatusResponse {
        installed,
        // 未安装时把可修改的基础配置回显给向导，用户在此基础上调整。
        defaults: if installed {
            None
        } else {
            Some(SetupSummary {
                bind: state.config.raw.server.bind.clone(),
                database_path: state.config.raw.database.path.clone(),
                storage_dir: state.config.raw.storage.objects_dir.clone(),
                token_ttl_hours: state.config.raw.auth.token_ttl_hours,
            })
        },
    })
}

/// 执行安装：创建管理员账号、写入基础配置并标记已安装。
async fn install(
    State(state): State<AppState>,
    Json(payload): Json<SetupInstallRequest>,
) -> AppResult<Json<SetupInstallResponse>> {
    // 已安装后不允许再次执行，避免被恶意覆盖管理员账号。
    if state.is_installed() {
        return Err(AppError::Conflict("系统已完成安装".into()));
    }

    let username = payload.username.trim();
    if username.is_empty() {
        return Err(AppError::BadRequest("管理员用户名不能为空".into()));
    }
    if username.len() > 64 {
        return Err(AppError::BadRequest(
            "管理员用户名过长（最多 64 个字符）".into(),
        ));
    }
    if !payload
        .username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err(AppError::BadRequest(
            "管理员用户名只能包含字母、数字、下划线、中划线和点".into(),
        ));
    }
    if payload.password.len() < 8 {
        return Err(AppError::BadRequest("管理员口令至少 8 位".into()));
    }
    if payload.password != payload.password_confirm {
        return Err(AppError::BadRequest("两次输入的口令不一致".into()));
    }

    // 端口：允许只填端口或 host:port 形式。
    let bind = payload.bind.trim().to_string();
    if !bind.is_empty() {
        validate_bind(&bind)?;
    }

    // 数据目录必须是绝对路径或相对根目录的普通相对路径，禁止目录穿越。
    let database_path = payload.database_path.trim().to_string();
    if !database_path.is_empty() {
        validate_relative_path(&database_path, "数据库路径")?;
    }
    let storage_dir = payload.storage_dir.trim().to_string();
    if !storage_dir.is_empty() {
        validate_relative_path(&storage_dir, "资源目录")?;
    }

    let hash = hash_password(&payload.password).map_err(|e| AppError::Internal(e.to_string()))?;

    let display_name = {
        let name = payload.display_name.trim();
        if name.is_empty() {
            "系统管理员".to_string()
        } else {
            name.to_string()
        }
    };

    // 用户名唯一性：避免与已有账号冲突导致管理员无法登录。
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username = ?1")
        .bind(username)
        .fetch_one(&state.db)
        .await?;
    if exists > 0 {
        return Err(AppError::Conflict("该用户名已存在".into()));
    }

    sqlx::query(
        "INSERT INTO users (username, display_name, password_hash, role, is_active)
         VALUES (?1, ?2, ?3, 'admin', 1)",
    )
    .bind(username)
    .bind(&display_name)
    .bind(&hash)
    .execute(&state.db)
    .await?;

    // 写入基础配置并标记已安装。
    {
        let mut config = state.config.as_ref().clone();
        let current_db = config.raw.database.path.clone();
        let current_objects = config.raw.storage.objects_dir.clone();

        if !bind.is_empty() {
            config.raw.server.bind = bind.clone();
        }
        if !database_path.is_empty() {
            config.raw.database.path = database_path.clone();
        }
        if !storage_dir.is_empty() {
            config.raw.storage.objects_dir = storage_dir.clone();
        }
        if payload.token_ttl_hours > 0 {
            config.raw.auth.token_ttl_hours = payload.token_ttl_hours;
        }
        config.raw.installed = true;

        // 变更数据库路径时迁移已有数据，否则重启后会指向空库，
        // 本次安装创建的管理员账号也会随之丢失。
        //
        // AGENT-DECISION: 迁移必须在 `ensure_dirs` 之前完成——后者会先创建
        // 目标数据库文件，导致「目标已存在」检查误判为冲突而无法安装。
        if config.raw.database.path != current_db {
            migrate_database(
                &config.root_dir.join(&current_db),
                &config.root_dir.join(&config.raw.database.path),
            )?;
        }
        if config.raw.storage.objects_dir != current_objects {
            migrate_directory(
                &config.root_dir.join(&current_objects),
                &config.root_dir.join(&config.raw.storage.objects_dir),
            )?;
        }

        // 迁移完成后再确保全部目录存在，避免配置指向不存在的目录。
        config
            .ensure_dirs()
            .map_err(|e| AppError::Internal(format!("创建目录失败：{e}")))?;

        config
            .save()
            .map_err(|e| AppError::Internal(format!("写入配置文件失败：{e}")))?;
    }

    // 配置落盘成功后同步运行时状态：安装完成后立即放行业务接口，
    // 无需重启服务。
    state.mark_installed();

    tracing::info!(username, "安装向导已完成，已创建管理员账号");

    Ok(Json(SetupInstallResponse {
        ok: true,
        username: username.to_string(),
        display_name,
        message: "安装完成，请使用管理员账号登录".into(),
    }))
}

/// 校验监听地址格式；只做格式检查，实际绑定由启动阶段负责。
fn validate_bind(bind: &str) -> AppResult<()> {
    use std::net::SocketAddr;

    // 允许只写端口（如 "8080"），补全为 0.0.0.0:8080。
    if bind.chars().all(|c| c.is_ascii_digit()) {
        let port: u16 = bind
            .parse()
            .map_err(|_| AppError::BadRequest("端口号无效".into()))?;
        if port == 0 {
            return Err(AppError::BadRequest("端口号必须大于 0".into()));
        }
        return Ok(());
    }

    bind.parse::<SocketAddr>()
        .map(|_| ())
        .map_err(|e| AppError::BadRequest(format!("监听地址无效：{e}")))
}

/// 校验目录路径：必须是相对路径且不含目录穿越片段。
fn validate_relative_path(path: &str, label: &str) -> AppResult<()> {
    if path.starts_with('/') || path.starts_with('\\') {
        return Err(AppError::BadRequest(format!(
            "{label}必须是相对于数据根目录的路径"
        )));
    }
    if PathBuf::from(path).is_absolute() {
        return Err(AppError::BadRequest(format!(
            "{label}必须是相对于数据根目录的路径"
        )));
    }
    if path.split(['/', '\\']).any(|part| part == "..") {
        return Err(AppError::BadRequest(format!("{label}不能包含上级目录跳转")));
    }
    Ok(())
}

/// 迁移 SQLite 数据库到新路径。
///
/// 源库不存在时直接返回（首次安装本就没有历史数据）。
/// 目标已存在时拒绝覆盖，避免静默丢失数据。
fn migrate_database(source: &std::path::Path, target: &std::path::Path) -> AppResult<()> {
    if !source.exists() {
        return Ok(());
    }
    if target.exists() {
        return Err(AppError::Conflict(format!(
            "目标数据库已存在：{}",
            target.display()
        )));
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Internal(format!("创建目录失败：{e}")))?;
    }

    // 迁移前先归并 WAL，保证主库文件包含全部已提交数据。
    checkpoint_database(source);

    std::fs::copy(source, target)
        .map_err(|e| AppError::Internal(format!("迁移数据库失败：{e}")))?;

    // WAL 与 SHM 属于旧路径，复制后需一并清理，避免残留文件被误读。
    let wal_path = PathBuf::from(format!("{}-wal", source.to_string_lossy()));
    let shm_path = PathBuf::from(format!("{}-shm", source.to_string_lossy()));
    let _ = std::fs::remove_file(wal_path);
    let _ = std::fs::remove_file(shm_path);

    tracing::info!(from = %source.display(), to = %target.display(), "数据库已迁移");
    Ok(())
}

/// 迁移资源目录到新位置。
fn migrate_directory(source: &std::path::Path, target: &std::path::Path) -> AppResult<()> {
    if !source.exists() {
        return Ok(());
    }
    if target.exists() {
        // 目标目录已存在时逐项拷贝，不删除目标中已有内容。
        copy_directory(source, target)?;
    } else {
        std::fs::create_dir_all(target)
            .map_err(|e| AppError::Internal(format!("创建目录失败：{e}")))?;
        copy_directory(source, target)?;
    }
    tracing::info!(from = %source.display(), to = %target.display(), "资源目录已迁移");
    Ok(())
}

/// 递归拷贝目录内容。
fn copy_directory(source: &std::path::Path, target: &std::path::Path) -> AppResult<()> {
    let entries =
        std::fs::read_dir(source).map_err(|e| AppError::Internal(format!("读取目录失败：{e}")))?;

    for entry in entries {
        let entry = entry.map_err(|e| AppError::Internal(format!("读取目录项失败：{e}")))?;
        let src = entry.path();
        let dst = target.join(entry.file_name());

        if src.is_dir() {
            std::fs::create_dir_all(&dst)
                .map_err(|e| AppError::Internal(format!("创建目录失败：{e}")))?;
            copy_directory(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)
                .map_err(|e| AppError::Internal(format!("复制文件失败：{}", e)))?;
        }
    }
    Ok(())
}

/// 将 SQLite 的 WAL 内容归并到主库文件。
///
/// AGENT-DECISION: 这里用独立的线程执行归并，而不是在异步运行时里
/// `block_on`（在已有运行时线程上调用会 panic）。
fn checkpoint_database(path: &std::path::Path) {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    let path = path.to_path_buf();
    let handle = std::thread::spawn(move || {
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(false);

        let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return;
        };

        rt.block_on(async {
            if let Ok(pool) = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options)
                .await
            {
                let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                    .execute(&pool)
                    .await;
                pool.close().await;
            }
        });
    });

    // 归并失败不阻断安装：主库仍可用，只是可能遗漏最近的写入。
    let _ = handle.join();
}
