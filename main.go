package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

// ==================== 数据结构 ====================

// Config 系统配置
type Config struct {
	Version       string                   `json:"version"`
	ServerAddr    string                   `json:"server_addr"`
	AdminEnabled  bool                     `json:"admin_enabled"`
	AdminPassword string                   `json:"admin_password"`
	Subjects      map[string]SubjectConfig `json:"subjects"`
}

// SubjectConfig 科目配置
type SubjectConfig struct {
	Classes   []string `json:"classes"`
	Homeworks []string `json:"homeworks"`
}

// LoginRequest 登录请求
type LoginRequest struct {
	Class       string `json:"class"`
	StudentID   string `json:"student_id"`
	StudentName string `json:"student_name"`
}

// APIResponse 通用API响应
type APIResponse struct {
	Success bool        `json:"success"`
	Message string      `json:"message,omitempty"`
	Data    interface{} `json:"data,omitempty"`
}

// UploadResponse 上传响应
type UploadResponse struct {
	Success  bool   `json:"success"`
	Message  string `json:"message"`
	Filename string `json:"filename,omitempty"`
}

// VersionResponse 版本响应
type VersionResponse struct {
	Success bool   `json:"success"`
	Version string `json:"version"`
}

// AdminLoginRequest 管理员登录请求
type AdminLoginRequest struct {
	Password string `json:"password"`
}

// AdminLoginResponse 管理员登录响应
type AdminLoginResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Token   string `json:"token,omitempty"`
}

// AdminConfigRequest 管理员配置更新请求
type AdminConfigRequest struct {
	Subjects map[string]SubjectConfig `json:"subjects"`
}

// ==================== 全局变量 ====================

var (
	config      Config
	baseDir     string                       // 程序所在目录
	uploadDir   string                       // 上传目录
	adminTokens = make(map[string]time.Time) // 管理员会话令牌
)

// init 包初始化函数，启动令牌清理协程
func init() {
	// 启动定期清理过期令牌的协程
	go cleanExpiredTokens()
}

// cleanExpiredTokens 定期清理过期的管理员令牌，防止内存泄漏
func cleanExpiredTokens() {
	ticker := time.NewTicker(1 * time.Hour)
	for range ticker.C {
		now := time.Now()
		for token, expiry := range adminTokens {
			if now.After(expiry) {
				delete(adminTokens, token)
			}
		}
	}
}

// ==================== 初始化函数 ====================

// getBaseDir 获取程序所在目录
func getBaseDir() string {
	// 如果当前目录有 go.mod，说明是开发环境，使用当前目录
	if _, err := os.Stat("go.mod"); err == nil {
		return "."
	}

	// 生产环境：使用可执行文件所在目录
	exePath, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exePath)
}

// initDirs 初始化目录
func initDirs() error {
	baseDir = getBaseDir()
	uploadDir = filepath.Join(baseDir, "uploads")

	// 创建必要的目录
	dirs := []string{
		filepath.Join(baseDir, "logs"),
		uploadDir,
	}

	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("创建目录失败 %s: %w", dir, err)
		}
	}

	return nil
}

// loadConfig 加载配置文件
func loadConfig() error {
	configPath := filepath.Join(baseDir, "config.json")

	data, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("配置文件不存在: %s\n请确保 config.json 与程序在同一目录", configPath)
	}

	if err := json.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("解析配置文件失败: %w", err)
	}

	// 检查版本号是否存在
	if config.Version == "" {
		return fmt.Errorf("配置文件缺少版本号 (version)")
	}

	return nil
}

// initUploadDirs 初始化上传目录结构
func initUploadDirs() error {
	for subject, subConfig := range config.Subjects {
		for _, class := range subConfig.Classes {
			for _, hw := range subConfig.Homeworks {
				dir := filepath.Join(uploadDir, subject, class, hw)
				if err := os.MkdirAll(dir, 0755); err != nil {
					return fmt.Errorf("创建目录失败 %s: %w", dir, err)
				}
			}
		}
	}
	return nil
}

// ==================== HTTP 处理器 ====================

