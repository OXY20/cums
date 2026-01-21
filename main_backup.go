package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Version    string                   `json:"version"`
	ServerAddr string                   `json:"server_addr"`
	UploadDir  string                   `json:"upload_dir"`
	Subjects   map[string]SubjectConfig `json:"subjects"`
}

type SubjectConfig struct {
	Classes   []string `json:"classes"`
	Homeworks []string `json:"homeworks"`
}

type LoginRequest struct {
	Class       string `json:"class"`
	StudentID   string `json:"student_id"`
	StudentName string `json:"student_name"`
}

type LoginResponse struct {
	Success bool        `json:"success"`
	Message string      `json:"message"`
	Data    interface{} `json:"data"`
}

type ConfigResponse struct {
	Success bool               `json:"success"`
	Data    ConfigDataResponse `json:"data"`
}

type ConfigDataResponse struct {
	Subjects map[string]SubjectConfig `json:"subjects"`
}

type UploadResponse struct {
	Success  bool   `json:"success"`
	Message  string `json:"message"`
	Filename string `json:"filename"`
	Filepath string `json:"filepath"`
}

type VersionResponse struct {
	Success bool   `json:"success"`
	Version string `json:"version"`
}

type ChangelogResponse struct {
	Success   bool   `json:"success"`
	Changelog string `json:"changelog"`
}

var config Config

var buildVersion = ""

var defaultConfigTpl = `{
    "version": "{{VERSION}}",
    "server_addr": ":3000",
    "upload_dir": "uploads",
    "subjects": {
        "数学": {
            "classes": ["一班", "二班"],
            "homeworks": ["第一章作业", "第二章作业"]
        },
        "语文": {
            "classes": ["一班"],
            "homeworks": ["作文", "阅读理解"]
        },
        "英语": {
            "classes": ["一班"],
            "homeworks": ["听力练习"]
        }
    }
}`

