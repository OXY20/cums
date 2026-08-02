use actix_files::NamedFile;
use actix_multipart::Multipart;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use chrono::Local;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::config::AppState;
use crate::models::*;
use crate::utils::*;

// ==================== 通用管理员验证 ====================

/// 验证管理员权限，返回 Ok(()) 或错误响应
fn check_admin(state: &web::Data<AppState>, req: &HttpRequest) -> Result<(), HttpResponse> {
    {
        let config = state.config.read().unwrap();
        if !config.admin_enabled {
            return Err(HttpResponse::Forbidden().json(ApiResponse::error("管理员功能未启用")));
        }
    }
    let token = req
        .headers()
        .get("X-Admin-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !state.validate_admin_token(token) {
        return Err(HttpResponse::Unauthorized().json(ApiResponse::error("未授权访问")));
    }
    Ok(())
}

// ==================== 登录 ====================

/// POST /api/v1/login - 学生登录
pub async fn login(
    state: web::Data<AppState>,
    req: web::Json<LoginRequest>,
) -> impl Responder {
    let config = state.config.read().unwrap();

    let class_exists = config
        .subjects
        .values()
        .any(|sc| sc.classes.contains(&req.class));

    if !class_exists {
        return HttpResponse::BadRequest().json(ApiResponse::error("班级不存在"));
    }

    if req.student_id.is_empty() || req.student_name.is_empty() {
        return HttpResponse::BadRequest().json(ApiResponse::error("学号和姓名不能为空"));
    }

    HttpResponse::Ok().json(ApiResponse::with_message(
        "登录成功",
        serde_json::json!({
            "class": req.class,
            "student_id": req.student_id,
            "student_name": req.student_name,
        }),
    ))
}

// ==================== 配置 ====================

/// GET /api/v1/config - 获取配置信息
pub async fn get_config(state: web::Data<AppState>) -> impl Responder {
    let config = state.config.read().unwrap();
    let subjects = &config.subjects;
    HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({
        "subjects": subjects,
    })))
}

// ==================== 版本 ====================

/// GET /api/v1/version - 获取版本信息
pub async fn version(state: web::Data<AppState>) -> impl Responder {
    let config = state.config.read().unwrap();
    HttpResponse::Ok().json(VersionResponse {
        success: true,
        version: config.version.clone(),
    })
}

// ==================== 更新日志 ====================

/// GET /api/v1/changelog - 获取更新日志
pub async fn changelog(state: web::Data<AppState>) -> impl Responder {
    let changelog_path = state.base_dir.join("CHANGELOG.md");
    match std::fs::read_to_string(&changelog_path) {
        Ok(content) => HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({
            "content": content,
        }))),
        Err(_) => HttpResponse::Ok().json(ApiResponse::error("无法读取更新日志")),
    }
}

// ==================== 文件上传 ====================