// loginHandler 处理登录请求
func loginHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonResponseWithStatus(w, http.StatusMethodNotAllowed, APIResponse{Success: false, Message: "请求方法错误"})
		return
	}

	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "请求格式错误"})
		return
	}

	// 验证班级是否存在
	classExists := false
	for _, subConfig := range config.Subjects {
		for _, class := range subConfig.Classes {
			if class == req.Class {
				classExists = true
				break
			}
		}
		if classExists {
			break
		}
	}

	if !classExists {
		jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "班级不存在"})
		return
	}

	if req.StudentID == "" || req.StudentName == "" {
		jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "学号和姓名不能为空"})
		return
	}

	jsonResponse(w, APIResponse{
		Success: true,
		Message: "登录成功",
		Data: map[string]string{
			"class":        req.Class,
			"student_id":   req.StudentID,
			"student_name": req.StudentName,
		},
	})
}

// configHandler 返回配置信息
func configHandler(w http.ResponseWriter, r *http.Request) {
	// 只允许 GET 方法
	if r.Method != http.MethodGet {
		jsonResponseWithStatus(w, http.StatusMethodNotAllowed, APIResponse{Success: false, Message: "请求方法错误"})
		return
	}
	jsonResponse(w, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"subjects": config.Subjects,
		},
	})
}

// uploadHandler 处理文件上传
func uploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonResponseWithStatus(w, http.StatusMethodNotAllowed, UploadResponse{Success: false, Message: "请求方法错误"})
		return
	}

	// 解析表单
	if err := r.ParseMultipartForm(32 << 20); err != nil { // 32MB
		jsonResponseWithStatus(w, http.StatusBadRequest, UploadResponse{Success: false, Message: "解析请求失败"})
		return
	}

	// 获取参数
	class := r.FormValue("class")
	studentID := r.FormValue("student_id")
	studentName := r.FormValue("student_name")
	subject := r.FormValue("subject")
	homework := r.FormValue("homework")

	// 验证参数
	if class == "" || studentID == "" || studentName == "" || subject == "" || homework == "" {
		jsonResponseWithStatus(w, http.StatusBadRequest, UploadResponse{Success: false, Message: "缺少必要参数"})
		return
	}

	// 验证科目
	subConfig, exists := config.Subjects[subject]
	if !exists {
		jsonResponseWithStatus(w, http.StatusBadRequest, UploadResponse{Success: false, Message: "科目不存在"})
		return
	}

	// 验证班级是否属于该科目
	classInSubject := false
	for _, c := range subConfig.Classes {
		if c == class {
			classInSubject = true
			break
		}
	}
	if !classInSubject {
		jsonResponseWithStatus(w, http.StatusBadRequest, UploadResponse{Success: false, Message: "该班级没有此科目"})
		return
	}

	// 验证作业
	homeworkExists := false
	for _, hw := range subConfig.Homeworks {
		if hw == homework {
			homeworkExists = true
			break
		}
	}
	if !homeworkExists {
		jsonResponseWithStatus(w, http.StatusBadRequest, UploadResponse{Success: false, Message: "作业不存在"})
		return
	}

	// 获取文件
	file, header, err := r.FormFile("file")
	if err != nil {
		jsonResponseWithStatus(w, http.StatusBadRequest, UploadResponse{Success: false, Message: "请选择要上传的文件"})
		return
	}
	defer file.Close()

	// 验证文件类型（白名单）
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !isAllowedFileType(ext) {
		jsonResponseWithStatus(w, http.StatusBadRequest, UploadResponse{Success: false, Message: "不支持的文件类型"})
		return
	}

	// 生成文件名（使用过滤后的安全文件名）
	timestamp := time.Now().Format("20060102150405")
	filename := fmt.Sprintf("%s_%s_%s_%s%s",
		sanitizeFilename(homework),
		sanitizeFilename(studentID),
		sanitizeFilename(studentName),
		timestamp, ext)

	// 确定存储路径（使用过滤后的安全路径）
	savePath := filepath.Join(uploadDir,
		sanitizeFilename(subject),
		sanitizeFilename(class),
		sanitizeFilename(homework))
	if err := os.MkdirAll(savePath, 0755); err != nil {
		jsonResponseWithStatus(w, http.StatusInternalServerError, UploadResponse{Success: false, Message: "创建目录失败"})
		return
	}

	// 保存文件
	fullPath := filepath.Join(savePath, filename)
	dst, err := os.Create(fullPath)
	if err != nil {
		jsonResponseWithStatus(w, http.StatusInternalServerError, UploadResponse{Success: false, Message: "创建文件失败"})
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		jsonResponseWithStatus(w, http.StatusInternalServerError, UploadResponse{Success: false, Message: "保存文件失败"})
		return
	}

	// 记录日志
	clientIP := getClientIP(r)
	clientHostname := getClientHostname(clientIP)
	logMsg := fmt.Sprintf("[%s] %s %s号%s 提交 %s-%s IP:%s 主机名:%s",
		time.Now().Format("2006-01-02 15:04:05"),
		class, studentID, studentName, subject, homework, clientIP, clientHostname)
	fmt.Println(logMsg)
	writeLog(logMsg)

	jsonResponse(w, UploadResponse{
		Success:  true,
		Message:  "上传成功",
		Filename: filename,
	})
}

