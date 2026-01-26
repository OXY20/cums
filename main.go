package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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

// HomeworkConfig 作业配置（扩展结构）
type HomeworkConfig struct {
	Name        string   `json:"name"`                  // 作业名称（必填）
	Description string   `json:"description,omitempty"` // 作业说明
	Templates   []string `json:"templates,omitempty"`   // 模板文件列表（支持多个）
}

// SubjectConfig 科目配置
type SubjectConfig struct {
	Classes   []string          `json:"classes"`
	Homeworks json.RawMessage   `json:"homeworks"` // 支持字符串数组或对象数组
}

// SubjectConfigParsed 解析后的科目配置（用于返回给前端�?
type SubjectConfigParsed struct {
	Classes   []string         `json:"classes"`
	Homeworks []HomeworkConfig `json:"homeworks"`
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

// AdminLoginRequest 管理员登录请�?
type AdminLoginRequest struct {
	Password string `json:"password"`
}

// AdminLoginResponse 管理员登录响�?
type AdminLoginResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Token   string `json:"token,omitempty"`
}

// AdminConfigRequest 管理员配置更新请�?
type AdminConfigRequest struct {
	Subjects map[string]SubjectConfig `json:"subjects"`
}

// ==================== 全局变量 ====================

var (
	config      Config
	baseDir     string                       // 程序所在目�?
	uploadDir   string                       // 上传目录
	adminTokens = make(map[string]time.Time) // 管理员会话令�?
)

// init 包初始化函数，启动令牌清理协�?
func init() {
	// 启动定期清理过期令牌的协�?
	go cleanExpiredTokens()
}

// cleanExpiredTokens 定期清理过期的管理员令牌，防止内存泄�?
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

// ==================== 初始化函�?====================

// getBaseDir 获取程序所在目�?
func getBaseDir() string {
	// 如果当前目录�?go.mod，说明是开发环境，使用当前目录
	if _, err := os.Stat("go.mod"); err == nil {
		return "."
	}

	// 生产环境：使用可执行文件所在目�?
	exePath, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exePath)
}

// initDirs 初始化目�?
func initDirs() error {
	baseDir = getBaseDir()
	uploadDir = filepath.Join(baseDir, "uploads")

	// 创建必要的目�?
	dirs := []string{
		filepath.Join(baseDir, "logs"),
		filepath.Join(baseDir, "templates"), // 模板文件目录
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
		return fmt.Errorf("配置文件不存�? %s\n请确�?config.json 与程序在同一目录", configPath)
	}

	if err := json.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("解析配置文件失败: %w", err)
	}

	// 检查版本号是否存在
	if config.Version == "" {
		return fmt.Errorf("配置文件缺少版本�?(version)")
	}

	return nil
}

// initUploadDirs 初始化上传目录结�?
func initUploadDirs() error {
	for subject, subConfig := range config.Subjects {
		homeworks := parseHomeworks(subConfig.Homeworks)
		for _, class := range subConfig.Classes {
			for _, hw := range homeworks {
				dir := filepath.Join(uploadDir, subject, class, hw.Name)
				if err := os.MkdirAll(dir, 0755); err != nil {
					return fmt.Errorf("创建目录失败 %s: %w", dir, err)
				}
			}
		}
	}
	return nil
}