/// POST /api/v1/upload - 学生上传文件
pub async fn upload(
    state: web::Data<AppState>,
    req: HttpRequest,
    mut payload: Multipart,
) -> impl Responder {
    let config = state.config.read().unwrap();

    let mut class = String::new();
    let mut student_id = String::new();
    let mut student_name = String::new();
    let mut subject = String::new();
    let mut homework = String::new();
    let mut saved_filename: Option<String> = None;

    while let Some(item) = payload.next().await {
        let mut field = match item {
            Ok(f) => f,
            Err(e) => {
                log::error!("解析 multipart 字段失败: {}", e);
                return HttpResponse::BadRequest()
                    .json(UploadResponse { success: false, message: "解析请求失败".to_string(), filename: None });
            }
        };

        let content_disposition = field.content_disposition();
        let field_name = content_disposition
            .map(|cd| cd.get_name().unwrap_or(""))
            .unwrap_or("")
            .to_string();

        let filename = content_disposition
            .and_then(|cd| cd.get_filename())
            .map(|f: &str| f.to_string());

        if filename.is_some() {
            let fname = filename.unwrap();
            let ext = std::path::Path::new(&fname)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_string();
            let ext_with_dot = format!(".{}", ext);

            if !is_allowed_file_type(&ext_with_dot) {
                return HttpResponse::BadRequest()
                    .json(UploadResponse { success: false, message: "不支持的文件类型".to_string(), filename: None });
            }

            if class.is_empty() || student_id.is_empty() || student_name.is_empty()
                || subject.is_empty() || homework.is_empty()
            {
                return HttpResponse::BadRequest()
                    .json(UploadResponse { success: false, message: "缺少必要参数".to_string(), filename: None });
            }

            let sub_config = match config.subjects.get(&subject) {
                Some(c) => c,
                None => {
                    return HttpResponse::BadRequest()
                        .json(UploadResponse { success: false, message: "科目不存在".to_string(), filename: None });
                }
            };

            if !sub_config.classes.contains(&class) {
                return HttpResponse::BadRequest()
                    .json(UploadResponse { success: false, message: "该班级没有此科目".to_string(), filename: None });
            }

            let homework_exists = sub_config.homeworks.iter().any(|hw| hw.name == homework);
            if !homework_exists {
                return HttpResponse::BadRequest()
                    .json(UploadResponse { success: false, message: "作业不存在".to_string(), filename: None });
            }

            let timestamp = Local::now().format("%Y%m%d%H%M%S").to_string();
            let new_filename = format!(
                "{}_{}_{}_{}{}",
                sanitize_filename(&homework),
                sanitize_filename(&student_id),
                sanitize_filename(&student_name),
                timestamp,
                ext_with_dot
            );

            let save_path = state.upload_dir
                .join(sanitize_filename(&subject))
                .join(sanitize_filename(&class))
                .join(sanitize_filename(&homework));

            if let Err(e) = std::fs::create_dir_all(&save_path) {
                log::error!("创建目录失败: {}", e);
                return HttpResponse::InternalServerError()
                    .json(UploadResponse { success: false, message: "创建目录失败".to_string(), filename: None });
            }

            let full_path = save_path.join(&new_filename);

            let mut file_data = Vec::new();
            while let Some(chunk) = field.next().await {
                let data = match chunk {
                    Ok(d) => d,
                    Err(e) => {
                        log::error!("读取文件数据失败: {}", e);
                        return HttpResponse::InternalServerError()
                            .json(UploadResponse { success: false, message: "读取文件数据失败".to_string(), filename: None });
                    }
                };
                file_data.extend_from_slice(&data);
            }

            if file_data.len() > 32 * 1024 * 1024 {
                return HttpResponse::BadRequest()
                    .json(UploadResponse { success: false, message: "文件大小超过限制(32MB)".to_string(), filename: None });
            }

            if let Err(e) = std::fs::write(&full_path, &file_data) {
                log::error!("保存文件失败: {}", e);
                return HttpResponse::InternalServerError()
                    .json(UploadResponse { success: false, message: "保存文件失败".to_string(), filename: None });
            }

            let client_ip = get_client_ip(&req);
            let log_msg = format!(
                "[{}] {} {} {} 提交 {}-{} IP:{}",
                Local::now().format("%Y-%m-%d %H:%M:%S"),
                class, student_id, student_name, subject, homework, client_ip
            );
            println!("{}", log_msg);
            write_log(&state.base_dir, &log_msg);

            saved_filename = Some(new_filename);
        } else {
            let mut value = Vec::new();
            while let Some(chunk) = field.next().await {
                let data = match chunk {
                    Ok(d) => d,
                    Err(_) => break,
                };
                value.extend_from_slice(&data);
            }

            let value_str = String::from_utf8_lossy(&value).to_string();
            match field_name.as_str() {
                "class" => class = value_str,
                "student_id" => student_id = value_str,
                "student_name" => student_name = value_str,
                "subject" => subject = value_str,
                "homework" => homework = value_str,
                _ => {}
            }
        }
    }

    match saved_filename {
        Some(fname) => HttpResponse::Ok().json(UploadResponse {
            success: true,
            message: "上传成功".to_string(),
            filename: Some(fname),
        }),
        None => HttpResponse::BadRequest().json(UploadResponse {
            success: false,
            message: "请选择要上传的文件".to_string(),
            filename: None,
        }),
    }
}