// versionHandler 返回版本信息
func versionHandler(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, VersionResponse{Success: true, Version: config.Version})
}

// changelogHandler 返回更新日志
func changelogHandler(w http.ResponseWriter, r *http.Request) {
	// 从嵌入的文件系统读取 CHANGELOG.md
	content, err := changelog.ReadFile("CHANGELOG.md")
	if err != nil {
		jsonResponse(w, APIResponse{Success: false, Message: "无法读取更新日志"})
		return
	}
	jsonResponse(w, APIResponse{
		Success: true,
		Data: map[string]string{
			"content": string(content),
		},
	})
}

// staticHandler 返回静态文件
func staticHandler(w http.ResponseWriter, r *http.Request) {
	// 只处理根路径，其他路径由专门的处理器处理
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	staticFile := filepath.Join(baseDir, "static", "index.html")

	if _, err := os.Stat(staticFile); os.IsNotExist(err) {
		http.Error(w, "静态文件不存在，请确保 static/index.html 与程序在同一目录", http.StatusNotFound)
		return
	}

	http.ServeFile(w, r, staticFile)
}

// adminPageHandler 返回管理员页面
func adminPageHandler(w http.ResponseWriter, r *http.Request) {
	if !config.AdminEnabled {
		http.Error(w, "管理员功能未启用", http.StatusForbidden)
		return
	}

	adminFile := filepath.Join(baseDir, "static", "admin.html")

	if _, err := os.Stat(adminFile); os.IsNotExist(err) {
		http.Error(w, "管理员页面不存在", http.StatusNotFound)
		return
	}

	http.ServeFile(w, r, adminFile)
}

// adminLoginHandler 处理管理员登录
func adminLoginHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonResponseWithStatus(w, http.StatusMethodNotAllowed, AdminLoginResponse{Success: false, Message: "请求方法错误"})
		return
	}

	if !config.AdminEnabled {
		jsonResponseWithStatus(w, http.StatusForbidden, AdminLoginResponse{Success: false, Message: "管理员功能未启用"})
		return
	}

	var req AdminLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponseWithStatus(w, http.StatusBadRequest, AdminLoginResponse{Success: false, Message: "请求格式错误"})
		return
	}

	if req.Password != config.AdminPassword {
		jsonResponseWithStatus(w, http.StatusUnauthorized, AdminLoginResponse{Success: false, Message: "密码错误"})
		return
	}

	// 生成令牌
	token := generateAdminToken()
	adminTokens[token] = time.Now().Add(24 * time.Hour) // 24小时有效

	jsonResponse(w, AdminLoginResponse{
		Success: true,
		Message: "登录成功",
		Token:   token,
	})
}

// adminConfigHandler 获取/更新管理员配置
func adminConfigHandler(w http.ResponseWriter, r *http.Request) {
	if !config.AdminEnabled {
		jsonResponseWithStatus(w, http.StatusForbidden, APIResponse{Success: false, Message: "管理员功能未启用"})
		return
	}

	// 验证令牌
	token := r.Header.Get("X-Admin-Token")
	if !validateAdminToken(token) {
		jsonResponseWithStatus(w, http.StatusUnauthorized, APIResponse{Success: false, Message: "未授权访问"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		// 返回当前配置
		jsonResponse(w, APIResponse{
			Success: true,
			Data: map[string]interface{}{
				"subjects": config.Subjects,
			},
		})
	case http.MethodPost:
		// 更新配置
		var req AdminConfigRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "请求格式错误"})
			return
		}

		// 更新内存中的配置
		config.Subjects = req.Subjects

		// 保存到文件
		if err := saveConfig(); err != nil {
			jsonResponseWithStatus(w, http.StatusInternalServerError, APIResponse{Success: false, Message: "保存配置失败: " + err.Error()})
			return
		}

		// 重新初始化上传目录
		if err := initUploadDirs(); err != nil {
			jsonResponseWithStatus(w, http.StatusInternalServerError, APIResponse{Success: false, Message: "初始化目录失败: " + err.Error()})
			return
		}

		jsonResponse(w, APIResponse{Success: true, Message: "配置已更新"})
	default:
		jsonResponseWithStatus(w, http.StatusMethodNotAllowed, APIResponse{Success: false, Message: "请求方法错误"})
	}
}

