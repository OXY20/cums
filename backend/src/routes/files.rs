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
//!
//! 下载链路同时承担两项安全职责：
//! - 学生可以上传任意内容，其中 HTML / SVG / JS / XML 一旦以真实类型内联返回，
//!   就会在平台同源域名下执行（存储型 XSS）。因此只有白名单类型允许内联，
//!   其余一律降级为附件下发，见 [`inline_safe`]；
//! - 作业提交的文件属于学生隐私，匿名访问必须出示提交凭证；教学资源保持
//!   原有的匿名可访问行为，见 [`enforce_submission_guard`]。

use crate::auth::{verify_token, Claims, Role};
use crate::error::{AppError, AppResult};
use crate::models::ResourceRow;
use crate::routes::resources::{fetch_resource, safe_join};
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

pub fn routes() -> Router<AppState> {
    Router::new().route("/files/{id}", get(download_file).head(head_file))
}

/// 文件接口查询参数。
///
/// `inline` 用字符串接收而不是 `bool`：serde 的布尔解析只接受 `true`/`false`，
/// 而 HTML 与脚本里更自然的是 `?inline=1`，两者都要能工作。
#[derive(Debug, Default, Deserialize)]
pub struct FileQuery {
    /// 为真时以内嵌方式返回，供预览弹窗使用。
    #[serde(default)]
    pub inline: Option<String>,
    /// 作业提交凭证：匿名下载作业文件时必须与该提交的 `access_token` 一致。
    #[serde(default)]
    pub submission_token: Option<String>,
    /// 教师端预览票：由已认证接口签发，供 `<img>` / `<video>` / `<iframe>`
    /// 这类无法携带 `Authorization` 头的标签使用。
    #[serde(default)]
    pub preview_ticket: Option<String>,
}

impl FileQuery {
    /// 是否要求内嵌预览。
    fn wants_inline(&self) -> bool {
        matches!(
            self.inline.as_deref().map(str::trim),
            Some("1") | Some("true") | Some("yes") | Some("on")
        )
    }

    /// 归一化后的提交凭证；空白串按「未提供」处理。
    fn submission_token(&self) -> Option<&str> {
        self.submission_token
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
    }

    /// 归一化后的预览票；空白串按「未提供」处理。
    fn preview_ticket(&self) -> Option<&str> {
        self.preview_ticket
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
    }
}

