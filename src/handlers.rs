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

// ==================== 登录 ====================

/// POST /api/v1/login - 学生登录
pub async fn login(
    state: web::Data<AppState>,
    req: web::Json<LoginRequest>,
) -> impl Responder {
    let config = state.config.read().unwrap();

    // 验证班级是否存在
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

        // 获取文件名
        let filename = content_disposition
            .and_then(|cd| cd.get_filename())
            .map(|f: &str| f.to_string());

        if filename.is_some() {
            // 这是文件字段
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

            // 验证参数
            if class.is_empty() || student_id.is_empty() || student_name.is_empty()
                || subject.is_empty() || homework.is_empty()
            {
                return HttpResponse::BadRequest()
                    .json(UploadResponse { success: false, message: "缺少必要参数".to_string(), filename: None });
            }

            // 验证科目
            let sub_config = match config.subjects.get(&subject) {
                Some(c) => c,
                None => {
                    return HttpResponse::BadRequest()
                        .json(UploadResponse { success: false, message: "科目不存在".to_string(), filename: None });
                }
            };

            // 验证班级是否属于该科目
            if !sub_config.classes.contains(&class) {
                return HttpResponse::BadRequest()
                    .json(UploadResponse { success: false, message: "该班级没有此科目".to_string(), filename: None });
            }

            // 验证作业
            let homework_exists = sub_config.homeworks.iter().any(|hw| hw.name == homework);
            if !homework_exists {
                return HttpResponse::BadRequest()
                    .json(UploadResponse { success: false, message: "作业不存在".to_string(), filename: None });
            }

            // 生成文件名
            let timestamp = Local::now().format("%Y%m%d%H%M%S").to_string();
            let new_filename = format!(
                "{}_{}_{}_{}{}",
                sanitize_filename(&homework),
                sanitize_filename(&student_id),
                sanitize_filename(&student_name),
                timestamp,
                ext_with_dot
            );

            // 确定存储路径
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

            // 保存文件
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

            // 限制文件大小 32MB
            if file_data.len() > 32 * 1024 * 1024 {
                return HttpResponse::BadRequest()
                    .json(UploadResponse { success: false, message: "文件大小超过限制(32MB)".to_string(), filename: None });
            }

            if let Err(e) = std::fs::write(&full_path, &file_data) {
                log::error!("保存文件失败: {}", e);
                return HttpResponse::InternalServerError()
                    .json(UploadResponse { success: false, message: "保存文件失败".to_string(), filename: None });
            }

            // 记录日志
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
            // 这是普通字段
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

    // 安全检查
    if !is_safe_template_path(&file_path) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    let full_path = state.base_dir.join(&file_path);

    // 验证路径在 templates 目录下
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

    if !abs_full.exists() {
        return HttpResponse::NotFound().json(ApiResponse::error("文件不存在"));
    }

    // 提供文件下载
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

    // 生成令牌
    let token = generate_admin_token();
    let expiry = Local::now() + chrono::Duration::hours(24);
    state.admin_tokens.write().unwrap().insert(token.clone(), expiry);

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
    // 先检查 admin_enabled，然后立即释放读锁，避免后续获取写锁时死锁
    {
        let config = state.config.read().unwrap();
        if !config.admin_enabled {
            return HttpResponse::Forbidden().json(ApiResponse::error("管理员功能未启用"));
        }
    } // 读锁在此释放

    // 验证令牌
    let token = req
        .headers()
        .get("X-Admin-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !state.validate_admin_token(token) {
        return HttpResponse::Unauthorized().json(ApiResponse::error("未授权访问"));
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

            // 更新内存中的配置
            {
                let mut cfg = state.config.write().unwrap();
                cfg.subjects = body.subjects.clone();
            }

            // 保存到文件
            let config = state.config.read().unwrap();
            if let Err(e) = crate::config::save_config(&config, &state.base_dir) {
                return HttpResponse::InternalServerError()
                    .json(ApiResponse::error(&format!("保存配置失败: {}", e)));
            }

            // 重新初始化上传目录
            if let Err(e) = reinit_upload_dirs(&state) {
                return HttpResponse::InternalServerError()
                    .json(ApiResponse::error(&format!("初始化目录失败 {}", e)));
            }

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
    // 先检查 admin_enabled，然后立即释放读锁，避免后续获取写锁时死锁
    {
        let config = state.config.read().unwrap();
        if !config.admin_enabled {
            return HttpResponse::Forbidden().json(ApiResponse::error("管理员功能未启用"));
        }
    } // 读锁在此释放

    // 验证令牌
    let token = req
        .headers()
        .get("X-Admin-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !state.validate_admin_token(token) {
        return HttpResponse::Unauthorized().json(ApiResponse::error("未授权访问"));
    }

    let mut subject = String::new();
    let mut homework = String::new();
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

            // 生成安全的文件名
            let safe_name = sanitize_filename(&fname.replace(&ext_with_dot, "")) + &ext_with_dot;

            // 创建科目目录
            let subject_dir = state.base_dir.join("templates").join(sanitize_filename(&subject));
            if let Err(e) = std::fs::create_dir_all(&subject_dir) {
                log::error!("创建目录失败: {}", e);
                return HttpResponse::InternalServerError().json(ApiResponse::error("创建目录失败"));
            }

            let full_path = subject_dir.join(&safe_name);

            // 读取文件数据
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
            let log_msg = format!("[模板上传] {} 上传成功 路径:{}", fname, tpath);
            if !homework.is_empty() {
                println!("{} (作业: {})", log_msg, homework);
            } else {
                println!("{}", log_msg);
            }

            template_path = Some(tpath);
        } else {
            // 普通字段
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
                "homework" => homework = value_str,
                _ => {}
            }
        }
    }

    match template_path {
        Some(path) => HttpResponse::Ok().json(ApiResponse::with_message(
            "上传成功",
            serde_json::json!({
                "path": path,
            }),
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
    // 先检查 admin_enabled，然后立即释放读锁，避免后续获取写锁时死锁
    {
        let config = state.config.read().unwrap();
        if !config.admin_enabled {
            return HttpResponse::Forbidden().json(ApiResponse::error("管理员功能未启用"));
        }
    } // 读锁在此释放

    // 验证令牌
    let token = req
        .headers()
        .get("X-Admin-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !state.validate_admin_token(token) {
        return HttpResponse::Unauthorized().json(ApiResponse::error("未授权访问"));
    }

    // 安全检查
    if !is_safe_template_path(&body.path) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    let full_path = state.base_dir.join(&body.path);

    // 验证路径在 templates 目录下
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
        Ok(_) => HttpResponse::Ok().json(ApiResponse::with_message("文件已删除", serde_json::json!({}))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            HttpResponse::Ok().json(ApiResponse::with_message("文件已删除", serde_json::json!({})))
        }
        Err(e) => {
            log::error!("删除文件失败: {}", e);
            HttpResponse::InternalServerError().json(ApiResponse::error("删除文件失败"))
        }
    }
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