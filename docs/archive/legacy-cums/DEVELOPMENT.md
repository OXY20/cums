# 开发指南

## 开发环境

### 前置条件

- Go 1.18+
- Git

### 安装 Go

#### Windows
下载并安装：https://golang.org/dl/

#### macOS
```bash
brew install go
```

#### Linux
```bash
sudo apt-get install golang-go
```

## 项目结构

```
cums/
├── static/              # 前端静态文件
│   └── index.html     # 主页面
├── docs/              # 文档
├── build/             # 打包脚本
│   └── build.sh      # 跨平台打包脚本
├── .github/           # GitHub 配置
│   └── workflows/    # CI/CD 工作流
├── config.json        # 配置文件
├── CHANGELOG.md      # 更新日志
├── embed.go          # 嵌入文件
├── main.go           # 主程序入口
├── go.mod            # Go 模块定义
└── go.sum            # 依赖锁定文件
```

## 本地开发

### 1. 克隆仓库

```bash
git clone https://github.com/OXY20/cums.git
cd cums
```

### 2. 切换到开发分支

```bash
git checkout develop
```

### 3. 运行项目

```bash
go run main.go
```

### 4. 访问

打开浏览器访问 http://localhost:3000

## 开发流程

### 1. 创建功能分支

从 `develop` 分支创建新的功能分支：

```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
```

### 2. 开发和测试

修改代码并测试功能：

```bash
go run main.go
```

### 3. 提交代码

使用规范的提交信息：

```bash
git add .
git commit -m "feat: 添加新功能描述"
```

提交信息格式请参考 [提交信息规范](#提交信息规范)。

### 4. 推送并创建 Pull Request

```bash
git push -u origin feature/your-feature-name
```

然后在 GitHub 上创建 Pull Request 到 `develop` 分支。

## 代码规范

### Go 代码

1. 使用 `gofmt` 格式化代码
2. 函数和变量名使用驼峰命名法
3. 导出的函数/变量首字母大写
4. 添加必要的注释
5. 错误处理要完整

```bash
gofmt -s -w .
```

### 前端代码

1. 使用简洁的 JavaScript
2. CSS 类名使用短横线命名法
3. 添加必要的注释

### 提交信息规范

使用 Conventional Commits 格式：

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

#### 类型 (Type)

- **feat**: 新功能
- **fix**: 修复 bug
- **docs**: 文档更新
- **style**: 代码格式（不影响功能）
- **refactor**: 重构
- **perf**: 性能优化
- **test**: 测试相关
- **chore**: 构建过程或辅助工具的变动

#### 示例

```
feat: 添加文件上传功能

支持上传多种文件格式，自动重命名文件。

Closes #123
```

```
fix: 修复登录验证问题

当班级不存在时，现在会显示所有可用班级。
```

```
docs: 更新 API 文档

添加新增的版本和更新日志接口说明。
```

## 测试

### 手动测试

1. 启动服务
2. 测试登录功能
3. 测试文件上传
4. 测试关于页面
5. 检查文件命名规则

### 跨平台测试

```bash
# Windows
GOOS=windows GOARCH=amd64 go build -o cums.exe .

# Linux
GOOS=linux GOARCH=amd64 go build -o cums-linux .

# macOS
GOOS=darwin GOARCH=amd64 go build -o cums-macos .
```

## 构建和打包

### 本地构建

```bash
go build -o cums .
```

### 打包所有平台

```bash
cd build
./build.sh
```

输出目录：

```
build/
├── windows/cums_1.0.0_202601201826.exe
├── linux/cums_1.0.0_202601201826
└── darwin/cums_1.0.0_202601201826
```

## 调试

### 启用调试日志

在 `main.go` 中添加日志输出：

```go
fmt.Printf("调试信息: %v\n", variable)
```

### 使用调试器

```bash
go run -gcflags="all=-N -l" main.go
```

## 常见问题

### 端口被占用

修改 `config.json` 中的 `server_addr`：

```json
{
    "server_addr": ":8080"
}
```

### 配置文件找不到

确保 `config.json` 在以下位置之一：
- `./config.json`
- `./cums/config.json`

### 跨平台编译失败

确保安装了对应的交叉编译工具链。

## 版本发布

发布新版本需要修改 `config.json` 中的 `version` 字段，并更新 `CHANGELOG.md`。

详细发布流程请参考 [部署指南](./DEPLOYMENT.md)。
