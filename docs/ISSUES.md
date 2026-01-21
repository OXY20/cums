# 项目问题清单

本文档记录了项目中发现的问题和改进建议。

## ✅ 已解决的问题

### 1. ~~配置结构与代码实现不匹配~~ ✅ 已解决 (2026-01-21)

**问题描述**:
- ~~`config.json` 使用的数据结构与 `main.go` 和 `static/index.html` 的实现不一致~~

**当前状态**: 已修复

**修复内容**:
1. ✅ 恢复了 `main.go` 文件，实现以科目为中心的配置结构
2. ✅ 更新了 `static/index.html`，匹配新的配置格式
3. ✅ 统一了前后端的数据结构

**当前配置格式** (已实现):
```json
{
    "subjects": {
        "数学": {
            "classes": ["一班", "二班"],
            "homeworks": ["第一章作业", "第二章作业"]
        }
    }
}
```

**架构说明**:
- 采用**以科目为中心**的设计
- 每个科目独立配置班级和作业
- 前端流程: 科目选择 → 班级选择 → 作业选择
- 文件存储: `uploads/{科目}/{班级}/{作业}/`

---

### 2. ~~前后端班级选择逻辑冲突~~ ✅ 已解决 (2026-01-21)

**问题描述**:
- ~~`main.go` 使用 `--class` 命令行参数固定班级~~
- ~~`static/index.html` 登录表单包含班级下拉选择~~

**当前状态**: 已修复

**修复内容**:
1. ✅ 移除了 `--class` 命令行参数
2. ✅ 前端登录界面提供班级下拉选择
3. ✅ 采用灵活班级模式，支持多班级共用系统

**当前实现**:

登录流程:
```javascript
// 用户从下拉列表选择班级
<select id="loginClass" required>
    <option value="">请选择班级</option>
</select>
```

后端验证:
```go
// 从配置中自动收集所有班级
func findClassInConfig(className string) (string, bool) {
    // 遍历所有科目的班级列表
    for _, subConfig := range config.Subjects {
        for _, class := range subConfig.Classes {
            if class == className {
                return className, true
            }
        }
    }
    return "", false
}
```

---

## 🟡 中等问题

### 3. config.toml 文件未被使用

**问题描述**:
- 项目中存在 `config.toml` 文件
- 代码只读取 `config.json`
- `config.toml` 是多余的

**影响**:
- 造成混淆
- 占用空间

**解决方案**:
- 删除 `config.toml` 文件
- 或实现 TOML 配置支持

---

### 4. 文档中缺少 INDEX.md

**问题描述**:
- `docs/README_CENTER.md` 引用了 `INDEX.md`
- 但该文件不存在

**影响**:
- 文档链接失效

**解决方案**:
- 创建 `docs/INDEX.md` 文件
- 或移除 `README_CENTER.md` 中的引用

---

### 5. API 文档与实际实现不一致

**问题描述**:
- `docs/API.md` 中的接口定义与实际代码不完全匹配
- 例如: 登录接口的请求参数

**API 文档中**:
```json
{
  "class": "一班",
  "student_id": "01",
  "student_name": "张三"
}
```

**实际代码中**:
```go
type LoginRequest struct {
    StudentID   string `json:"student_id"`
    StudentName string `json:"student_name"`
    // 缺少 class 字段
}
```

**解决方案**:
- 更新 API 文档以匹配实际实现
- 或修改代码以匹配 API 文档

---

## 🟢 改进建议

### 6. 缺少错误码统一定义

**问题描述**:
- 错误信息直接使用字符串
- 没有统一的错误码

**建议**:
```go
const (
    ErrCodeSuccess        = 0
    ErrCodeInvalidParam   = 1001
    ErrCodeClassNotFound  = 1002
    ErrCodeSubjectNotFound = 1003
    // ...
)
```

---

### 7. 缺少单元测试

**问题描述**:
- 项目没有测试文件
- 无法保证代码质量

**建议**:
- 添加 `main_test.go`
- 测试核心功能:
  - 配置加载
  - 文件命名
  - 路径生成
  - 登录验证

---

### 8. 日志功能可以增强

**当前实现**:
- 简单的文本日志
- 没有日志级别
- 没有日志轮转

**建议**:
- 添加日志级别 (DEBUG, INFO, WARN, ERROR)
- 实现日志轮转 (按大小或日期)
- 添加结构化日志

---

### 9. 缺少健康检查接口

**问题描述**:
- 没有健康检查接口
- 无法监控服务状态

**建议**:
```go
http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{
        "status": "ok",
        "version": buildVersion,
    })
})
```

---

### 10. 文件上传缺少限制

**问题描述**:
- 没有文件大小限制
- 没有文件类型限制
- 可能导致滥用

**建议**:
```go
// 限制文件大小为 100MB
r.ParseMultipartForm(100 << 20)

// 限制文件类型
allowedExts := []string{".doc", ".docx", ".pdf", ".zip"}
```

---

### 11. 缺少配置验证

**问题描述**:
- 加载配置后没有验证
- 可能导致运行时错误

**建议**:
```go
func validateConfig(cfg *Config) error {
    if cfg.ServerAddr == "" {
        return errors.New("server_addr 不能为空")
    }
    if cfg.UploadDir == "" {
        return errors.New("upload_dir 不能为空")
    }
    // 更多验证...
    return nil
}
```

---

### 12. 前端缺少加载状态

**问题描述**:
- 配置加载时没有提示
- 用户体验不佳

**建议**:
- 添加加载动画
- 显示加载进度
- 处理加载失败情况

---

## 📋 问题优先级

| 优先级 | 问题编号 | 问题描述 | 状态 | 处理时间 |
|--------|---------|---------|------|----------|
| P0 | 1 | 配置结构不匹配 | ✅ 已解决 | 2026-01-21 |
| P0 | 2 | 班级选择逻辑冲突 | ✅ 已解决 | 2026-01-21 |
| P1 | 3 | config.toml 未使用 | 🔴 待处理 | 计划中 |
| P1 | 4 | 缺少 INDEX.md | 🟢 已存在 | - |
| P1 | 5 | API 文档不一致 | 🔴 待处理 | 计划中 |
| P2 | 6-12 | 改进建议 | ⏸️ 暂缓 | 下个版本 |

---

## 🔧 修复计划

### ✅ 第一阶段 (已完成 - 2026-01-21)

1. ✅ 修复配置结构不匹配问题
   - 恢复 `main.go` 文件
   - 更新 `static/index.html` 文件
   - 实现以科目为中心的配置结构
2. ✅ 统一班级选择逻辑
   - 移除 `--class` 命令行参数
   - 前端实现班级下拉选择
   - 后端支持多班级验证
3. ✅ 更新文档
   - 更新 `docs/ISSUES.md` 标记已解决问题

### 第二阶段 (功能完善)

1. 添加单元测试
2. 增强日志功能
3. 添加文件上传限制

### 第三阶段 (优化提升)

1. 添加健康检查
2. 优化前端体验
3. 完善错误处理

---

## 📝 更新记录

| 日期 | 更新内容 | 更新人 |
|------|---------|--------|
| 2026-01-21 | 创建问题清单 | Kiro |
| 2026-01-21 | 修复配置结构不匹配问题 | Kiro |
| 2026-01-21 | 修复班级选择逻辑冲突 | Kiro |
| 2026-01-21 | 更新问题状态 | Kiro |