var defaultIndexHTMLTpl = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文件上传系统</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f5f5f5; min-height: 100vh; }
        .header { background-color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
        .header h1 { font-size: 18px; color: #333; font-weight: 500; }
        .user-info { display: flex; align-items: center; gap: 12px; }
        .user-info span { color: #666; font-size: 14px; }
        .nav-link { color: #666; text-decoration: none; font-size: 14px; padding: 8px 12px; border-radius: 4px; cursor: pointer; }
        .nav-link:hover { color: #1890ff; background-color: #e6f7ff; }
        .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
        .btn-primary { background-color: #1890ff; color: #fff; }
        .btn-primary:hover { background-color: #40a9ff; }
        .main { max-width: 600px; margin: 40px auto; padding: 0 20px; }
        .upload-card, .about-card { background-color: #fff; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .about-card h2 { font-size: 16px; color: #333; margin-bottom: 24px; text-align: center; }
        .version-info { text-align: center; padding: 20px 0; border-bottom: 1px solid #f0f0f0; margin-bottom: 24px; }
        .version-info .version { font-size: 24px; color: #1890ff; font-weight: 500; }
        .version-info .date { font-size: 12px; color: #999; margin-top: 8px; }
        .changelog { max-height: 400px; overflow-y: auto; }
        .changelog h3 { font-size: 16px; color: #333; margin: 16px 0 8px; }
        .changelog ul { list-style: none; padding-left: 0; }
        .changelog li { position: relative; padding-left: 16px; margin-bottom: 8px; font-size: 14px; color: #666; line-height: 1.6; }
        .changelog li::before { content: "•"; position: absolute; left: 0; color: #1890ff; }
        .changelog .version-header { font-size: 16px; font-weight: 500; color: #333; margin-top: 24px; padding-bottom: 8px; border-bottom: 1px solid #e8e8e8; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; color: #333; font-size: 14px; }
        .form-group select, .form-group input[type="text"] { width: 100%; padding: 10px 12px; border: 1px solid #d9d9d9; border-radius: 4px; font-size: 14px; }
        .form-group select:focus, .form-group input[type="text"]:focus { outline: none; border-color: #1890ff; }
        .form-group input[type="file"] { width: 100%; padding: 8px 12px; border: 1px solid #d9d9d9; border-radius: 4px; font-size: 14px; }
        .upload-btn { width: 100%; padding: 12px; background-color: #1890ff; color: #fff; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; }
        .upload-btn:hover { background-color: #40a9ff; }
        .upload-btn:disabled { background-color: #d9d9d9; cursor: not-allowed; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
        .modal.active { display: flex; }
        .modal-content { background-color: #fff; border-radius: 8px; padding: 24px; width: 360px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .modal-content h3 { font-size: 16px; color: #333; margin-bottom: 20px; text-align: center; }
        .modal-close { float: right; cursor: pointer; color: #999; font-size: 20px; line-height: 1; }
        .modal-close:hover { color: #333; }
        .modal .btn-primary { width: 100%; padding: 10px; }
        .message { padding: 12px 16px; border-radius: 4px; margin-bottom: 20px; display: none; }
        .message.success { background-color: #f6ffed; border: 1px solid #b7eb8f; color: #52c41a; display: block; }
        .message.error { background-color: #fff2f0; border: 1px solid #ffccc7; color: #f5222d; display: block; }
        .hidden { display: none !important; }
        .welcome-text { color: #666; text-align: center; padding: 40px 0; }
        .welcome-text p { margin-bottom: 8px; font-size: 14px; }
        .welcome-text .btn { margin-top: 16px; }
        .loading { display: inline-block; width: 16px; height: 16px; border: 2px solid #fff; border-radius: 50%; border-top-color: transparent; animation: spin 0.8s linear infinite; margin-right: 8px; vertical-align: middle; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .file-name { margin-top: 8px; font-size: 12px; color: #666; }
        .class-tag { display: inline-block; padding: 4px 12px; background-color: #e6f7ff; border: 1px solid #91d5ff; border-radius: 4px; color: #1890ff; font-size: 12px; margin-bottom: 16px; }
        .footer { text-align: center; padding: 20px; color: #999; font-size: 12px; }
        .footer a { color: #1890ff; text-decoration: none; }
        .footer a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <header class="header">
        <h1>文件上传系统</h1>
        <div class="user-info" id="userInfo">
            <a class="nav-link" onclick="showAboutPage()">关于</a>
            <button class="btn btn-primary" onclick="showLoginModal()">登录</button>
        </div>
    </header>
    <main class="main">
        <div class="upload-card" id="uploadCard">
            <div class="welcome-text" id="welcomeText">
                <p>请先登录</p>
                <button class="btn btn-primary" onclick="showLoginModal()">登录</button>
            </div>
            <div id="uploadForm" class="hidden">
                <div class="class-tag" id="classTag"></div>
                <h2>作业上传</h2>
                <div class="message" id="message"></div>
                <form id="fileUploadForm" onsubmit="handleUpload(event)">
                    <div class="form-group">
                        <label>科目</label>
                        <select id="subjectSelect" onchange="onSubjectChange()" required><option value="">请选择科目</option></select>
                    </div>
                    <div class="form-group">
                        <label>班级</label>
                        <select id="classSelect" onchange="onClassChange()" required><option value="">请选择班级</option></select>
                    </div>
                    <div class="form-group">
                        <label>作业</label>
                        <select id="homeworkSelect" required><option value="">请选择作业</option></select>
                    </div>
                    <div class="form-group">
                        <label>文件</label>
                        <input type="file" id="fileInput" required>
                        <div class="file-name" id="fileName"></div>
                    </div>
                    <button type="submit" class="upload-btn" id="uploadBtn">上传文件</button>
                </form>
            </div>
        </div>
        <div class="about-card hidden" id="aboutCard">
            <h2>关于</h2>
            <div class="version-info">
                <div class="version" id="aboutVersion">v{{VERSION}}</div>
                <div class="date">文件上传系统</div>
            </div>
            <div class="changelog" id="changelogContent"><p>加载中...</p></div>
        </div>
    </main>
    <footer class="footer">
        <a onclick="showAboutPage()">关于</a> &bull; <span id="footerVersion">v{{VERSION}}</span>
    </footer>
    <div class="modal" id="loginModal">
        <div class="modal-content">
            <span class="modal-close" onclick="hideLoginModal()">&times;</span>
            <h3>用户登录</h3>
            <form onsubmit="handleLogin(event)">
                <div class="form-group">
                    <label>班级</label>
                    <select id="loginClass" required><option value="">请选择班级</option></select>
                </div>
                <div class="form-group">
                    <label>号数</label>
                    <input type="text" id="loginStudentId" placeholder="请输入号数" required>
                </div>
                <div class="form-group">
                    <label>姓名</label>
                    <input type="text" id="loginStudentName" placeholder="请输入姓名" required>
                </div>
                <button type="submit" class="btn btn-primary">登录</button>
            </form>
        </div>
    </div>
    <script>
        let currentUser = null, configData = null, currentVersion = '{{VERSION}}';
        document.getElementById('fileInput').addEventListener('change', e => { document.getElementById('fileName').textContent = e.target.files[0]?.name || ''; });
        async function loadConfig() { try { const r = await fetch('/api/v1/config', { method: 'POST', headers: {'Content-Type': 'application/json'} }); const rs = await r.json(); if (rs.success) { configData = rs.data; initSubjectSelect(); } } catch (e) { console.error('加载配置失败:', e); } }
        async function loadVersion() { try { const r = await fetch('/api/v1/version'); const rs = await r.json(); if (rs.success) { currentVersion = rs.version; document.getElementById('aboutVersion').textContent = 'v' + currentVersion; document.getElementById('footerVersion').textContent = 'v' + currentVersion; } } catch (e) { console.error('加载版本失败:', e); } }
        async function loadChangelog() { try { const r = await fetch('/api/v1/changelog'); const rs = await r.json(); if (rs.success) { document.getElementById('changelogContent').innerHTML = formatChangelog(rs.changelog); } } catch (e) { document.getElementById('changelogContent').innerHTML = '<p>加载失败</p>'; } }
        function formatChangelog(text) { const lines = text.split('\n'); let h = ''; let inList = false; for (let l of lines) { l = l.trim(); if (!l) continue; if (l.startsWith('# ')) { if (inList) { h += '</ul>'; inList = false; } h += '<h2>' + l.substring(2) + '</h2>'; } else if (l.startsWith('## ')) { if (inList) { h += '</ul>'; inList = false; } h += '<div class="version-header">' + l.substring(3) + '</div>'; } else if (l.startsWith('### ')) { if (inList) { h += '</ul>'; inList = false; } h += '<h3>' + l.substring(4) + '</h3>'; } else if (l.startsWith('- ') || l.startsWith('* ')) { if (!inList) { h += '<ul>'; inList = true; } h += '<li>' + l.substring(2) + '</li>'; } else { if (inList) { h += '</ul>'; inList = false; } h += '<p>' + l + '</p>'; } } if (inList) h += '</ul>'; return h; }
        function initSubjectSelect() { const s = document.getElementById('subjectSelect'); Object.keys(configData.subjects).forEach(sub => { s.add(new Option(sub, sub)); }); }
        function initLoginClassSelect() { const s = document.getElementById('loginClass'); const classes = new Set(); Object.values(configData.subjects).forEach(sub => { sub.classes.forEach(c => classes.add(c)); }); classes.forEach(c => { s.add(new Option(c, c)); }); }
        function onSubjectChange() { const subject = document.getElementById('subjectSelect').value; const classSelect = document.getElementById('classSelect'); classSelect.innerHTML = '<option value="">请选择班级</option>'; if (subject && configData.subjects[subject]) { configData.subjects[subject].classes.forEach(c => { classSelect.add(new Option(c, c)); }); } onClassChange(); }
        function onClassChange() { const subject = document.getElementById('subjectSelect').value; const className = document.getElementById('classSelect').value; const hwSelect = document.getElementById('homeworkSelect'); hwSelect.innerHTML = '<option value="">请选择作业</option>'; if (subject && configData.subjects[subject]) { configData.subjects[subject].homeworks.forEach(h => { hwSelect.add(new Option(h, h)); }); } }
        function showAboutPage() { document.getElementById('uploadCard').classList.add('hidden'); document.getElementById('welcomeText').classList.add('hidden'); document.getElementById('uploadForm').classList.add('hidden'); document.getElementById('aboutCard').classList.remove('hidden'); loadChangelog(); }
        function showUploadPage() { document.getElementById('aboutCard').classList.add('hidden'); if (currentUser) { document.getElementById('uploadCard').classList.remove('hidden'); document.getElementById('uploadForm').classList.remove('hidden'); } else { document.getElementById('uploadCard').classList.remove('hidden'); document.getElementById('welcomeText').classList.remove('hidden'); } }
        function showLoginModal() { document.getElementById('loginModal').classList.add('active'); }
        function hideLoginModal() { document.getElementById('loginModal').classList.remove('active'); }
        async function handleLogin(e) { e.preventDefault(); const c = document.getElementById('loginClass').value, id = document.getElementById('loginStudentId').value, n = document.getElementById('loginStudentName').value; try { const r = await fetch('/api/v1/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({class: c, student_id: id, student_name: n}) }); const rs = await r.json(); if (rs.success) { currentUser = rs.data; updateUserInfo(); hideLoginModal(); showUploadPage(); document.getElementById('loginClass').value = ''; document.getElementById('loginStudentId').value = ''; document.getElementById('loginStudentName').value = ''; } else { alert(rs.message); } } catch (e) { alert('登录失败，请重试'); } }
        function updateUserInfo() { const u = document.getElementById('userInfo'), t = document.getElementById('classTag'); if (currentUser) { u.innerHTML = '<a class="nav-link" onclick="showAboutPage()">关于</a><span>' + currentUser.class + ' - ' + currentUser.student_id + '号 ' + currentUser.student_name + '</span>'; t.textContent = currentUser.class; } }
        async function handleUpload(e) { e.preventDefault(); const f = document.getElementById('fileInput'), b = document.getElementById('uploadBtn'), m = document.getElementById('message'); if (!f.files[0]) { m.textContent = '请选择要上传的文件'; m.className = 'message error'; return; } const fd = new FormData(); fd.append('class', currentUser.class); fd.append('student_id', currentUser.student_id); fd.append('student_name', currentUser.student_name); fd.append('subject', document.getElementById('subjectSelect').value); fd.append('homework', document.getElementById('homeworkSelect').value); fd.append('file', f.files[0]); b.disabled = true; b.innerHTML = '<span class="loading"></span>上传中...'; m.className = 'message'; try { const r = await fetch('/api/v1/upload', { method: 'POST', body: fd }); const rs = await r.json(); if (rs.success) { m.textContent = '上传成功：' + rs.filename; m.className = 'message success'; document.getElementById('fileUploadForm').reset(); document.getElementById('fileName').textContent = ''; } else { m.textContent = rs.message; m.className = 'message error'; } } catch (e) { m.textContent = '上传失败，请重试'; m.className = 'message error'; } finally { b.disabled = false; b.textContent = '上传文件'; } }
        document.getElementById('loginModal').addEventListener('click', e => { if (e.target === this) hideLoginModal(); });
        loadConfig(); loadVersion();
    </script>
</body>
</html>`

func init() {
	if buildVersion == "" {
		buildVersion = "1.0.3"
	}
}

func getDefaultConfig() string {
	return strings.Replace(defaultConfigTpl, "{{VERSION}}", buildVersion, 1)
}

func getDefaultHTML() string {
	return strings.ReplaceAll(defaultIndexHTMLTpl, "{{VERSION}}", buildVersion)
}

func getCumsDir() string {
	exePath, _ := os.Executable()
	exeDir := filepath.Dir(exePath)
	return filepath.Join(exeDir, "cums")
}

func findConfigPath() string {
	cumsDir := getCumsDir()
	paths := []string{
		filepath.Join(cumsDir, "config.json"),
		"cums/config.json",
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return filepath.Join(cumsDir, "config.json")
}

func findStaticPath() string {
	cumsDir := getCumsDir()
	paths := []string{
		filepath.Join(cumsDir, "static"),
		"cums/static",
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return filepath.Join(cumsDir, "static")
}

func loadConfig() error {
	configPath := findConfigPath()
	data, err := os.ReadFile(configPath)
	if err != nil {
		cumsDir := getCumsDir()
		if err := os.MkdirAll(cumsDir, 0755); err != nil {
			return fmt.Errorf("创建 cums 目录失败: %w", err)
		}
		defaultConfig := getDefaultConfig()
		if err := os.WriteFile(configPath, []byte(defaultConfig), 0644); err != nil {
			return fmt.Errorf("创建默认配置文件失败: %w", err)
		}
		fmt.Printf("已创建配置文件: %s\n", configPath)
		data = []byte(defaultConfig)
	}
	return json.Unmarshal(data, &config)
}

func initUploadDirs() error {
	baseDir := getCumsDir()
	uploadDir := filepath.Join(baseDir, "uploads")
	config.UploadDir = uploadDir

	if config.Subjects == nil {
		config.Subjects = make(map[string]SubjectConfig)
	}
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

func autoInit() error {
	cumsDir := getCumsDir()
	staticPath := findStaticPath()
	staticFile := filepath.Join(staticPath, "index.html")

	if err := os.MkdirAll(cumsDir, 0755); err != nil {
		return fmt.Errorf("创建 cums 目录失败: %w", err)
	}

	if _, err := os.Stat(staticFile); os.IsNotExist(err) {
		if err := os.MkdirAll(staticPath, 0755); err != nil {
			return fmt.Errorf("创建静态目录失败: %w", err)
		}
		defaultHTML := getDefaultHTML()
		if err := os.WriteFile(staticFile, []byte(defaultHTML), 0644); err != nil {
			return fmt.Errorf("创建默认静态文件失败: %w", err)
		}
		fmt.Printf("已创建静态文件: %s\n", staticFile)
	}

	uploadDir := filepath.Join(cumsDir, "uploads")
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		return fmt.Errorf("创建上传目录失败: %w", err)
	}

	return nil
}

var classMapping = map[string]string{
	"1班": "一班", "2班": "二班", "3班": "三班",
	"4班": "四班", "5班": "五班", "6班": "六班",
}

func findClassInConfig(className string) (string, bool) {
	if mapped, ok := classMapping[className]; ok {
		className = mapped
	}
	for _, subConfig := range config.Subjects {
		for _, class := range subConfig.Classes {
			if class == className {
				return className, true
			}
		}
	}
	return "", false
}

func isClassInSubject(subject, className string) bool {
	if subConfig, ok := config.Subjects[subject]; ok {
		for _, class := range subConfig.Classes {
			if class == className {
				return true
			}
		}
	}
	return false
}

func loginHandler(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "无效的请求", http.StatusBadRequest)
		return
	}

	className, found := findClassInConfig(req.Class)
	if !found {
		classes := make([]string, 0)
		for _, subConfig := range config.Subjects {
			for _, class := range subConfig.Classes {
				classes = append(classes, class)
			}
		}
		jsonResponse(w, LoginResponse{
			Success: false,
			Message: fmt.Sprintf("班级不存在，可选班级：%s", strings.Join(classes, "、")),
			Data:    nil,
		})
		return
	}
	if req.StudentID == "" || req.StudentName == "" {
		jsonResponse(w, LoginResponse{
			Success: false,
			Message: "学号和姓名不能为空",
			Data:    nil,
		})
		return
	}
	jsonResponse(w, LoginResponse{
		Success: true,
		Message: "登录成功",
		Data: map[string]string{
			"class":        className,
			"student_id":   req.StudentID,
			"student_name": req.StudentName,
		},
	})
}

func configHandler(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, ConfigResponse{
		Success: true,
		Data: ConfigDataResponse{
			Subjects: config.Subjects,
		},
	})
}

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	class := r.FormValue("class")
	studentID := r.FormValue("student_id")
	studentName := r.FormValue("student_name")
	subject := r.FormValue("subject")
	homework := r.FormValue("homework")

	fmt.Printf("[调试] 上传请求: 班级=%s, 科目=%s, 作业=%s\n", class, subject, homework)
	fmt.Printf("[调试] UploadDir: %s\n", config.UploadDir)

	if class == "" || studentID == "" || studentName == "" || subject == "" || homework == "" {
		jsonResponse(w, UploadResponse{Success: false, Message: "缺少必要参数", Filename: ""})
		return
	}

	className, found := findClassInConfig(class)
	if !found {
		fmt.Printf("[错误] 班级不存在: %s\n", class)
		jsonResponse(w, UploadResponse{Success: false, Message: "班级不存在", Filename: ""})
		return
	}

	subConfig, exists := config.Subjects[subject]
	if !exists {
		fmt.Printf("[错误] 科目不存在: %s\n", subject)
		jsonResponse(w, UploadResponse{Success: false, Message: "科目不存在", Filename: ""})
		return
	}

	if !isClassInSubject(subject, className) {
		fmt.Printf("[错误] 班级 %s 不在科目 %s 中\n", className, subject)
		jsonResponse(w, UploadResponse{Success: false, Message: "该班级没有此科目", Filename: ""})
		return
	}

	homeworkExists := false
	for _, hw := range subConfig.Homeworks {
		if hw == homework {
			homeworkExists = true
			break
		}
	}
	if !homeworkExists {
		fmt.Printf("[错误] 作业不存在: %s\n", homework)
		jsonResponse(w, UploadResponse{Success: false, Message: "作业不存在", Filename: ""})
		return
	}

	uploadPath := filepath.Join(config.UploadDir, subject, className, homework)
	fmt.Printf("[调试] 上传路径: %s\n", uploadPath)

	file, header, err := r.FormFile("file")
	if err != nil {
		jsonResponse(w, UploadResponse{Success: false, Message: "请选择要上传的文件", Filename: ""})
		return
	}
	defer file.Close()

	fmt.Printf("[调试] 接收文件: %s\n", header.Filename)

	ext := filepath.Ext(header.Filename)
	filename := fmt.Sprintf("%s_%s_%s_%s%s", homework, studentID, studentName, time.Now().Format("20060102150405"), ext)

	fmt.Printf("[调试] 创建目录: %s\n", uploadPath)
	if err := os.MkdirAll(uploadPath, 0755); err != nil {
		fmt.Printf("[错误] 创建目录失败: %v\n", err)
		jsonResponse(w, UploadResponse{Success: false, Message: "创建目录失败: " + err.Error(), Filename: ""})
		return
	}

	filepath := filepath.Join(uploadPath, filename)
	dst, err := os.Create(filepath)
	if err != nil {
		fmt.Printf("[错误] 创建文件失败: %v\n", err)
		jsonResponse(w, UploadResponse{Success: false, Message: "创建文件失败: " + err.Error(), Filename: ""})
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		fmt.Printf("[错误] 写入文件失败: %v\n", err)
		jsonResponse(w, UploadResponse{Success: false, Message: "写入文件失败", Filename: ""})
		return
	}

	fmt.Printf("[调试] 文件上传成功\n")
	fmt.Printf("  班级: %s\n", className)
	fmt.Printf("  科目: %s\n", subject)
	fmt.Printf("  作业: %s\n", homework)
	fmt.Printf("  文件: %s\n", filename)
	fmt.Printf("  路径: %s\n", filepath)

	logMessage := fmt.Sprintf("[%s] %s %s号%s提交%s作业",
		time.Now().Format("2006-01-02 15:04:05"), className, studentID, studentName, homework)

	fmt.Println(logMessage)
	writeLog(logMessage)

	jsonResponse(w, UploadResponse{
		Success:  true,
		Message:  "上传成功",
		Filename: filename,
		Filepath: filepath,
	})
}

func writeLog(message string) {
	cumsDir := getCumsDir()
	logsDir := filepath.Join(cumsDir, "logs")
	logFile := filepath.Join(logsDir, "cums.log")

	os.MkdirAll(logsDir, 0755)

	file, err := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		fmt.Printf("写入日志失败: %v\n", err)
		return
	}
	defer file.Close()

	file.WriteString(message + "\n")
}

func versionHandler(w http.ResponseWriter, r *http.Request) {
	version := config.Version
	if version == "" {
		version = buildVersion
	}
	jsonResponse(w, VersionResponse{Success: true, Version: version})
}

func changelogHandler(w http.ResponseWriter, r *http.Request) {
	changelog := "# 更新日志\n\n## v" + buildVersion + " (" + time.Now().Format("2006-01-20") + ")\n\n### 新增功能\n- 文件上传系统\n- 班级/科目/作业配置管理\n- 支持自定义存储路径\n\n### 特性\n- 简洁的登录界面\n- 文件自动重命名\n- 跨平台支持（Windows/Linux/Mac）\n\n### 配置\n- 配置文件格式：JSON\n- 端口：3000\n- 默认上传目录：cums/uploads/"
	jsonResponse(w, ChangelogResponse{Success: true, Changelog: changelog})
}

func jsonResponse(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func main() {
	fmt.Println("========================================")
	fmt.Println("  CUMS - 文件上传系统")
	fmt.Println("========================================")
	fmt.Println()

	if err := loadConfig(); err != nil {
		fmt.Printf("错误: %v\n", err)
		os.Exit(1)
	}
	if err := autoInit(); err != nil {
		fmt.Printf("自动初始化失败: %v\n", err)
		os.Exit(1)
	}
	if err := initUploadDirs(); err != nil {
		fmt.Printf("初始化上传目录失败: %v\n", err)
		os.Exit(1)
	}

	staticPath := findStaticPath()
	cumsDir := getCumsDir()

	displayVersion := config.Version
	if displayVersion == "" {
		displayVersion = buildVersion
	}

	fmt.Println("目录结构:")
	fmt.Printf("  配置: %s\n", filepath.Join(cumsDir, "config.json"))
	fmt.Printf("  静态: %s\n", staticPath)
	fmt.Printf("  上传: %s\n", config.UploadDir)
	fmt.Println()

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(staticPath, "index.html"))
	})
	http.HandleFunc("/api/v1/login", loginHandler)
	http.HandleFunc("/api/v1/config", configHandler)
	http.HandleFunc("/api/v1/upload", uploadHandler)
	http.HandleFunc("/api/v1/version", versionHandler)
	http.HandleFunc("/api/v1/changelog", changelogHandler)

	addr := "0.0.0.0" + config.ServerAddr
	fmt.Printf("服务器启动: http://%s\n", addr)
	fmt.Printf("版本: %s\n", displayVersion)
	fmt.Println()
	fmt.Println("按 Ctrl+C 停止服务")
	fmt.Println()

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if strings.Contains(err.Error(), "address already in use") {
			port := getNextPort(config.ServerAddr)
			addr = "0.0.0.0" + port
			fmt.Printf("端口被占用，尝试新端口: %s\n", addr)
			ln, err = net.Listen("tcp", addr)
		}
		if err != nil {
			fmt.Printf("启动服务器失败: %v\n", err)
			os.Exit(1)
		}
	}
	fmt.Printf("服务器启动: http://%s\n", addr)
	if err := http.Serve(ln, nil); err != nil {
		fmt.Printf("服务器错误: %v\n", err)
	}
}

func getNextPort(addr string) string {
	portStr := strings.TrimPrefix(addr, ":")
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return ":3000"
	}
	for {
		port++
		testAddr := fmt.Sprintf(":%d", port)
		ln, err := net.Listen("tcp", testAddr)
		if err == nil {
			ln.Close()
			return testAddr
		}
		if port > 65535 {
			return ":3000"
		}
	}
}
