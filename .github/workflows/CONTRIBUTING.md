# Git 工作流

## 分支策略

### 主分支
- **master**: 主分支，保持稳定，只接受来自 release 分支的合并
- **develop**: 开发分支，日常开发的基础分支

### 辅助分支
- **feature/***: 功能分支，从 develop 创建，开发完成后合并回 develop
- **release/***: 发布分支，从 develop 创建，准备发布时合并到 master
- **hotfix/***: 紧急修复分支，从 master 创建，修复后合并到 master 和 develop

## 工作流程

### 开发新功能
```bash
# 1. 从 develop 创建功能分支
git checkout develop
git checkout -b feature/新功能名称

# 2. 开发并提交
git add .
git commit -m "feat: 添加新功能"

# 3. 同步最新的 develop
git checkout develop
git pull origin develop
git checkout feature/新功能名称
git merge develop

# 4. 推送并创建 PR
git push -u origin feature/新功能名称
```

### 发布版本
```bash
# 1. 从 develop 创建发布分支
git checkout develop
git checkout -b release/v1.1.0

# 2. 更新版本号
# 修改 config.json 中的 version 字段

# 3. 提交版本更新
git add .
git commit -m "chore: 准备发布 v1.1.0"

# 4. 合并到 master
git checkout master
git merge release/v1.1.0
git tag -a v1.1.0 -m "Version 1.1.0"
git push origin master --tags

# 5. 合并回 develop
git checkout develop
git merge release/v1.1.0
git push origin develop

# 6. 删除发布分支
git branch -d release/v1.1.0
```

### 紧急修复
```bash
# 1. 从 master 创建 hotfix 分支
git checkout master
git checkout -b hotfix/紧急修复描述

# 2. 修复并提交
git add .
git commit -m "fix: 修复问题描述"

# 3. 合并到 master
git checkout master
git merge hotfix/紧急修复描述
git tag -a v1.0.1 -m "Hotfix v1.0.1"
git push origin master --tags

# 4. 合并回 develop
git checkout develop
git merge hotfix/紧急修复描述
git push origin develop

# 5. 删除 hotfix 分支
git branch -d hotfix/紧急修复描述
```

## 版本号规范

使用语义化版本 (Semantic Versioning): `主版本.次版本.修订号`

- **主版本 (MAJOR):** 不兼容的 API 变更
- **次版本 (MINOR):** 向后兼容的功能新增
- **修订号 (PATCH):** 向后兼容的问题修复

## 提交信息规范

使用 Conventional Commits 格式:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### 类型 (Type)
- **feat**: 新功能
- **fix**: 修复 bug
- **docs**: 文档更新
- **style**: 代码格式（不影响功能）
- **refactor**: 重构
- **perf**: 性能优化
- **test**: 测试相关
- **chore**: 构建过程或辅助工具的变动

### 示例
```
feat: 添加文件上传功能
fix: 修复登录验证问题
docs: 更新 API 文档
chore: 更新打包脚本
```
