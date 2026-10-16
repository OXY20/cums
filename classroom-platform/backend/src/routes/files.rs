//! 文件下载接口：支持 HEAD、GET、Range 与流式传输。
//!
//! 依据建设方案 7.2 节要求实现：
//! - `HEAD` 返回文件元信息
//! - `GET` 正常下载
//! - `Range` 部分内容请求返回 `206 Partial Content`
//! - 无效范围返回 `416 Range Not Satisfiable`
//! - 始终声明 `Accept-Ranges: bytes`
//! - 使用 `ETag`（SHA-256）避免续传时混合新旧版本
//! - 流式读取，绝不把整个文件载入内存

use crate::error::{AppError, AppResult};
use crate::routes::resources::{fetch_resource, safe_join};
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

pub fn routes() -> Router<AppState> {
    Router::new().route("/files/{id}", get(download_file).head(head_file))
}

/// 单次读取的分块大小：1 MiB，兼顾内存占用与吞吐。
const CHUNK_SIZE: usize = 1024 * 1024;

/// 解析后的字节范围。
#[derive(Debug, Clone, Copy)]
struct ByteRange {
    start: u64,
    end: u64,
}

impl ByteRange {
    fn len(&self) -> u64 {
        self.end - self.start + 1
    }
}

/// 解析 `Range` 请求头，仅支持单区间 `bytes=` 形式。
fn parse_range(headers: &HeaderMap, file_size: u64) -> AppResult<Option<ByteRange>> {
    let Some(value) = headers.get(header::RANGE) else {
        return Ok(None);
    };

    let text = value
        .to_str()
        .map_err(|_| AppError::RangeNotSatisfiable)?;

    let spec = text
        .strip_prefix("bytes=")
        .ok_or(AppError::RangeNotSatisfiable)?;

    // 多区间请求不在第一版支持范围内，明确拒绝而不是静默降级。
    if spec.contains(',') {
        return Err(AppError::RangeNotSatisfiable);
    }

    let (start_text, end_text) = spec
        .split_once('-')
        .ok_or(AppError::RangeNotSatisfiable)?;

    let (start, end) = if start_text.is_empty() {
        // 后缀范围：bytes=-N 表示最后 N 字节
        let suffix: u64 = end_text
            .parse()
            .map_err(|_| AppError::RangeNotSatisfiable)?;
        if suffix == 0 || file_size == 0 {
            return Err(AppError::RangeNotSatisfiable);
        }
        let start = file_size.saturating_sub(suffix);
        (start, file_size - 1)
    } else {
        let start: u64 = start_text
            .parse()
            .map_err(|_| AppError::RangeNotSatisfiable)?;
        let end = if end_text.is_empty() {
            file_size.saturating_sub(1)
        } else {
            end_text
                .parse::<u64>()
                .map_err(|_| AppError::RangeNotSatisfiable)?
                .min(file_size.saturating_sub(1))
        };
        (start, end)
    };

    if file_size == 0 || start >= file_size || start > end {
        return Err(AppError::RangeNotSatisfiable);
    }

    Ok(Some(ByteRange { start, end }))
}

/// 构造 ETag：使用资源 SHA-256，保证内容版本可辨识。
fn etag_for(sha256: &str) -> String {
    format!("\"{}\"", sha256)
}

/// 校验客户端 `If-Range`，不匹配时按完整文件返回，避免拼接出损坏内容。
fn if_range_matches(headers: &HeaderMap, sha256: &str) -> bool {
    match headers.get(header::IF_RANGE) {
        Some(value) => value
            .to_str()
            .map(|text| text.trim() == etag_for(sha256) || text.trim() == sha256)
            .unwrap_or(false),
        None => true,
    }
}

/// `HEAD /files/:id`：返回元信息，不传输内容。
async fn head_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    let (resource, size) = open_resource(&state, id).await?;

    let mut response = Response::new(Body::empty());
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&resource.mime_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&etag_for(&resource.sha256))
            .unwrap_or_else(|_| HeaderValue::from_static("\"unknown\"")),
    );
    // 中文文件名需要 RFC 5987 编码，否则部分浏览器会乱码。
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition(&resource.name))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );

    Ok(response)
}

/// `GET /files/:id`：支持 Range 的流式下载。
async fn download_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let (resource, size) = open_resource(&state, id).await?;

    let path = safe_join(&state.config.objects_dir, &resource.storage_key)?;

    // If-Range 不匹配时忽略 Range，回退为完整下载。
    let requested = if if_range_matches(&headers, &resource.sha256) {
        parse_range(&headers, size)?
    } else {
        None
    };

    let mut file = tokio::fs::File::open(&path).await?;

    let (status, start, length) = match requested {
        Some(range) => (StatusCode::PARTIAL_CONTENT, range.start, range.len()),
        None => (StatusCode::OK, 0, size),
    };

    if start > 0 {
        file.seek(std::io::SeekFrom::Start(start)).await?;
    }

    // 以固定大小分块流式读取，内存占用与文件大小无关。
    let stream = ReaderStream::with_capacity(file.take(length), CHUNK_SIZE);

    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;

    let out = response.headers_mut();
    out.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&resource.mime_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    out.insert(
        header::ETAG,
        HeaderValue::from_str(&etag_for(&resource.sha256))
            .unwrap_or_else(|_| HeaderValue::from_static("\"unknown\"")),
    );
    out.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition(&resource.name))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );

    if status == StatusCode::PARTIAL_CONTENT {
        out.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {}-{}/{}", start, start + length - 1, size))
                .map_err(|_| AppError::Internal("Content-Range 生成失败".into()))?,
        );
    }

    // 记录下载汇总，不写高频进度。
    let resource_id = resource.id;
    let state_clone = state.clone();
    tokio::spawn(async move {
        let _ = sqlx::query(
            "INSERT INTO download_jobs (client_id, resource_id, status, bytes_sent, finished_at)
             VALUES ('anonymous', ?1, 'completed', ?2, datetime('now'))",
        )
        .bind(resource_id)
        .bind(length as i64)
        .execute(&state_clone.db)
        .await;
    });

    Ok(response)
}

/// 校验资源状态并返回文件大小。
async fn open_resource(state: &AppState, id: i64) -> AppResult<(crate::models::ResourceRow, u64)> {
    let resource = fetch_resource(state, id).await?;

    if resource.status != "ready" {
        return Err(AppError::Conflict(format!(
            "资源当前状态为 {}，不可下载",
            resource.status
        )));
    }

    let path = safe_join(&state.config.objects_dir, &resource.storage_key)?;
    let meta = tokio::fs::metadata(&path).await.map_err(|_| {
        AppError::NotFound(format!("资源文件缺失：{}", resource.name))
    })?;

    Ok((resource, meta.len()))
}

/// 生成兼容中文文件名的 Content-Disposition。
fn content_disposition(name: &str) -> String {
    let encoded = urlencoding::encode(name);
    format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", encoded, encoded)
}