// ==================== 模板下载 ====================

/// GET /api/v1/template?file=... - 下载模板文件
pub async fn template_download(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<HashMap<String, String>>,
) -> HttpResponse {
    let file_path = match query.get("file") {
        Some(f) => f.clone(),
        None => return HttpResponse::BadRequest().json(ApiResponse::error("缺少文件参数")),
    };

    if !is_safe_template_path(&file_path) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    let full_path = state.base_dir.join(&file_path);

    let templates_dir = state.base_dir.join("templates");
    let abs_full = match std::fs::canonicalize(&full_path) {
        Ok(p) => p,
        Err(_) => return HttpResponse::NotFound().json(ApiResponse::error("文件不存在")),
    };
    let abs_templates = match std::fs::canonicalize(&templates_dir) {
        Ok(p) => p,
        Err(_) => return HttpResponse::Forbidden().json(ApiResponse::error("非法路径")),
    };

    if !abs_full.starts_with(&abs_templates) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    match NamedFile::open_async(&abs_full).await {
        Ok(file) => {
            let filename = abs_full
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("download");
            file.set_content_disposition(
                actix_web::http::header::ContentDisposition::attachment(
                    urlencoding::encode(filename).to_string(),
                ),
            )
            .into_response(&req)
        }
        Err(_) => HttpResponse::NotFound().json(ApiResponse::error("文件不存在")),
    }
}

// ==================== 管理员登录 ====================

/// POST /api/v1/admin/login - 管理员登录
pub async fn admin_login(
    state: web::Data<AppState>,
    req: web::Json<AdminLoginRequest>,
) -> impl Responder {
    let config = state.config.read().unwrap();

    if !config.admin_enabled {
        return HttpResponse::Forbidden().json(AdminLoginResponse {
            success: false,
            message: "管理员功能未启用".to_string(),
            token: None,
        });
    }

    if req.password != config.admin_password {
        return HttpResponse::Unauthorized().json(AdminLoginResponse {
            success: false,
            message: "密码错误".to_string(),
            token: None,
        });
    }

    let token = generate_admin_token();
    let expiry = Local::now() + chrono::Duration::hours(24);
    state.admin_tokens.write().unwrap().insert(token.clone(), expiry);

    state.log_operation("管理员登录", "管理员登录成功");

    HttpResponse::Ok().json(AdminLoginResponse {
        success: true,
        message: "登录成功".to_string(),
        token: Some(token),
    })
}

// ==================== 管理员配置 ====================

/// GET /api/v1/admin/config - 获取管理员配置
/// POST /api/v1/admin/config - 更新管理员配置
pub async fn admin_config(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: Option<web::Json<AdminConfigRequest>>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    match req.method() {
        &actix_web::http::Method::GET => {
            let config = state.config.read().unwrap();
            HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({
                "subjects": config.subjects,
            })))
        }
        &actix_web::http::Method::POST => {
            let body = match body {
                Some(b) => b,
                None => return HttpResponse::BadRequest().json(ApiResponse::error("请求格式错误")),
            };

            {
                let mut cfg = state.config.write().unwrap();
                cfg.subjects = body.subjects.clone();
            }

            let config = state.config.read().unwrap();
            if let Err(e) = crate::config::save_config(&config, &state.base_dir) {
                return HttpResponse::InternalServerError()
                    .json(ApiResponse::error(&format!("保存配置失败: {}", e)));
            }

            if let Err(e) = reinit_upload_dirs(&state) {
                return HttpResponse::InternalServerError()
                    .json(ApiResponse::error(&format!("初始化目录失败 {}", e)));
            }

            state.log_operation("更新配置", "管理员更新了科目配置");

            HttpResponse::Ok().json(ApiResponse::with_message("配置已更新", serde_json::json!({})))
        }
        _ => HttpResponse::MethodNotAllowed().json(ApiResponse::error("请求方法错误")),
    }
}