/// 允许以真实 `Content-Type` 内联渲染的类型白名单。
///
/// 判定顺序：
/// 1. `text/plain` 放行——纯文本不执行脚本；浏览器若嗅探成 HTML，
///    由响应上的 `nosniff` 阻断；
/// 2. `application/pdf` 放行——PDF 阅读器运行在浏览器沙箱内，不会读到平台页面；
/// 3. `image/*` 放行，但**排除 `image/svg+xml`**：SVG 是 XML 文档，
///    可以内嵌 `<script>` 与事件属性，同源内联等同于任意脚本执行；
/// 4. `audio/*`、`video/*` 放行；
/// 5. 其余一律不内联，包含 `text/html`、`application/xhtml+xml`、
///    `application/javascript`、`text/xml`、`application/xml`、
///    各种 `+xml` 后缀以及 `application/octet-stream`。
pub fn inline_safe(mime: &str) -> bool {
    // 参数（如 text/plain; charset=utf-8）不参与判定。
    let essence = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    if essence.is_empty() {
        return false;
    }

    match essence.as_str() {
        "text/plain" | "application/pdf" => return true,
        // SVG 可以被浏览器当作脚本宿主，必须走附件通道。
        "image/svg+xml" => return false,
        _ => {}
    }

    essence.starts_with("image/") || essence.starts_with("audio/") || essence.starts_with("video/")
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

    let text = value.to_str().map_err(|_| AppError::RangeNotSatisfiable)?;

    let spec = text
        .strip_prefix("bytes=")
        .ok_or(AppError::RangeNotSatisfiable)?;

    // 多区间请求不在第一版支持范围内，明确拒绝而不是静默降级。
    if spec.contains(',') {
        return Err(AppError::RangeNotSatisfiable);
    }

    let (start_text, end_text) = spec.split_once('-').ok_or(AppError::RangeNotSatisfiable)?;

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

/// 统一的响应头设置：内容类型、处置方式与安全头都在这一处决定。
///
/// 三态判定，避免既放开 XSS 又误伤正常下载：
/// 1. 请求要内联、且类型在 [`inline_safe`] 白名单内 → 真实 `Content-Type`
///    搭配 `inline`，浏览器会在页面内渲染；
/// 2. 请求要内联、但类型不在白名单 → 降级为 `application/octet-stream` 搭配
///    `attachment`，学生上传的 HTML / SVG / JS / XML 只会被下载而不会执行；
/// 3. 普通下载 → 保留真实 `Content-Type`（便于系统按类型关联打开），但同样是
///    `attachment`，浏览器不会用它渲染页面。
///
/// 三种情况都带 `X-Content-Type-Options: nosniff`，阻断浏览器按内容嗅探
/// 绕过类型白名单（例如把 `text/plain` 当 HTML 执行）；只有真正内联的纯文本
/// 与图片才额外加 CSP：`sandbox` 让文档脱离同源，`default-src 'none'`
/// 禁掉一切外部资源，双保险防止脚本执行。
fn apply_file_headers(
    headers: &mut HeaderMap,
    resource: &ResourceRow,
    wants_inline: bool,
) -> AppResult<()> {
    let inline_ok = wants_inline && inline_safe(&resource.mime_type);
    // 内联白名单之外的类型，只要客户端要内联就降级为二进制流。
    let fallback_binary = wants_inline && !inline_ok;

    let content_type = if fallback_binary {
        HeaderValue::from_static("application/octet-stream")
    } else {
        HeaderValue::from_str(&resource.mime_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"))
    };

    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // 中文文件名需要 RFC 5987 编码，否则部分浏览器会乱码。
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition(&resource.name, inline_ok))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );

    if inline_ok {
        let essence = resource
            .mime_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if essence == "text/plain" || essence.starts_with("image/") {
            headers.insert(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("sandbox; default-src 'none'; style-src 'unsafe-inline'"),
            );
        }
    }

    Ok(())
}

/// 作业文件访问守卫。
///
/// 资源可能同时是教学资源与学生作业文件，两者权限模型完全不同，因此按
/// 「是否被 `homework_submission_files` 引用」区分：
///
/// - 未被引用 → 教学资源，保持原有的匿名可访问行为，不做任何限制；
/// - 被引用 → 作业文件，按下列顺序判定：
///   1. 请求带有效 Bearer 且角色为教师或管理员 → 放行（教师端后台预览）；
///   2. 提交已撤回（`withdrawn_at` 非空）→ 匿名访问一律 403，
///      撤回的作业不应再对外暴露；
///   3. 必须提供 `submission_token`，且与该提交的 `access_token` 完全一致；
///      `access_token` 为空的旧记录不接受任何凭证，避免空串互相匹配。
///
/// 一个资源被多次提交复用时，任一未撤回提交的凭证有效即可放行。
async fn enforce_submission_guard(
    state: &AppState,
    resource_id: i64,
    query: &FileQuery,
    headers: &HeaderMap,
) -> AppResult<()> {
    let linked: Vec<i64> = sqlx::query_scalar(
        "SELECT submission_id FROM homework_submission_files WHERE resource_id = ?1",
    )
    .bind(resource_id)
    .fetch_all(&state.db)
    .await?;

    // 教学资源：与作业无关，保持匿名可下载。
    if linked.is_empty() {
        return Ok(());
    }

    if let Some(claims) = bearer_claims(state, headers) {
        if matches!(claims.role, Role::Teacher | Role::Admin) {
            return Ok(());
        }
    }

    // 预览票：教师端 `<img>` / `<video>` / `<iframe>` 无法携带 Authorization 头，
    // 因此由已认证的详情接口签发一张只对当前资源有效、十分钟过期的票。
    // 票里绑定 `res`，换一个资源 ID 立即失效，不能当作通用通行证。
    if let Some(ticket) = query.preview_ticket() {
        if crate::auth::verify_preview_ticket(&state.config, resource_id, ticket).is_ok() {
            return Ok(());
        }
    }

    let provided = query.submission_token().unwrap_or_default();
    if provided.is_empty() {
        return Err(AppError::Forbidden);
    }

    for submission_id in linked {
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT access_token, withdrawn_at FROM homework_submissions WHERE id = ?1",
        )
        .bind(submission_id)
        .fetch_optional(&state.db)
        .await?;

        let Some((access_token, withdrawn_at)) = row else {
            continue;
        };

        // 已撤回的提交，其文件不再对匿名访问者开放。
        if withdrawn_at.is_some() {
            continue;
        }

        if !access_token.is_empty() && access_token == provided {
            return Ok(());
        }
    }

    Err(AppError::Forbidden)
}

