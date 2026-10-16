//! 统一错误类型与 API 错误响应格式。
//!
//! 所有接口失败时返回 `{ "error": { "code": "...", "message": "..." } }`。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// 应用错误。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("请求参数无效：{0}")]
    BadRequest(String),

    #[error("未认证或令牌无效")]
    Unauthorized,

    #[error("没有权限执行该操作")]
    Forbidden,

    #[error("资源不存在：{0}")]
    NotFound(String),

    #[error("状态冲突：{0}")]
    Conflict(String),

    #[error("请求范围无效")]
    RangeNotSatisfiable,

    #[error("数据库错误：{0}")]
    Database(#[from] sqlx::Error),

    #[error("文件系统错误：{0}")]
    Io(#[from] std::io::Error),

    #[error("内部错误：{0}")]
    Internal(String),
}

impl AppError {
    /// 稳定的机器可读错误码。
    pub fn code(&self) -> &'static str {
        match self {
            AppError::BadRequest(_) => "bad_request",
            AppError::Unauthorized => "unauthorized",
            AppError::Forbidden => "forbidden",
            AppError::NotFound(_) => "not_found",
            AppError::Conflict(_) => "conflict",
            AppError::RangeNotSatisfiable => "range_not_satisfiable",
            AppError::Database(_) => "database_error",
            AppError::Io(_) => "io_error",
            AppError::Internal(_) => "internal_error",
        }
    }

    /// 对应的 HTTP 状态码。
    pub fn status(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Forbidden => StatusCode::FORBIDDEN,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::RangeNotSatisfiable => StatusCode::RANGE_NOT_SATISFIABLE,
            AppError::Database(_) | AppError::Io(_) | AppError::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }
    }
}

/// 错误响应体。
#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Serialize)]
pub struct ErrorDetail {
    pub code: &'static str,
    pub message: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        // 服务端错误保留完整日志，客户端只看到通用提示。
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = %self, "请求处理失败");
        } else {
            tracing::debug!(error = %self, "请求被拒绝");
        }

        let message = match status {
            StatusCode::INTERNAL_SERVER_ERROR => "服务器内部错误".to_string(),
            _ => self.to_string(),
        };

        let body = ErrorBody {
            error: ErrorDetail {
                code: self.code(),
                message,
            },
        };
        (status, Json(body)).into_response()
    }
}

/// 便捷结果别名。
pub type AppResult<T> = Result<T, AppError>;