/// 重新初始化上传目录
fn reinit_upload_dirs(state: &web::Data<AppState>) -> Result<(), String> {
    let config = state.config.read().unwrap();
    for (subject, sub_config) in &config.subjects {
        for class in &sub_config.classes {
            for hw in &sub_config.homeworks {
                let dir = state.upload_dir
                    .join(sanitize_filename(subject))
                    .join(sanitize_filename(class))
                    .join(sanitize_filename(&hw.name));
                std::fs::create_dir_all(&dir)
                    .map_err(|e| format!("创建目录失败: {}", e))?;
            }
        }
    }
    Ok(())
}

// ==================== 模板上传（管理端） ====================

/// POST /api/v1/admin/template/upload - 上传模板文件
pub async fn template_upload(
    state: web::Data<AppState>,
    req: HttpRequest,
    mut payload: Multipart,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let mut subject = String::new();
    let mut _homework = String::new();
    let mut template_path: Option<String> = None;

    while let Some(item) = payload.next().await {
        let mut field = match item {
            Ok(f) => f,
            Err(e) => {
                log::error!("解析 multipart 失败: {}", e);
                return HttpResponse::BadRequest().json(ApiResponse::error("解析请求失败"));
            }
        };

        let content_disposition = field.content_disposition();
        let field_name = content_disposition
            .map(|cd| cd.get_name().unwrap_or(""))
            .unwrap_or("")
            .to_string();
        let filename = content_disposition
            .and_then(|cd| cd.get_filename())
            .map(|f: &str| f.to_string());

        if filename.is_some() {
            let fname = filename.unwrap();
            let ext = PathBuf::from(&fname)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_string();
            let ext_with_dot = format!(".{}", ext);

            if !is_allowed_file_type(&ext_with_dot) {
                return HttpResponse::BadRequest().json(ApiResponse::error("不支持的文件类型"));
            }

            if subject.is_empty() {
                return HttpResponse::BadRequest().json(ApiResponse::error("缺少科目参数"));
            }

            let safe_name = sanitize_filename(&fname.replace(&ext_with_dot, "")) + &ext_with_dot;

            let subject_dir = state.base_dir.join("templates").join(sanitize_filename(&subject));
            if let Err(e) = std::fs::create_dir_all(&subject_dir) {
                log::error!("创建目录失败: {}", e);
                return HttpResponse::InternalServerError().json(ApiResponse::error("创建目录失败"));
            }

            let full_path = subject_dir.join(&safe_name);

            let mut file_data = Vec::new();
            while let Some(chunk) = field.next().await {
                let data = match chunk {
                    Ok(d) => d,
                    Err(e) => {
                        log::error!("读取文件数据失败: {}", e);
                        return HttpResponse::InternalServerError().json(ApiResponse::error("读取文件数据失败"));
                    }
                };
                file_data.extend_from_slice(&data);
            }

            if let Err(e) = std::fs::write(&full_path, &file_data) {
                log::error!("保存文件失败: {}", e);
                return HttpResponse::InternalServerError().json(ApiResponse::error("保存文件失败"));
            }

            let tpath = format!("templates/{}/{}", sanitize_filename(&subject), safe_name);
            state.log_operation("上传模板", &format!("上传模板文件: {}", tpath));

            template_path = Some(tpath);
        } else {
            let mut value = Vec::new();
            while let Some(chunk) = field.next().await {
                let data = match chunk {
                    Ok(d) => d,
                    Err(_) => break,
                };
                value.extend_from_slice(&data);
            }
            let value_str = String::from_utf8_lossy(&value).to_string();
            match field_name.as_str() {
                "subject" => subject = value_str,
                "homework" => _homework = value_str,
                _ => {}
            }
        }
    }

    match template_path {
        Some(path) => HttpResponse::Ok().json(ApiResponse::with_message(
            "上传成功",
            serde_json::json!({ "path": path }),
        )),
        None => HttpResponse::BadRequest().json(ApiResponse::error("请选择要上传的文件")),
    }
}

