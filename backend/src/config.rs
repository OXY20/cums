//! 应用配置：默认值、文件加载与保存、目录初始化。
//!
//! 部署目录结构依据《机房教学资源平台建设方案》6.3 节：
//! ```text
//! ClassroomPlatform/
//! ├─ app/{config,logs}
//! ├─ data/classroom.db
//! ├─ storage/{objects,staging,manifests}
//! └─ backups/
//! ```

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 服务器监听配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /// 监听地址，例如 `0.0.0.0:8080`。
    pub bind: String,
    /// 前端静态资源目录；为空时仅提供 API。
    pub static_dir: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: "0.0.0.0:8080".to_string(),
            // 前端构建产物默认输出到 app/web，由后端单端口托管。
            static_dir: "app/web".to_string(),
        }
    }
}

/// 数据库配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseConfig {
    /// SQLite 文件路径，相对于根目录。
    pub path: String,
    /// 连接池上限。
    pub max_connections: u32,
    /// 是否启用 WAL 与外键约束（建议始终开启）。
    pub wal: bool,
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            path: "data/classroom.db".to_string(),
            max_connections: 16,
            wal: true,
        }
    }
}

/// 资源存储配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    /// 已校验并正式发布的资源文件目录。
    pub objects_dir: String,
    /// 上传/导入中的临时目录；校验通过后才移入 objects。
    pub staging_dir: String,
    /// 资源包清单目录。
    pub manifests_dir: String,
    /// 单文件大小上限（字节），默认 20 GiB。
    pub max_file_bytes: u64,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            objects_dir: "storage/objects".to_string(),
            staging_dir: "storage/staging".to_string(),
            manifests_dir: "storage/manifests".to_string(),
            max_file_bytes: 20 * 1024 * 1024 * 1024,
        }
    }
}

/// 认证与会话配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    /// JWT 签名密钥；首次启动时自动生成并写回配置文件。
    pub jwt_secret: String,
    /// 令牌有效期（小时）。
    pub token_ttl_hours: i64,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            jwt_secret: String::new(),
            token_ttl_hours: 12,
        }
    }
}

/// 并发与限流配置：避免影响教师机正常教学。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LimitsConfig {
    /// 同时进行的下载数上限。
    pub max_concurrent_downloads: u32,
    /// 每客户端下载限速（KiB/s），0 表示不限速。
    pub per_client_rate_kib: u32,
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            max_concurrent_downloads: 64,
            per_client_rate_kib: 0,
        }
    }
}

/// 完整应用配置。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub database: DatabaseConfig,
    #[serde(default)]
    pub storage: StorageConfig,
    #[serde(default)]
    pub auth: AuthConfig,
    #[serde(default)]
    pub limits: LimitsConfig,
}

/// 已解析的运行时配置：持有根目录与各绝对路径。
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub raw: AppConfig,
    pub root_dir: PathBuf,
    pub config_path: PathBuf,
    pub database_path: PathBuf,
    pub objects_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub manifests_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub backups_dir: PathBuf,
}

impl ResolvedConfig {
    /// 从根目录加载配置；配置文件不存在时写入默认配置。
    pub fn load(root_dir: impl AsRef<Path>) -> anyhow::Result<Self> {
        let root_dir = root_dir.as_ref().to_path_buf();
        let config_path = root_dir.join("app").join("config").join("config.toml");

        let mut raw = if config_path.exists() {
            let text = std::fs::read_to_string(&config_path)?;
            toml::from_str::<AppConfig>(&text)?
        } else {
            AppConfig::default()
        };

        // 密钥缺失时生成，保证首次启动即可用。
        if raw.auth.jwt_secret.trim().is_empty() {
            raw.auth.jwt_secret = generate_secret();
        }

        let resolved = Self {
            database_path: root_dir.join(&raw.database.path),
            objects_dir: root_dir.join(&raw.storage.objects_dir),
            staging_dir: root_dir.join(&raw.storage.staging_dir),
            manifests_dir: root_dir.join(&raw.storage.manifests_dir),
            logs_dir: root_dir.join("app").join("logs"),
            backups_dir: root_dir.join("backups"),
            root_dir,
            config_path,
            raw,
        };

        resolved.ensure_dirs()?;
        resolved.save()?;
        Ok(resolved)
    }

    /// 创建全部必需目录。
    pub fn ensure_dirs(&self) -> anyhow::Result<()> {
        for dir in [
            &self.objects_dir,
            &self.staging_dir,
            &self.manifests_dir,
            &self.logs_dir,
            &self.backups_dir,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        if let Some(parent) = self.database_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    /// 将当前配置写回配置文件。
    pub fn save(&self) -> anyhow::Result<()> {
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = toml::to_string_pretty(&self.raw)?;
        std::fs::write(&self.config_path, text)?;
        Ok(())
    }
}

/// 生成 32 字节随机密钥的十六进制表示。
fn generate_secret() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}
