use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 系统配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub version: String,
    pub server_addr: String,
    pub admin_enabled: bool,
    pub admin_password: String,
    pub subjects: HashMap<String, SubjectConfig>,
}

/// 科目配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubjectConfig {
    pub classes: Vec<String>,
    /// 支持字符串数组或对象数组（使用 serde 自定义反序列化）
    #[serde(deserialize_with = "deserialize_homeworks")]
    pub homeworks: Vec<HomeworkConfig>,
}

/// 作业配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeworkConfig {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub templates: Option<Vec<String>>,
}

/// 自定义反序列化：支持字符串数组和对象数组混合格式
fn deserialize_homeworks<'de, D>(deserializer: D) -> Result<Vec<HomeworkConfig>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, Visitor};

    #[derive(Debug)]
    struct HomeworksVisitor;

    impl<'de> Visitor<'de> for HomeworksVisitor {
        type Value = Vec<HomeworkConfig>;

        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("an array of strings or HomeworkConfig objects")
        }

        fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
        where
            A: de::SeqAccess<'de>,
        {
            let mut result = Vec::new();
            while let Some(value) = seq.next_element::<serde_json::Value>()? {
                match value {
                    serde_json::Value::String(s) => {
                        result.push(HomeworkConfig {
                            name: s,
                            description: None,
                            templates: None,
                        });
                    }
                    serde_json::Value::Object(_) => {
                        let hw: HomeworkConfig =
                            serde_json::from_value(value).map_err(de::Error::custom)?;
                        result.push(hw);
                    }
                    _ => {
                        return Err(de::Error::custom("unexpected homework item type"));
                    }
                }
            }
            Ok(result)
        }
    }

    deserializer.deserialize_seq(HomeworksVisitor)
}

/// 登录请求
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub class: String,
    pub student_id: String,
    pub student_name: String,
}

/// 通用 API 响应
#[derive(Debug, Serialize)]
pub struct ApiResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ApiResponse {
    pub fn ok(data: serde_json::Value) -> Self {
        Self {
            success: true,
            message: None,
            data: Some(data),
        }
    }

    pub fn error(msg: &str) -> Self {
        Self {
            success: false,
            message: Some(msg.to_string()),
            data: None,
        }
    }

    pub fn with_message(msg: &str, data: serde_json::Value) -> Self {
        Self {
            success: true,
            message: Some(msg.to_string()),
            data: Some(data),
        }
    }
}

/// 上传响应
#[derive(Debug, Serialize)]
pub struct UploadResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

/// 版本响应
#[derive(Debug, Serialize)]
pub struct VersionResponse {
    pub success: bool,
    pub version: String,
}

/// 管理员登录请求
#[derive(Debug, Deserialize)]
pub struct AdminLoginRequest {
    pub password: String,
}

/// 管理员登录响应
#[derive(Debug, Serialize)]
pub struct AdminLoginResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/// 管理员配置更新请求
#[derive(Debug, Deserialize)]
pub struct AdminConfigRequest {
    pub subjects: HashMap<String, SubjectConfig>,
}

/// 模板删除请求
#[derive(Debug, Deserialize)]
pub struct TemplateDeleteRequest {
    pub path: String,
}

// ==================== 新增：管理后台 v2 数据结构 ====================

/// 文件信息
#[derive(Debug, Serialize)]
pub struct FileInfo {
    pub name: String,
    pub size: u64,
    pub modified: String,
    pub path: String,
}

/// 文件列表请求（查询参数）
#[derive(Debug, Deserialize)]
pub struct FileListQuery {
    pub subject: Option<String>,
    pub class: Option<String>,
    pub homework: Option<String>,
}

/// 文件删除请求
#[derive(Debug, Deserialize)]
pub struct FileDeleteRequest {
    pub path: String,
}

/// 统计数据
#[derive(Debug, Serialize)]
pub struct DashboardStats {
    pub total_files: usize,
    pub total_size: u64,
    pub total_subjects: usize,
    pub total_classes: usize,
    pub total_homeworks: usize,
    pub subject_stats: Vec<SubjectStat>,
    pub recent_uploads: Vec<RecentUpload>,
}

/// 科目统计
#[derive(Debug, Serialize)]
pub struct SubjectStat {
    pub name: String,
    pub file_count: usize,
    pub total_size: u64,
    pub class_count: usize,
    pub homework_count: usize,
}

/// 最近上传记录
#[derive(Debug, Serialize)]
pub struct RecentUpload {
    pub filename: String,
    pub path: String,
    pub size: u64,
    pub modified: String,
}

/// 作业提交情况
#[derive(Debug, Serialize)]
pub struct SubmissionStatus {
    pub homework_name: String,
    pub subject: String,
    pub class: String,
    pub submitted: Vec<String>,      // 已提交的文件名（含学号姓名）
    pub not_submitted: Vec<String>,  // 未提交提示
}

/// 密码修改请求
#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    pub old_password: String,
    pub new_password: String,
}

/// 操作日志条目
#[derive(Debug, Serialize, Clone)]
pub struct OperationLog {
    pub timestamp: String,
    pub action: String,
    pub detail: String,
}