/// 从 `Authorization: Bearer <token>` 尽力解析声明。
///
/// 下载接口不能直接用 `AuthUser` 提取器：那会让未带令牌的匿名下载
/// 直接返回 401，而教学资源本来就应当匿名可访问。这里改为「解析失败即匿名」，
/// 由 [`enforce_submission_guard`] 决定是否需要凭证。
fn bearer_claims(state: &AppState, headers: &HeaderMap) -> Option<Claims> {
    let header = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|text| !text.is_empty())?;

    verify_token(&state.config, token).ok()
}

/// `HEAD /files/:id`：返回元信息，不传输内容。
async fn head_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<FileQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    // 先判权限再探查资源：作业文件对无权访问者一律 403，
    // 不能靠 404 / 409 的差异反推某个资源 ID 是否存在。
    enforce_submission_guard(&state, id, &query, &headers).await?;
    let (resource, size) = open_resource(&state, id).await?;

    let mut response = Response::new(Body::empty());
    let out = response.headers_mut();
    out.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    out.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    out.insert(
        header::ETAG,
        HeaderValue::from_str(&etag_for(&resource.sha256))
            .unwrap_or_else(|_| HeaderValue::from_static("\"unknown\"")),
    );
    apply_file_headers(out, &resource, query.wants_inline())?;

    Ok(response)
}

/// `GET /files/:id`：支持 Range 的流式下载。
///
/// 查询参数 `inline=1` 时把 `Content-Disposition` 改为 `inline`，
/// 供作业预览弹窗内嵌 PDF / 图片 / 视频时使用；默认仍按附件下载。
/// 只有 [`inline_safe`] 白名单内的类型才会真正内联，其余降级为附件。
async fn download_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<FileQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    // 先判权限再探查资源：作业文件对无权访问者一律 403，
    // 不能靠 404 / 409 的差异反推某个资源 ID 是否存在。
    enforce_submission_guard(&state, id, &query, &headers).await?;
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
        header::ETAG,
        HeaderValue::from_str(&etag_for(&resource.sha256))
            .unwrap_or_else(|_| HeaderValue::from_static("\"unknown\"")),
    );
    apply_file_headers(out, &resource, query.wants_inline())?;

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
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|_| AppError::NotFound(format!("资源文件缺失：{}", resource.name)))?;

    Ok((resource, meta.len()))
}

/// 生成兼容中文文件名的 Content-Disposition。
///
/// `inline` 为真时使用 `inline`，浏览器会尝试在页面内展示（PDF、图片、视频），
/// 否则按附件下载。
fn content_disposition(name: &str, inline: bool) -> String {
    let encoded = urlencoding::encode(name);
    let kind = if inline { "inline" } else { "attachment" };
    format!("{kind}; filename=\"{encoded}\"; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
mod tests {
    use super::inline_safe;

    #[test]
    fn 可执行类型一律不允许内联() {
        for mime in [
            "text/html",
            "application/xhtml+xml",
            "image/svg+xml",
            "application/javascript",
            "text/javascript",
            "text/xml",
            "application/xml",
            "application/octet-stream",
            "",
        ] {
            assert!(!inline_safe(mime), "{mime} 不应允许内联");
        }
    }

    #[test]
    fn 安全类型允许内联() {
        for mime in [
            "image/png",
            "image/jpeg",
            "image/webp",
            "audio/mpeg",
            "video/mp4",
            "application/pdf",
            "text/plain",
        ] {
            assert!(inline_safe(mime), "{mime} 应允许内联");
        }
    }

    #[test]
    fn 类型参数与大小写不影响判定() {
        assert!(inline_safe("Text/Plain; charset=utf-8"));
        assert!(!inline_safe("  TEXT/HTML ; charset=utf-8"));
        assert!(!inline_safe("IMAGE/SVG+XML"));
        assert!(inline_safe("IMAGE/PNG"));
    }
}
