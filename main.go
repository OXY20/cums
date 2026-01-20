package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Config struct {
	Version    string                 `json:"version"`
	ServerAddr string                 `json:"server_addr"`
	UploadDir  string                 `json:"upload_dir"`
	Classes    map[string]ClassConfig `json:"classes"`
}

type ClassConfig struct {
	Subjects map[string][]HomeworkConfig `json:"subjects"`
}

type HomeworkConfig struct {
	Name       string `json:"name"`
	UploadPath string `json:"upload_path"`
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
	Classes   []string                       `json:"classes"`
	Homeworks map[string]map[string][]string `json:"homeworks"`
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

func findConfigPath() string {
	paths := []string{
		"config.json",
		"cums/config.json",
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "config.json"
}

func findStaticPath() string {
	paths := []string{
		"static/index.html",
		"cums/static/index.html",
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return strings.TrimSuffix(p, "/index.html")
		}
	}
	return "static"
}

func loadConfig() error {
	configPath := findConfigPath()
	data, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("加载配置文件失败: %w", err)
	}
	return json.Unmarshal(data, &config)
}

func initUploadDirs() error {
	if config.Classes == nil {
		config.Classes = make(map[string]ClassConfig)
	}
	for className, classConfig := range config.Classes {
		for subject, homeworks := range classConfig.Subjects {
			for _, hw := range homeworks {
				var dir string
				if hw.UploadPath != "" {
					dir = hw.UploadPath
				} else {
					dir = filepath.Join(config.UploadDir, className, subject, hw.Name)
				}
				if err := os.MkdirAll(dir, 0755); err != nil {
					return fmt.Errorf("创建目录失败 %s: %w", dir, err)
				}
			}
		}
	}
	return nil
}

func autoInit() error {
	staticPath := findStaticPath()
	if err := os.MkdirAll(staticPath, 0755); err != nil {
		return fmt.Errorf("创建静态目录失败: %w", err)
	}
	if err := os.MkdirAll(config.UploadDir, 0755); err != nil {
		return fmt.Errorf("创建上传目录失败: %w", err)
	}
	return nil
}

var classMapping = map[string]string{
	"1班": "一班",
	"2班": "二班",
	"3班": "三班",
	"4班": "四班",
	"5班": "五班",
	"6班": "六班",
}

func findClass(className string) (string, bool) {
	if _, exists := config.Classes[className]; exists {
		return className, true
	}
	if mapped, ok := classMapping[className]; ok {
		if _, exists := config.Classes[mapped]; exists {
			return mapped, true
		}
	}
	for cls := range config.Classes {
		if cls == className {
			return cls, true
		}
	}
	return "", false
}

func loginHandler(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "无效的请求", http.StatusBadRequest)
		return
	}

	className, found := findClass(req.Class)
	if !found {
		classes := make([]string, 0, len(config.Classes))
		for c := range config.Classes {
			classes = append(classes, c)
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
	classes := make([]string, 0, len(config.Classes))
	homeworks := make(map[string]map[string][]string)

	for className, classConfig := range config.Classes {
		classes = append(classes, className)
		homeworks[className] = make(map[string][]string)
		for subject, hwConfigs := range classConfig.Subjects {
			for _, hw := range hwConfigs {
				homeworks[className][subject] = append(homeworks[className][subject], hw.Name)
			}
		}
	}

	jsonResponse(w, ConfigResponse{
		Success: true,
		Data: ConfigDataResponse{
			Classes:   classes,
			Homeworks: homeworks,
		},
	})
}

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	class := r.FormValue("class")
	studentID := r.FormValue("student_id")
	studentName := r.FormValue("student_name")
	subject := r.FormValue("subject")
	homework := r.FormValue("homework")

	if class == "" || studentID == "" || studentName == "" || subject == "" || homework == "" {
		jsonResponse(w, UploadResponse{
			Success:  false,
			Message:  "缺少必要参数",
			Filename: "",
		})
		return
	}

	classConfig, exists := config.Classes[class]
	if !exists {
		jsonResponse(w, UploadResponse{
			Success:  false,
			Message:  "班级不存在",
			Filename: "",
		})
		return
	}

	hwConfigs, exists := classConfig.Subjects[subject]
	if !exists {
		jsonResponse(w, UploadResponse{
			Success:  false,
			Message:  "科目不存在",
			Filename: "",
		})
		return
	}

	var uploadPath string
	var found bool
	for _, hw := range hwConfigs {
		if hw.Name == homework {
			if hw.UploadPath != "" {
				uploadPath = hw.UploadPath
			} else {
				uploadPath = filepath.Join(config.UploadDir, class, subject, homework)
			}
			found = true
			break
		}
	}

	if !found {
		jsonResponse(w, UploadResponse{
			Success:  false,
			Message:  "作业不存在",
			Filename: "",
		})
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		jsonResponse(w, UploadResponse{
			Success:  false,
			Message:  "请选择要上传的文件",
			Filename: "",
		})
		return
	}
	defer file.Close()

	ext := filepath.Ext(header.Filename)
	filename := fmt.Sprintf("%s_%s_%s_%s%s", homework, studentID, studentName, time.Now().Format("20060102150405"), ext)

	if err := os.MkdirAll(uploadPath, 0755); err != nil {
		jsonResponse(w, UploadResponse{
			Success:  false,
			Message:  "创建目录失败",
			Filename: "",
		})
		return
	}

	filepath := filepath.Join(uploadPath, filename)
	dst, err := os.Create(filepath)
	if err != nil {
		jsonResponse(w, UploadResponse{
			Success:  false,
			Message:  "创建文件失败",
			Filename: "",
		})
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		jsonResponse(w, UploadResponse{
			Success:  false,
			Message:  "写入文件失败",
			Filename: "",
		})
		return
	}

	jsonResponse(w, UploadResponse{
		Success:  true,
		Message:  "上传成功",
		Filename: filename,
		Filepath: filepath,
	})
}

func versionHandler(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, VersionResponse{
		Success: true,
		Version: config.Version,
	})
}

func changelogHandler(w http.ResponseWriter, r *http.Request) {
	data, err := changelog.ReadFile("CHANGELOG.md")
	if err != nil {
		data = []byte("# 更新日志\n\n暂无更新日志")
	}
	jsonResponse(w, ChangelogResponse{
		Success:   true,
		Changelog: string(data),
	})
}

func jsonResponse(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func main() {
	if err := loadConfig(); err != nil {
		fmt.Printf("加载配置失败: %v\n", err)
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

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(staticPath, "index.html"))
	})

	http.HandleFunc("/api/v1/login", loginHandler)
	http.HandleFunc("/api/v1/config", configHandler)
	http.HandleFunc("/api/v1/upload", uploadHandler)
	http.HandleFunc("/api/v1/version", versionHandler)
	http.HandleFunc("/api/v1/changelog", changelogHandler)

	fmt.Printf("服务器启动在 %s\n", config.ServerAddr)
	fmt.Printf("版本: %s\n", config.Version)
	fmt.Println("访问 http://localhost:3000")
	if err := http.ListenAndServe(config.ServerAddr, nil); err != nil {
		fmt.Printf("服务器错误: %v\n", err)
	}
}