// ==================== 模板删除（管理端） ====================

/// POST /api/v1/admin/template/delete - 删除模板文件
pub async fn template_delete(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<TemplateDeleteRequest>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    if !is_safe_template_path(&body.path) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    let full_path = state.base_dir.join(&body.path);

    let templates_dir = state.base_dir.join("templates");
    let abs_full = match std::fs::canonicalize(&full_path) {
        Ok(p) => p,
        Err(_) => return HttpResponse::Ok().json(ApiResponse::with_message("文件已删除", serde_json::json!({}))),
    };
    let abs_templates = match std::fs::canonicalize(&templates_dir) {
        Ok(p) => p,
        Err(_) => return HttpResponse::Forbidden().json(ApiResponse::error("非法路径")),
    };

    if !abs_full.starts_with(&abs_templates) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    match std::fs::remove_file(&abs_full) {
        Ok(_) => {
            state.log_operation("删除模板", &format!("删除模板文件: {}", body.path));
            HttpResponse::Ok().json(ApiResponse::with_message("文件已删除", serde_json::json!({})))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            HttpResponse::Ok().json(ApiResponse::with_message("文件已删除", serde_json::json!({})))
        }
        Err(e) => {
            log::error!("删除文件失败: {}", e);
            HttpResponse::InternalServerError().json(ApiResponse::error("删除文件失败"))
        }
    }
}

// ==================== 文件管理（管理端 v2 新增） ====================

/// GET /api/v1/admin/files - 获取文件列表
pub async fn admin_file_list(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<FileListQuery>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let upload_dir = &state.upload_dir;

    // 构建扫描路径
    let scan_path = if let Some(ref subject) = query.subject {
        let mut p = upload_dir.join(sanitize_filename(subject));
        if let Some(ref class) = query.class {
            p = p.join(sanitize_filename(class));
            if let Some(ref homework) = query.homework {
                p = p.join(sanitize_filename(homework));
            }
        }
        p
    } else {
        upload_dir.clone()
    };

    let mut files: Vec<FileInfo> = Vec::new();

    // 递归扫描文件
    fn scan_dir(dir: &std::path::Path, upload_dir: &std::path::Path, files: &mut Vec<FileInfo>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan_dir(&path, upload_dir, files);
                } else if path.is_file() {
                    if let Ok(metadata) = path.metadata() {
                        let name = path.file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let relative = path.strip_prefix(upload_dir)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .replace('\\', "/");
                        let modified = metadata.modified()
                            .map(|t| {
                                let dt: chrono::DateTime<chrono::Local> = t.into();
                                dt.format("%Y-%m-%d %H:%M:%S").to_string()
                            })
                            .unwrap_or_default();
                        files.push(FileInfo {
                            name,
                            size: metadata.len(),
                            modified,
                            path: format!("uploads/{}", relative),
                        });
                    }
                }
            }
        }
    }

    if scan_path.exists() {
        scan_dir(&scan_path, upload_dir, &mut files);
    }

    // 按修改时间倒序
    files.sort_by(|a, b| b.modified.cmp(&a.modified));

    HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({
        "files": files,
    })))
}

