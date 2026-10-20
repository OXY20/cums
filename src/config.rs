use crate::models::{Config, OperationLog};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// 操作日志最大条数
const MAX_OP_LOGS: usize = 500;

/// 应用状态
pub struct AppState {
    pub config: RwLock<Config>,
    pub base_dir: PathBuf,
    pub upload_dir: PathBuf,
    pub admin_tokens: RwLock<HashMap<String, chrono::DateTime<chrono::Local>>>,
    pub student_tokens: RwLock<HashMap<String, (String, chrono::DateTime<chrono::Local>)>>,
    pub op_logs: RwLock<Vec<OperationLog>>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let base_dir = get_base_dir();
        let upload_dir = base_dir.join("uploads");

        // 初始化上传目录
        if let Err(e) = init_upload_dirs(&base_dir, &config) {
            log::error!("初始化上传目录失败: {}", e);
        }

        Self {
            config: RwLock::new(config),
            base_dir,
            upload_dir,
            admin_tokens: RwLock::new(HashMap::new()),
            student_tokens: RwLock::new(HashMap::new()),
            op_logs: RwLock::new(Vec::new()),
        }
    }

    /// 验证管理员令牌
    pub fn validate_admin_token(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        let tokens = self.admin_tokens.read().unwrap();
        if let Some(expiry) = tokens.get(token) {
            &chrono::Local::now() < expiry
        } else {
            false
        }
    }

    /// 清理过期令牌
    pub fn clean_expired_tokens(&self) {
        let mut tokens = self.admin_tokens.write().unwrap();
        let now = chrono::Local::now();
        tokens.retain(|_, expiry| &now < expiry);

        let mut student_tokens = self.student_tokens.write().unwrap();
        student_tokens.retain(|_, (_, expiry)| &now < expiry);
    }

    /// 验证学生令牌并返回学生编号。
    pub fn validate_student_token(&self, token: &str) -> Option<String> {
        if token.is_empty() {
            return None;
        }
        let tokens = self.student_tokens.read().unwrap();
        tokens.get(token).and_then(|(student_id, expiry)| {
            if chrono::Local::now() < *expiry {
                Some(student_id.clone())
            } else {
                None
            }
        })
    }

    /// 记录操作日志
    pub fn log_operation(&self, action: &str, detail: &str) {
        let entry = OperationLog {
            timestamp: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            action: action.to_string(),
            detail: detail.to_string(),
        };
        let mut logs = self.op_logs.write().unwrap();
        logs.push(entry);
        // 保留最近的 MAX_OP_LOGS 条
        if logs.len() > MAX_OP_LOGS {
            let drain_count = logs.len() - MAX_OP_LOGS;
            logs.drain(0..drain_count);
        }
    }

    /// 获取操作日志（最近 count 条）
    pub fn get_op_logs(&self, count: usize) -> Vec<OperationLog> {
        let logs = self.op_logs.read().unwrap();
        let start = if logs.len() > count {
            logs.len() - count
        } else {
            0
        };
        logs[start..].to_vec()
    }
}

/// 获取程序所在目录
fn get_base_dir() -> PathBuf {
    // 如果当前目录有 Cargo.toml，说明是开发环境
    if Path::new("Cargo.toml").exists() {
        return PathBuf::from(".");
    }
    // 生产环境：使用可执行文件所在目录
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            return parent.to_path_buf();
        }
    }
    PathBuf::from(".")
}

/// 初始化上传目录结构
fn init_upload_dirs(base_dir: &Path, config: &Config) -> std::io::Result<()> {
    let upload_dir = base_dir.join("uploads");
    std::fs::create_dir_all(&upload_dir)?;

    for (subject, sub_config) in &config.subjects {
        for class in &sub_config.classes {
            for hw in &sub_config.homeworks {
                let dir = upload_dir.join(subject).join(class).join(&hw.name);
                std::fs::create_dir_all(&dir)?;
            }
        }
    }

    // 确保其他必要目录存在
    std::fs::create_dir_all(base_dir.join("logs"))?;
    std::fs::create_dir_all(base_dir.join("templates"))?;
    std::fs::create_dir_all(base_dir.join("lessons"))?;
    std::fs::create_dir_all(base_dir.join("lesson_media"))?;

    Ok(())
}

/// 加载配置文件
pub fn load_config() -> Result<Config, String> {
    let base_dir = get_base_dir();
    let config_path = base_dir.join("config.json");

    let data = std::fs::read_to_string(&config_path).map_err(|_| {
        format!(
            "配置文件不存在 {}\n请确认config.json与程序在同一目录",
            config_path.display()
        )
    })?;

    let config: Config =
        serde_json::from_str(&data).map_err(|e| format!("解析配置文件失败: {}", e))?;

    if config.version.is_empty() {
        return Err("配置文件缺少版本号(version)".to_string());
    }

    Ok(config)
}

/// 保存配置到文件
pub fn save_config(config: &Config, base_dir: &Path) -> Result<(), String> {
    let config_path = base_dir.join("config.json");
    let data =
        serde_json::to_string_pretty(config).map_err(|e| format!("序列化配置失败: {}", e))?;

    std::fs::write(&config_path, data).map_err(|e| format!("写入配置文件失败: {}", e))?;

    Ok(())
}