// parseHomeworks 解析作业配置，支持字符串数组和对象数组混合格�?
func parseHomeworks(raw json.RawMessage) []HomeworkConfig {
	if raw == nil || len(raw) == 0 {
		return []HomeworkConfig{}
	}

	// 首先尝试解析为字符串数组（旧格式�?
	var strArray []string
	if err := json.Unmarshal(raw, &strArray); err == nil {
		result := make([]HomeworkConfig, len(strArray))
		for i, name := range strArray {
			result[i] = HomeworkConfig{Name: name}
		}
		return result
	}

	// 尝试解析为混合数组（字符串和对象混合�?
	var mixedArray []json.RawMessage
	if err := json.Unmarshal(raw, &mixedArray); err == nil {
		result := make([]HomeworkConfig, 0, len(mixedArray))
		for _, item := range mixedArray {
			// 尝试作为字符串解�?
			var strVal string
			if err := json.Unmarshal(item, &strVal); err == nil {
				result = append(result, HomeworkConfig{Name: strVal})
				continue
			}
			// 尝试作为对象解析
			var hwConfig HomeworkConfig
			if err := json.Unmarshal(item, &hwConfig); err == nil {
				result = append(result, hwConfig)
			}
		}
		return result
	}

	return []HomeworkConfig{}
}

// getHomeworkName 从作业配置中获取作业名称
func getHomeworkName(hw HomeworkConfig) string {
	return hw.Name
}

// findHomework 查找作业配置
func findHomework(homeworks []HomeworkConfig, name string) *HomeworkConfig {
	for i := range homeworks {
		if homeworks[i].Name == name {
			return &homeworks[i]
		}
	}
	return nil
}

// getParsedSubjects 获取解析后的科目配置
func getParsedSubjects() map[string]SubjectConfigParsed {
	result := make(map[string]SubjectConfigParsed)
	for name, subConfig := range config.Subjects {
		result[name] = SubjectConfigParsed{
			Classes:   subConfig.Classes,
			Homeworks: parseHomeworks(subConfig.Homeworks),
		}
	}
	return result
}