/// POST /api/v1/admin/files/delete - 删除上传的文件
pub async fn admin_file_delete(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<FileDeleteRequest>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let path = &body.path;

    // 安全检查：只允许删除 uploads 目录下的文件
    if path.contains("..") || !path.starts_with("uploads/") {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    let full_path = state.base_dir.join(path);

    // 验证路径在 uploads 目录下
    let abs_full = match std::fs::canonicalize(&full_path) {
        Ok(p) => p,
        Err(_) => return HttpResponse::Ok().json(ApiResponse::with_message("文件已删除", serde_json::json!({}))),
    };
    let abs_uploads = match std::fs::canonicalize(&state.upload_dir) {
        Ok(p) => p,
        Err(_) => return HttpResponse::Forbidden().json(ApiResponse::error("非法路径")),
    };

    if !abs_full.starts_with(&abs_uploads) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    match std::fs::remove_file(&abs_full) {
        Ok(_) => {
            state.log_operation("删除文件", &format!("删除上传文件: {}", path));
            HttpResponse::Ok().json(ApiResponse::with_message("文件已删除", serde_json::json!({})))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            HttpResponse::Ok().json(ApiResponse::with_message("文件已删除", serde_json::json!({})))
        }
        Err(e) => {
            log::error!("删除文件失败: {}", e);
            HttpResponse::InternalServerError().json(ApiResponse::error("删除文件失败"))
        }
    }
}

// ==================== 统计仪表盘（管理端 v2 新增） ====================

/// GET /api/v1/admin/stats - 获取统计数据
pub async fn admin_stats(state: web::Data<AppState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let config = state.config.read().unwrap();
    let upload_dir = &state.upload_dir;

    let mut total_files = 0usize;
    let mut total_size = 0u64;
    let mut subject_stats = Vec::new();
    let mut all_recent: Vec<RecentUpload> = Vec::new();

    for (subject, sub_config) in &config.subjects {
        let mut s_files = 0usize;
        let mut s_size = 0u64;

        for class in &sub_config.classes {
            for hw in &sub_config.homeworks {
                let dir = upload_dir
                    .join(sanitize_filename(subject))
                    .join(sanitize_filename(class))
                    .join(sanitize_filename(&hw.name));
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() {
                            if let Ok(meta) = path.metadata() {
                                s_files += 1;
                                s_size += meta.len();
                                total_files += 1;
                                total_size += meta.len();

                                // 收集最近上传
                                let modified = meta.modified().map(|t| {
                                    let dt: chrono::DateTime<chrono::Local> = t.into();
                                    dt.format("%Y-%m-%d %H:%M:%S").to_string()
                                }).unwrap_or_default();
                                let filename = path.file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("")
                                    .to_string();
                                let relative = path.strip_prefix(upload_dir)
                                    .unwrap_or(&path)
                                    .to_string_lossy()
                                    .replace('\\', "/");
                                all_recent.push(RecentUpload {
                                    filename,
                                    path: format!("uploads/{}", relative),
                                    size: meta.len(),
                                    modified,
                                });
                            }
                        }
                    }
                }
            }
        }

        subject_stats.push(SubjectStat {
            name: subject.clone(),
            file_count: s_files,
            total_size: s_size,
            class_count: sub_config.classes.len(),
            homework_count: sub_config.homeworks.len(),
        });
    }

    // 按修改时间倒序，取最近 20 条
    all_recent.sort_by(|a, b| b.modified.cmp(&a.modified));
    all_recent.truncate(20);

    let stats = DashboardStats {
        total_files,
        total_size,
        total_subjects: config.subjects.len(),
        total_classes: config.subjects.values().map(|s| s.classes.len()).sum(),
        total_homeworks: config.subjects.values().map(|s| s.homeworks.len()).sum(),
        subject_stats,
        recent_uploads: all_recent,
    };

    HttpResponse::Ok().json(ApiResponse::ok(serde_json::to_value(stats).unwrap_or_default()))
}

// ==================== 作业提交情况（管理端 v2 新增） ====================

