# 贡献指南

感谢你考虑为 CUMS 做出贡献！

## 如何贡献

### 报告问题

1. 检查 [Issues](https://github.com/OXY20/cums/issues) 是否已有相同问题
2. 如果没有，创建新 Issue，包含：
   - 清晰的标题
   - 详细的问题描述
   - 复现步骤
   - 预期行为和实际行为
   - 环境信息（操作系统、Go版本等）
   - 截图或日志（如有）

### 提出建议

1. 检查 [Issues](https://github.com/OXY20/cums/issues) 是否已有相同建议
2. 如果没有，创建新 Issue，包含：
   - 清晰的标题
   - 功能的详细描述
   - 使用场景
   - 可能的实现方式

### 提交代码

#### 1. Fork 项目

点击 GitHub 页面右上角的 "Fork" 按钮。

#### 2. 克隆你的 Fork

```bash
git clone https://github.com/OXY20/cums.git
cd cums
```

#### 3. 添加上游仓库

```bash
git remote add upstream https://github.com/OXY20/cums.git
```

#### 4. 创建功能分支

从 `develop` 分支创建新分支：

```bash
git checkout develop
git pull upstream develop
git checkout -b feature/your-feature-name
```

分支命名规范：

- `feature/xxx` - 新功能
- `fix/xxx` - Bug 修复
- `docs/xxx` - 文档更新
- `refactor/xxx` - 重构
- `test/xxx` - 测试相关
- `chore/xxx` - 构建或工具更新

#### 5. 开发和测试

- 编写代码
- 测试功能
- 确保代码符合规范

```bash
go run main.go
```

#### 6. 提交代码

使用规范的提交信息：

```bash
git add .
git commit -m "feat: 添加新功能"
```

提交信息格式请参考 [提交信息规范](#提交信息规范)。

#### 7. 同步上游

```bash
git fetch upstream
git rebase upstream/develop
```

#### 8. 推送并创建 Pull Request

```bash
git push origin feature/your-feature-name
```

然后在 GitHub 上创建 Pull Request 到 `develop` 分支。

PR 标题和描述应包含：

- 清晰的标题（使用提交信息格式）
- 详细的描述
- 相关的 Issue 编号（如有）
- 测试说明
- 截图（如有）

## 代码规范

### Go 代码

1. **格式化**

```bash
gofmt -s -w .
```

2. **命名规范**
   - 包名：小写，简短
   - 函数/变量：驼峰命名法
   - 常量：大写+下划线
   - 导出：首字母大写

3. **注释**
   - 导出的函数/变量必须添加注释
   - 复杂逻辑添加行内注释

```go
// LoginHandler 处理用户登录请求
func LoginHandler(w http.ResponseWriter, r *http.Request) {
    // 验证班级是否存在
    if _, exists := config.Classes[req.Class]; !exists {
        // ...
    }
}
```

4. **错误处理**

```go
if err != nil {
    return fmt.Errorf("操作失败: %w", err)
}
```

### 前端代码

1. **命名规范**
   - HTML 类名：短横线命名法 (class-name)
   - 变量/函数：驼峰命名法
   - 常量：大写+下划线

2. **代码风格**
   - 使用简洁的 JavaScript
   - 适当的缩进和空行
   - 添加必要的注释

```javascript
// 加载配置信息
async function loadConfig() {
    try {
        const response = await fetch('/api/v1/config');
        const result = await response.json();
        if (result.success) {
            configData = result.data;
        }
    } catch (error) {
        console.error('加载配置失败:', error);
    }
}
```

## 提交信息规范

使用 Conventional Commits 格式：

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### 类型 (Type)

| 类型 | 说明 |
|------|------|
| feat | 新功能 |
| fix | Bug 修复 |
| docs | 文档更新 |
| style | 代码格式（不影响功能） |
| refactor | 重构 |
| perf | 性能优化 |
| test | 测试相关 |
| chore | 构建过程或辅助工具的变动 |

### 示例

#### 新功能

```
feat: 添加批量上传功能

支持一次选择多个文件上传，提高效率。

Closes #123
```

#### Bug 修复

```
fix: 修复文件命名重复问题

同名文件现在会自动添加时间戳后缀。

Fixes #456
```

#### 文档更新

```
docs: 更新部署文档

添加 Docker 部署方式说明。
```

#### 重构

```
refactor: 优化配置加载逻辑

统一配置文件查找顺序，提高可维护性。
```

## Pull Request 审核

### 审核 checklist

在提交 PR 之前，请确认：

- [ ] 代码通过所有测试
- [ ] 代码符合项目规范
- [ ] 添加了必要的注释
- [ ] 更新了相关文档
- [ ] 提交信息符合规范
- [ ] PR 标题和描述清晰

### 审核流程

1. 自动检查：CI 会自动运行测试
2. 代码审查：维护者会审查代码
3. 修改：根据反馈进行修改
4. 合并：通过审核后合并到 `develop` 分支

## 发布流程

### 1. 创建发布分支

```bash
git checkout develop
git checkout -b release/v1.0.1
```

### 2. 更新版本号

修改 `config.json` 和 `CHANGELOG.md`。

### 3. 测试

进行完整的功能测试。

### 4. 合并到 master

```bash
git checkout master
git merge release/v1.0.1
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin master --tags
```

### 5. 合并回 develop

```bash
git checkout develop
git merge release/v1.0.1
git push origin develop
```

## 社区行为准则

- 尊重所有贡献者
- 接受建设性的批评
- 专注于对社区最有利的事情
- 表现出同理心

## 联系方式

如有疑问，可以通过以下方式联系：

- 提交 [Issue](https://github.com/OXY20/cums/issues)
- 发送邮件：your-email@example.com

## 许可证

通过贡献代码，你同意你的代码将按照项目的许可证发布。