// generateAdminToken 生成安全的管理员令牌
func generateAdminToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// 降级使用时间戳（不推荐，仅作为备用）
		return fmt.Sprintf("admin_%d", time.Now().UnixNano())
	}
	return "admin_" + hex.EncodeToString(b)
}

// validateAdminToken 验证管理员令牌
func validateAdminToken(token string) bool {
	if token == "" {
		return false
	}
	expiry, exists := adminTokens[token]
	if !exists {
		return false
	}
	if time.Now().After(expiry) {
		delete(adminTokens, token)
		return false
	}
	return true
}

// saveConfig 保存配置到文件
func saveConfig() error {
	configPath := filepath.Join(baseDir, "config.json")

	data, err := json.MarshalIndent(config, "", "    ")
	if err != nil {
		return fmt.Errorf("序列化配置失败: %w", err)
	}

	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("写入配置文件失败: %w", err)
	}

	return nil
}

// ==================== 工具函数 ====================

// sanitizeFilename 过滤文件名中的危险字符，防止路径遍历攻击
// 严格模式：只允许字母、数字、下划线、连字符和中文字符
func sanitizeFilename(name string) string {
	var result strings.Builder
	for _, r := range name {
		// 允许：字母、数字、下划线、连字符、中文字符
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' {
			result.WriteRune(r)
		}
	}
	// 如果过滤后为空，返回默认值
	if result.Len() == 0 {
		return "unnamed"
	}
	return result.String()
}

// allowedExtensions 允许上传的文件扩展名白名单
var allowedExtensions = map[string]bool{
	// 文档类
	".doc": true, ".docx": true, ".pdf": true, ".txt": true,
	".xls": true, ".xlsx": true, ".ppt": true, ".pptx": true,
	".odt": true, ".ods": true, ".odp": true, ".rtf": true,
	// 图片类
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true,
	".bmp": true, ".webp": true, ".svg": true,
	// 压缩包
	".zip": true, ".rar": true, ".7z": true, ".tar": true, ".gz": true,
	// 代码/文本
	".c": true, ".cpp": true, ".h": true, ".java": true, ".py": true,
	".js": true, ".html": true, ".css": true, ".json": true, ".xml": true,
	".md": true, ".go": true, ".rs": true, ".ts": true,
}

// isAllowedFileType 检查文件扩展名是否在白名单中
func isAllowedFileType(ext string) bool {
	return allowedExtensions[ext]
}

// jsonResponse 发送JSON响应
func jsonResponse(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err := json.NewEncoder(w).Encode(data); err != nil {
		// 记录编码错误到日志
		writeLog(fmt.Sprintf("[ERROR] JSON编码失败: %v", err))
	}
}

// jsonResponseWithStatus 发送带状态码的JSON响应
func jsonResponseWithStatus(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		writeLog(fmt.Sprintf("[ERROR] JSON编码失败: %v", err))
	}
}

// getClientIP 获取客户端IP
func getClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if idx := strings.Index(xff, ","); idx != -1 {
			return strings.TrimSpace(xff[:idx])
		}
		return xff
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

// getClientHostname 获取客户端主机名（通过反向DNS查询）
func getClientHostname(ip string) string {
	// 尝试反向DNS查询
	names, err := net.LookupAddr(ip)
	if err != nil || len(names) == 0 {
		return "未知主机"
	}
	// 返回第一个主机名，去掉末尾的点
	return strings.TrimSuffix(names[0], ".")
}

// getLocalIP 获取本机局域网IP
func getLocalIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "localhost"
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				return ipnet.IP.String()
			}
		}
	}
	return "localhost"
}

// writeLog 写入日志文件
func writeLog(message string) {
	logFile := filepath.Join(baseDir, "logs", "cums.log")
	f, err := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	f.WriteString(message + "\n")
}

// ==================== 主函数 ====================