/// GET /api/v1/admin/submissions?subject=xxx&class=xxx&homework=xxx
pub async fn admin_submissions(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<FileListQuery>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let subject = match &query.subject {
        Some(s) => s.clone(),
        None => return HttpResponse::BadRequest().json(ApiResponse::error("缺少科目参数")),
    };
    let class_name = match &query.class {
        Some(c) => c.clone(),
        None => return HttpResponse::BadRequest().json(ApiResponse::error("缺少班级参数")),
    };
    let homework = match &query.homework {
        Some(h) => h.clone(),
        None => return HttpResponse::BadRequest().json(ApiResponse::error("缺少作业参数")),
    };

    let config = state.config.read().unwrap();
    let sub_config = match config.subjects.get(&subject) {
        Some(c) => c,
        None => return HttpResponse::BadRequest().json(ApiResponse::error("科目不存在")),
    };

    if !sub_config.classes.contains(&class_name) {
        return HttpResponse::BadRequest().json(ApiResponse::error("班级不存在"));
    }

    let hw_exists = sub_config.homeworks.iter().any(|hw| hw.name == homework);
    if !hw_exists {
        return HttpResponse::BadRequest().json(ApiResponse::error("作业不存在"));
    }

    // 扫描上传目录获取已提交文件
    let dir = state.upload_dir
        .join(sanitize_filename(&subject))
        .join(sanitize_filename(&class_name))
        .join(sanitize_filename(&homework));

    let mut submitted: Vec<String> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    submitted.push(name.to_string());
                }
            }
        }
    }

    submitted.sort();

    let status = SubmissionStatus {
        homework_name: homework,
        subject,
        class: class_name,
        submitted,
        not_submitted: vec!["未在系统中记录".to_string()], // 学生名单不在配置中
    };

    HttpResponse::Ok().json(ApiResponse::ok(serde_json::to_value(status).unwrap_or_default()))
}

// ==================== 密码修改（管理端 v2 新增） ====================

/// POST /api/v1/admin/password - 修改管理员密码
pub async fn admin_change_password(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<ChangePasswordRequest>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    // 验证旧密码
    {
        let config = state.config.read().unwrap();
        if config.admin_password != body.old_password {
            return HttpResponse::BadRequest().json(ApiResponse::error("旧密码错误"));
        }
    }

    if body.new_password.is_empty() || body.new_password.len() < 4 {
        return HttpResponse::BadRequest().json(ApiResponse::error("新密码长度至少4位"));
    }

    // 更新密码
    {
        let mut config = state.config.write().unwrap();
        config.admin_password = body.new_password.clone();
    }

    // 保存到文件
    let config = state.config.read().unwrap();
    if let Err(e) = crate::config::save_config(&config, &state.base_dir) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("保存配置失败: {}", e)));
    }

    state.log_operation("修改密码", "管理员修改了密码");

    HttpResponse::Ok().json(ApiResponse::with_message("密码修改成功", serde_json::json!({})))
}

// ==================== 操作日志（管理端 v2 新增） ====================

/// GET /api/v1/admin/logs - 获取操作日志
pub async fn admin_logs(state: web::Data<AppState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let logs = state.get_op_logs(100);
    HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({
        "logs": logs,
    })))
}

// ==================== 静态页面 ====================

/// GET / - 学生端首页
pub async fn index_page(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let index_path = state.base_dir.join("static").join("index.html");
    if index_path.exists() {
        match NamedFile::open_async(&index_path).await {
            Ok(file) => file.into_response(&req),
            Err(_) => HttpResponse::NotFound().body("静态文件不存在"),
        }
    } else {
        HttpResponse::NotFound().body("静态文件不存在，请确保 static/index.html 与程序在同一目录")
    }
}

/// GET /admin - 管理员页面
pub async fn admin_page(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let config = state.config.read().unwrap();
    if !config.admin_enabled {
        return HttpResponse::Forbidden().body("管理员功能未启用");
    }

    let admin_path = state.base_dir.join("static").join("admin.html");
    if admin_path.exists() {
        match NamedFile::open_async(&admin_path).await {
            Ok(file) => file.into_response(&req),
            Err(_) => HttpResponse::NotFound().body("管理员页面不存在"),
        }
    } else {
        HttpResponse::NotFound().body("管理员页面不存在")
    }
}