// ==================== HTTP 处理�?====================

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
		jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "班级不存�?})
		return
	}

	if req.StudentID == "" || req.StudentName == "" {
		jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "学号和姓名不能为�?})
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
	// 只允�?GET 方法
	if r.Method != http.MethodGet {
		jsonResponseWithStatus(w, http.StatusMethodNotAllowed, APIResponse{Success: false, Message: "请求方法错误"})
		return
	}
	// 返回解析后的配置（统一格式�?
	jsonResponse(w, APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"subjects": getParsedSubjects(),
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
		jsonResponseWithStatus(w, http.StatusBadRequest, UploadResponse{Success: false, Message: "科目不存�?})
		return
	}

	// 验证班级是否属于该科�?
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
	homeworks := parseHomeworks(subConfig.Homeworks)
	homeworkExists := false
	for _, hw := range homeworks {
		if hw.Name == homework {
			homeworkExists = true
			break
		}
	}
	if !homeworkExists {
		jsonResponseWithStatus(w, http.StatusBadRequest, UploadResponse{Success: false, Message: "作业不存�?})
		return
	}

	// 获取文件
	file, header, err := r.FormFile("file")
	if err != nil {
		jsonResponseWithStatus(w, http.StatusBadRequest, UploadResponse{Success: false, Message: "请选择要上传的文件"})
		return
	}
	defer file.Close()

	// 验证文件类型（白名单�?
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
	logMsg := fmt.Sprintf("[%s] %s %s�?s 提交 %s-%s IP:%s 主机�?%s",
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

// staticHandler 返回静态文�?
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

// adminPageHandler 返回管理员页�?
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

// adminLoginHandler 处理管理员登�?
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

// adminConfigHandler 获取/更新管理员配�?
func adminConfigHandler(w http.ResponseWriter, r *http.Request) {
	if !config.AdminEnabled {
		jsonResponseWithStatus(w, http.StatusForbidden, APIResponse{Success: false, Message: "管理员功能未启用"})
		return
	}

	// 验证令牌
	token := r.Header.Get("X-Admin-Token")
	if !validateAdminToken(token) {
		jsonResponseWithStatus(w, http.StatusUnauthorized, APIResponse{Success: false, Message: "未授权访�?})
		return
	}

	switch r.Method {
	case http.MethodGet:
		// 返回解析后的配置
		jsonResponse(w, APIResponse{
			Success: true,
			Data: map[string]interface{}{
				"subjects": getParsedSubjects(),
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

		// 保存到文�?
		if err := saveConfig(); err != nil {
			jsonResponseWithStatus(w, http.StatusInternalServerError, APIResponse{Success: false, Message: "保存配置失败: " + err.Error()})
			return
		}

		// 重新初始化上传目�?
		if err := initUploadDirs(); err != nil {
			jsonResponseWithStatus(w, http.StatusInternalServerError, APIResponse{Success: false, Message: "初始化目录失�? " + err.Error()})
			return
		}

		jsonResponse(w, APIResponse{Success: true, Message: "配置已更�?})
	default:
		jsonResponseWithStatus(w, http.StatusMethodNotAllowed, APIResponse{Success: false, Message: "请求方法错误"})
	}
}

// templateHandler 处理模板文件下载
func templateHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonResponseWithStatus(w, http.StatusMethodNotAllowed, APIResponse{Success: false, Message: "请求方法错误"})
		return
	}

	// 获取文件路径参数
	filePath := r.URL.Query().Get("file")
	if filePath == "" {
		jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "缺少文件参数"})
		return
	}

	// 安全检查：防止路径遍历攻击
	// 清理路径
	cleanPath := filepath.Clean(filePath)

	// 检查是否包含路径遍�?
	if strings.Contains(cleanPath, "..") {
		jsonResponseWithStatus(w, http.StatusForbidden, APIResponse{Success: false, Message: "非法路径"})
		return
	}

	// 确保文件�?templates 目录�?
	if !strings.HasPrefix(cleanPath, "templates/") && !strings.HasPrefix(cleanPath, "templates\\") {
		jsonResponseWithStatus(w, http.StatusForbidden, APIResponse{Success: false, Message: "非法路径"})
		return
	}

	// 构建完整路径
	fullPath := filepath.Join(baseDir, cleanPath)

	// 再次验证路径在允许的目录�?
	templatesDir := filepath.Join(baseDir, "templates")
	absFullPath, err := filepath.Abs(fullPath)
	if err != nil {
		jsonResponseWithStatus(w, http.StatusInternalServerError, APIResponse{Success: false, Message: "路径解析失败"})
		return
	}
	absTemplatesDir, err := filepath.Abs(templatesDir)
	if err != nil {
		jsonResponseWithStatus(w, http.StatusInternalServerError, APIResponse{Success: false, Message: "路径解析失败"})
		return
	}
	if !strings.HasPrefix(absFullPath, absTemplatesDir) {
		jsonResponseWithStatus(w, http.StatusForbidden, APIResponse{Success: false, Message: "非法路径"})
		return
	}

	// 检查文件是否存�?
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonResponseWithStatus(w, http.StatusNotFound, APIResponse{Success: false, Message: "文件不存�?})
		return
	}

	// 提取文件名并设置下载响应�?
	filename := filepath.Base(fullPath)
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(filename))
	w.Header().Set("Content-Type", "application/octet-stream")

	// 提供文件下载
	http.ServeFile(w, r, fullPath)
}

// templateUploadHandler 处理模板文件上传（管理端�?
func templateUploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonResponseWithStatus(w, http.StatusMethodNotAllowed, APIResponse{Success: false, Message: "请求方法错误"})
		return
	}

	if !config.AdminEnabled {
		jsonResponseWithStatus(w, http.StatusForbidden, APIResponse{Success: false, Message: "管理员功能未启用"})
		return
	}

	// 验证令牌
	token := r.Header.Get("X-Admin-Token")
	if !validateAdminToken(token) {
		jsonResponseWithStatus(w, http.StatusUnauthorized, APIResponse{Success: false, Message: "未授权访�?})
		return
	}

	// 解析表单（最�?32MB�?
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "解析请求失败"})
		return
	}

	// 获取文件
	file, header, err := r.FormFile("file")
	if err != nil {
		jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "请选择要上传的文件"})
		return
	}
	defer file.Close()

	// 获取科目和作业名�?
	subject := r.FormValue("subject")
	homework := r.FormValue("homework")

	if subject == "" {
		jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "缺少科目参数"})
		return
	}

	// 验证文件类型
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !isAllowedFileType(ext) {
		jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "不支持的文件类型"})
		return
	}

	// 生成安全的文件名
	safeFilename := sanitizeFilename(strings.TrimSuffix(header.Filename, ext)) + ext

	// 创建按科目组织的目录结构：templates/科目�?
	subjectDir := filepath.Join(baseDir, "templates", subject)
	if err := os.MkdirAll(subjectDir, 0755); err != nil {
		jsonResponseWithStatus(w, http.StatusInternalServerError, APIResponse{Success: false, Message: "创建目录失败"})
		return
	}

	// 保存文件到科目目�?
	fullPath := filepath.Join(subjectDir, safeFilename)
	dst, err := os.Create(fullPath)
	if err != nil {
		jsonResponseWithStatus(w, http.StatusInternalServerError, APIResponse{Success: false, Message: "创建文件失败"})
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		jsonResponseWithStatus(w, http.StatusInternalServerError, APIResponse{Success: false, Message: "保存文件失败"})
		return
	}

	// 返回模板路径（包含科目目录）
	templatePath := "templates/" + subject + "/" + safeFilename

	// 添加日志输出（包含科目和作业信息�?
	logMsg := fmt.Sprintf("[模板上传] %s 上传成功 �?%s", header.Filename, templatePath)
	if homework != "" {
		logMsg += fmt.Sprintf(" (作业: %s)", homework)
	}
	fmt.Println(logMsg)

	jsonResponse(w, APIResponse{
		Success: true,
		Message: "上传成功",
		Data: map[string]string{
			"path":     templatePath,
			"filename": safeFilename,
		},
	})
}

