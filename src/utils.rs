use std::path::Path;

/// 允许上传的文件扩展名白名单
pub fn is_allowed_file_type(ext: &str) -> bool {
    let ext = ext.to_lowercase();
    matches!(
        ext.as_str(),
        // 文档类
        ".doc" | ".docx" | ".pdf" | ".txt"
        | ".xls" | ".xlsx" | ".ppt" | ".pptx"
        | ".odt" | ".ods" | ".odp" | ".rtf"
        // 图片类
        | ".jpg" | ".jpeg" | ".png" | ".gif"
        | ".bmp" | ".webp" | ".svg"
        // 压缩类
        | ".zip" | ".rar" | ".7z" | ".tar" | ".gz"
        // 代码/文本
        | ".c" | ".cpp" | ".h" | ".java" | ".py"
        | ".js" | ".html" | ".css" | ".json" | ".xml"
        | ".md" | ".go" | ".rs" | ".ts"
    )
}

/// 过滤文件名中的危险字符，防止路径遍历攻击
/// 只允许字母、数字、下划线、连字符和中文字符
pub fn sanitize_filename(name: &str) -> String {
    let result: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect();

    if result.is_empty() {
        "unnamed".to_string()
    } else {
        result
    }
}

/// 验证模板路径是否安全（防止路径遍历）
pub fn is_safe_template_path(path: &str) -> bool {
    let cleaned = Path::new(path);

    // 检查是否包含 ..
    for component in cleaned.components() {
        if let std::path::Component::ParentDir = component {
            return false;
        }
    }

    // 确保路径以 templates/ 开头
    let path_str = path.replace('\\', "/");
    path_str.starts_with("templates/")
}

/// 写入日志文件
pub fn write_log(base_dir: &Path, message: &str) {
    let log_dir = base_dir.join("logs");
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        log::error!("创建日志目录失败: {}", e);
        return;
    }

    let log_file = log_dir.join("cums.log");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&log_file)
    {
        let _ = writeln!(f, "{}", message);
    }
}

/// 获取客户端 IP
pub fn get_client_ip(req: &actix_web::HttpRequest) -> String {
    // 优先检查 X-Forwarded-For
    if let Some(xff) = req.headers().get("X-Forwarded-For") {
        if let Ok(val) = xff.to_str() {
            if let Some(ip) = val.split(',').next() {
                return ip.trim().to_string();
            }
        }
    }

    // 检查 X-Real-IP
    if let Some(xri) = req.headers().get("X-Real-IP") {
        if let Ok(val) = xri.to_str() {
            return val.trim().to_string();
        }
    }

    // 从连接信息获取
    req.peer_addr()
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// 获取本机局域网 IP
pub fn get_local_ip() -> String {
    // 简单方式：尝试连接一个外部地址来获取本机 IP
    use std::net::UdpSocket;
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "localhost".to_string()
}

/// 生成管理员令牌
pub fn generate_admin_token() -> String {
    format!("admin_{}", uuid::Uuid::new_v4())
}

/// 检测端口是否可用
pub fn is_port_available(port: u16) -> bool {
    use std::net::TcpListener;
    TcpListener::bind(("0.0.0.0", port)).is_ok()
}