func main() {
	fmt.Println()
	fmt.Println("╔════════════════════════════════════════════════════════════╗")
	fmt.Println("║           CUMS - 课堂文件上传管理系统                      ║")
	fmt.Println("╚════════════════════════════════════════════════════════════╝")
	fmt.Println()

	// 初始化目录
	if err := initDirs(); err != nil {
		fmt.Printf("❌ 初始化目录失败: %v\n", err)
		os.Exit(1)
	}

	// 加载配置
	if err := loadConfig(); err != nil {
		fmt.Printf("❌ 错误: %v\n", err)
		os.Exit(1)
	}

	// 初始化上传目录
	if err := initUploadDirs(); err != nil {
		fmt.Printf("❌ 初始化上传目录失败: %v\n", err)
		os.Exit(1)
	}

	// 注册路由
	http.HandleFunc("/", staticHandler)
	http.HandleFunc("/admin", adminPageHandler)
	http.HandleFunc("/api/v1/login", loginHandler)
	http.HandleFunc("/api/v1/config", configHandler)
	http.HandleFunc("/api/v1/upload", uploadHandler)
	http.HandleFunc("/api/v1/version", versionHandler)
	http.HandleFunc("/api/v1/changelog", changelogHandler)
	http.HandleFunc("/api/v1/admin/login", adminLoginHandler)
	http.HandleFunc("/api/v1/admin/config", adminConfigHandler)

	// 启动服务器
	addr := config.ServerAddr
	if addr == "" {
		addr = ":3000"
	}
	localIP := getLocalIP()

	// 显示系统信息
	fmt.Println("📋 系统信息")
	fmt.Println("────────────────────────────────────────")
	fmt.Printf("   版本: %s\n", config.Version)
	fmt.Printf("   配置: %s\n", filepath.Join(baseDir, "config.json"))
	fmt.Printf("   上传: %s\n", uploadDir)
	fmt.Printf("   日志: %s\n", filepath.Join(baseDir, "logs", "cums.log"))
	fmt.Println()

	// 显示科目信息
	fmt.Println("📚 已配置科目")
	fmt.Println("────────────────────────────────────────")
	for name, sub := range config.Subjects {
		fmt.Printf("   • %s (%d个班级, %d个作业)\n", name, len(sub.Classes), len(sub.Homeworks))
	}
	fmt.Println()

	// 显示访问地址
	fmt.Println("🌐 访问地址")
	fmt.Println("────────────────────────────────────────")
	fmt.Printf("   学生端:   http://localhost%s\n", addr)
	fmt.Printf("   局域网:   http://%s%s\n", localIP, addr)
	fmt.Println()

	// 显示管理后台信息
	fmt.Println("🔧 管理后台")
	fmt.Println("────────────────────────────────────────")
	if config.AdminEnabled {
		fmt.Printf("   状态:     ✅ 已启用\n")
		fmt.Printf("   地址:     http://localhost%s/admin\n", addr)
		fmt.Printf("   密码:     %s\n", maskPassword(config.AdminPassword))
	} else {
		fmt.Printf("   状态:     ❌ 未启用\n")
		fmt.Println("   开启方法: 编辑 config.json，设置以下参数：")
		fmt.Println("            \"admin_enabled\": true")
		fmt.Println("            \"admin_password\": \"你的密码\"")
	}
	fmt.Println()

	// 使用说明
	fmt.Println("📖 使用说明")
	fmt.Println("────────────────────────────────────────")
	fmt.Println("   1. 学生访问上方地址，登录后上传作业")
	fmt.Println("   2. 文件保存在 uploads/科目/班级/作业/ 目录")
	fmt.Println("   3. 通过管理后台可添加科目、班级、作业")
	fmt.Println("   4. 修改 config.json 后需重启程序生效")
	fmt.Println()

	fmt.Println("════════════════════════════════════════════════════════════")
	fmt.Println("🚀 服务器已启动，按 Ctrl+C 停止")
	fmt.Println("════════════════════════════════════════════════════════════")
	fmt.Println()

	if err := http.ListenAndServe("0.0.0.0"+addr, nil); err != nil {
		fmt.Printf("❌ 启动服务器失败: %v\n", err)
		os.Exit(1)
	}
}

// maskPassword 隐藏密码中间部分
func maskPassword(password string) string {
	if len(password) <= 4 {
		return "****"
	}
	return password[:2] + strings.Repeat("*", len(password)-4) + password[len(password)-2:]
}