// templateDeleteHandler 处理模板文件删除（管理端�?
func templateDeleteHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonResponseWithStatus(w, http.StatusMethodNotAllowed, APIResponse{Success: false, Message: "请求方法错误"})
		return
	}

	if !config.AdminEnabled {
		jsonResponseWithStatus(w, http.StatusForbidden, APIResponse{Success: false, Message: "管理员功能未启用"})
		return
	}

	// 验证令牌
	token := r.Header.Get("X-Admin-Token")
	if !validateAdminToken(token) {
		jsonResponseWithStatus(w, http.StatusUnauthorized, APIResponse{Success: false, Message: "未授权访�?})
		return
	}

	// 解析请求
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponseWithStatus(w, http.StatusBadRequest, APIResponse{Success: false, Message: "请求格式错误"})
		return
	}

	// 安全检�?
	cleanPath := filepath.Clean(req.Path)
	if strings.Contains(cleanPath, "..") || (!strings.HasPrefix(cleanPath, "templates/") && !strings.HasPrefix(cleanPath, "templates\\")) {
		jsonResponseWithStatus(w, http.StatusForbidden, APIResponse{Success: false, Message: "非法路径"})
		return
	}

	// 构建完整路径并验�?
	fullPath := filepath.Join(baseDir, cleanPath)
	templatesDir := filepath.Join(baseDir, "templates")
	absFullPath, _ := filepath.Abs(fullPath)
	absTemplatesDir, _ := filepath.Abs(templatesDir)
	if !strings.HasPrefix(absFullPath, absTemplatesDir) {
		jsonResponseWithStatus(w, http.StatusForbidden, APIResponse{Success: false, Message: "非法路径"})
		return
	}

	// 删除文件
	if err := os.Remove(fullPath); err != nil {
		if os.IsNotExist(err) {
			jsonResponse(w, APIResponse{Success: true, Message: "文件已删�?})
			return
		}
		jsonResponseWithStatus(w, http.StatusInternalServerError, APIResponse{Success: false, Message: "删除文件失败"})
		return
	}

	jsonResponse(w, APIResponse{Success: true, Message: "文件已删�?})
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

// validateAdminToken 验证管理员令�?
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

// saveConfig 保存配置到文�?
func saveConfig() error {
	configPath := filepath.Join(baseDir, "config.json")

	data, err := json.MarshalIndent(config, "", "    ")
	if err != nil {
		return fmt.Errorf("序列化配置失�? %w", err)
	}

	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("写入配置文件失败: %w", err)
	}

	return nil
}

// ==================== 工具函数 ====================

// sanitizeFilename 过滤文件名中的危险字符，防止路径遍历攻击
// 严格模式：只允许字母、数字、下划线、连字符和中文字�?
func sanitizeFilename(name string) string {
	var result strings.Builder
	for _, r := range name {
		// 允许：字母、数字、下划线、连字符、中文字�?
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' {
			result.WriteRune(r)
		}
	}
	// 如果过滤后为空，返回默认�?
	if result.Len() == 0 {
		return "unnamed"
	}
	return result.String()
}

// allowedExtensions 允许上传的文件扩展名白名�?
var allowedExtensions = map[string]bool{
	// 文档�?
	".doc": true, ".docx": true, ".pdf": true, ".txt": true,
	".xls": true, ".xlsx": true, ".ppt": true, ".pptx": true,
	".odt": true, ".ods": true, ".odp": true, ".rtf": true,
	// 图片�?
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true,
	".bmp": true, ".webp": true, ".svg": true,
	// 压缩�?
	".zip": true, ".rar": true, ".7z": true, ".tar": true, ".gz": true,
	// 代码/文本
	".c": true, ".cpp": true, ".h": true, ".java": true, ".py": true,
	".js": true, ".html": true, ".css": true, ".json": true, ".xml": true,
	".md": true, ".go": true, ".rs": true, ".ts": true,
}

// isAllowedFileType 检查文件扩展名是否在白名单�?
func isAllowedFileType(ext string) bool {
	return allowedExtensions[ext]
}

// jsonResponse 发送JSON响应
func jsonResponse(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err := json.NewEncoder(w).Encode(data); err != nil {
		// 记录编码错误到日�?
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

// getClientHostname 获取客户端主机名（通过反向DNS查询�?
func getClientHostname(ip string) string {
	// 尝试反向DNS查询
	names, err := net.LookupAddr(ip)
	if err != nil || len(names) == 0 {
		return "未知主机"
	}
	// 返回第一个主机名，去掉末尾的�?
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

// ==================== 端口处理函数 ====================

// isPortInUse 检测端口是否被占用
func isPortInUse(port string) bool {
	addr := "0.0.0.0" + port
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return true // 端口被占�?
	}
	listener.Close()
	return false
}

// getPortProcess 获取占用端口的进程信�?(Windows)
func getPortProcess(port string) (pid int, processName string, cmdLine string, err error) {
	// 使用 netstat 命令获取端口占用信息
	portNum := strings.TrimPrefix(port, ":")
	cmd := exec.Command("cmd", "/C", fmt.Sprintf("netstat -ano | findstr :%s", portNum))
	output, err := cmd.Output()
	if err != nil {
		return 0, "", "", err
	}

	// 解析输出获取 PID
	// 输出格式: TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    12345
	lines := strings.Split(string(output), "\n")
	for _, line := range lines {
		if strings.Contains(line, "LISTENING") {
			fields := strings.Fields(line)
			if len(fields) >= 5 {
				pid, _ = strconv.Atoi(fields[len(fields)-1])
				break
			}
		}
	}

	if pid == 0 {
		return 0, "", "", fmt.Errorf("未找到占用进�?)
	}

	// 使用 tasklist 获取进程名称
	cmd = exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH")
	output, err = cmd.Output()
	if err == nil {
		// 解析 CSV 输出
		parts := strings.Split(string(output), ",")
		if len(parts) > 0 {
			processName = strings.Trim(parts[0], "\"")
		}
	}

	// 使用 wmic 获取命令�?
	cmd = exec.Command("wmic", "process", "where", fmt.Sprintf("ProcessId=%d", pid), "get", "CommandLine", "/format:list")
	output, err = cmd.Output()
	if err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			if strings.HasPrefix(line, "CommandLine=") {
				cmdLine = strings.TrimPrefix(line, "CommandLine=")
				cmdLine = strings.TrimSpace(cmdLine)
				break
			}
		}
	}

	return pid, processName, cmdLine, nil
}

// killProcess 结束指定 PID 的进�?
func killProcess(pid int) error {
	// 添加 /T 参数：终止进程树（包含所有子进程�?
	cmd := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid))
	return cmd.Run()
}

// waitForUserInput 等待用户输入，支持倒计�?
func waitForUserInput(timeout time.Duration) (choice string, timedOut bool) {
	resultChan := make(chan string, 1)

	// 启动输入监听协程
	go func() {
		reader := bufio.NewReader(os.Stdin)
		input, _ := reader.ReadString('\n')
		input = strings.TrimSpace(strings.ToUpper(input))
		resultChan <- input
	}()

	// 倒计�?
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	remaining := int(timeout.Seconds())

	for {
		select {
		case input := <-resultChan:
			fmt.Print("\r                ") // 清除倒计时显�?
			fmt.Print("\r")
			return input, false
		case <-ticker.C:
			remaining--
			fmt.Printf("\r倒计�? %d �?(输入 Y/N 并按回车响应) ", remaining)
			if remaining <= 0 {
				fmt.Println()
				return "", true // 超时
			}
		}
	}
}

// startServerWithPortHandling 智能端口启动
func startServerWithPortHandling(basePort string) error {
	currentPort := basePort
	maxRetries := 10 // 最多尝�?0个端�?

	for i := 0; i < maxRetries; i++ {
		// 检测端口是否被占用
		if !isPortInUse(currentPort) {
			// 端口可用，直接启�?
			return startServer(currentPort)
		}

		// 端口被占用，获取进程信息
		fmt.Printf("\n�?端口 %s 已被占用\n", currentPort)
		pid, processName, cmdLine, err := getPortProcess(currentPort)

		if err == nil && pid != 0 {
			fmt.Println("📋 占用进程信息:")
			fmt.Printf("   PID: %d\n", pid)
			fmt.Printf("   进程�? %s\n", processName)
			if cmdLine != "" {
				fmt.Printf("   命令�? %s\n", cmdLine)
			}
			fmt.Println()

			// 提示用户
			portNum, _ := strconv.Atoi(strings.TrimPrefix(currentPort, ":"))
			nextPort := fmt.Sprintf(":%d", portNum+1)

			fmt.Printf("⏱️  5秒后将自动结束占用进程并启动...\n")
			fmt.Printf("   输入 Y 并按回车 �?立即结束进程\n")
			fmt.Printf("   输入 N 并按回车 �?使用下一个端�?(%s)\n", nextPort)
			fmt.Printf("   不输入则等待倒计时\n\n")

			// 等待用户输入�?秒倒计时）
			choice, timedOut := waitForUserInput(5 * time.Second)

			if choice == "Y" || timedOut {
				// 结束进程
				fmt.Printf("\n🔄 正在结束进程 %d...\n", pid)
				if err := killProcess(pid); err != nil {
					fmt.Printf("�?结束进程失败: %v\n", err)
					fmt.Printf("💡 提示：\n")
					fmt.Printf("   1. 尝试【以管理员身份运行】此程序\n")
					fmt.Printf("   2. 或手动在任务管理器中结束 PID %d\n", pid)
					fmt.Printf("   正在尝试使用下一个端�?%s\n\n", nextPort)
					currentPort = nextPort
					continue
				}

				// 等待端口释放
				time.Sleep(500 * time.Millisecond)

				// 重新检�?
				if !isPortInUse(currentPort) {
					fmt.Println("�?进程已结束，端口已释�?)
					return startServer(currentPort)
				} else {
					fmt.Println("⚠️  端口仍被占用，尝试下一个端�?)
					currentPort = nextPort
					continue
				}
			} else if choice == "N" {
				// 换端�?
				fmt.Printf("\n🔄 切换到端�?%s\n\n", nextPort)
				currentPort = nextPort
				continue
			} else {
				// 无效输入，默认换端口
				fmt.Printf("\n⚠️  无效输入，切换到端口 %s\n\n", nextPort)
				currentPort = nextPort
				continue
			}
		} else {
			// 无法获取进程信息，直接尝试下一个端�?
			portNum, _ := strconv.Atoi(strings.TrimPrefix(currentPort, ":"))
			currentPort = fmt.Sprintf(":%d", portNum+1)
			fmt.Printf("⚠️  无法获取占用进程信息，尝试端�?%s\n\n", currentPort)
			continue
		}
	}

	return fmt.Errorf("已尝�?%d 个端口，均被占用", maxRetries)
}

// startServer 实际启动服务�?
func startServer(port string) error {
	addr := "0.0.0.0" + port
	localIP := getLocalIP()

	fmt.Println()
	fmt.Println("🌐 访问地址")
	fmt.Println("────────────────────────────────────────")
	fmt.Printf("   学生�?   http://localhost%s\n", port)
	fmt.Printf("   局域网:   http://%s%s\n", localIP, port)
	fmt.Println()

	fmt.Println("════════════════════════════════════════════════════════════")
	fmt.Printf("🚀 服务器已启动在端�?%s，按 Ctrl+C 停止\n", port)
	fmt.Println("════════════════════════════════════════════════════════════")
	fmt.Println()

	return http.ListenAndServe(addr, nil)
}

// ==================== 主函�?====================

func main() {
	fmt.Println()
	fmt.Println("╔════════════════════════════════════════════════════════════╗")
	fmt.Println("�?          CUMS - 课堂文件上传管理系统                      �?)
	fmt.Println("╚════════════════════════════════════════════════════════════╝")
	fmt.Println()

	// 初始化目�?
	if err := initDirs(); err != nil {
		fmt.Printf("�?初始化目录失�? %v\n", err)
		os.Exit(1)
	}

	// 加载配置
	if err := loadConfig(); err != nil {
		fmt.Printf("�?错误: %v\n", err)
		os.Exit(1)
	}

	// 初始化上传目�?
	if err := initUploadDirs(); err != nil {
		fmt.Printf("�?初始化上传目录失�? %v\n", err)
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
	http.HandleFunc("/api/v1/template", templateHandler)
	http.HandleFunc("/api/v1/admin/login", adminLoginHandler)
	http.HandleFunc("/api/v1/admin/config", adminConfigHandler)
	http.HandleFunc("/api/v1/admin/template/upload", templateUploadHandler)
	http.HandleFunc("/api/v1/admin/template/delete", templateDeleteHandler)

	// 启动服务�?
	addr := config.ServerAddr
	if addr == "" {
		addr = ":3000"
	}

	// 使用说明
	fmt.Println("📖 使用说明")
	fmt.Println("────────────────────────────────────────")
	fmt.Println("   1. 学生访问上方地址，登录后上传作业")
	fmt.Println("   2. 文件保存�?uploads/科目/班级/作业/ 目录")
	fmt.Println("   3. 通过管理后台可添加科目、班级、作�?)
	fmt.Println("   4. 修改 config.json 后需重启程序生效")
	fmt.Println()

	fmt.Println("════════════════════════════════════════════════════════════")
	fmt.Println("�?正在启动服务�?..")
	fmt.Println("════════════════════════════════════════════════════════════")

	// 使用智能端口启动
	if err := startServerWithPortHandling(addr); err != nil {
		fmt.Printf("�?启动服务器失�? %v\n", err)
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
