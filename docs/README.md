# CUMS - 文件上传系统

一个简洁的机房文件上传系统，前端使用HTML，后端使用Go语言。

## 功能特性

- 简洁的登录界面（班级输入 + 学号姓名）
- 动态加载科目和作业列表
- 文件自动重命名：`{作业名}_{学号}_{姓名}_{时间戳}.{扩展名}`
- 支持自定义存储路径
- 跨平台支持（Windows/Linux/Mac）
- 关于页面和更新日志展示

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/OXY20/cums.git
cd cums
```

### 2. 运行系统

```bash
go run main.go
```

访问 http://localhost:3000

## 使用说明

### 登录
1. 点击"登录"按钮
2. 输入班级名称（如：一班）
3. 输入学号和姓名
4. 点击"登录"

### 上传文件
1. 选择科目
2. 选择作业
3. 选择文件
4. 点击"上传文件"

## 配置

编辑 `config.json` 文件配置班级、科目和作业：

```json
{
    "version": "1.0.0",
    "server_addr": ":3000",
    "upload_dir": "uploads",
    "classes": {
        "一班": {
            "subjects": {
                "数学": [
                    { "name": "第一章作业" },
                    { "name": "第二章作业" }
                ]
            }
        }
    }
}
```

详细配置说明请参考 [配置文档](./CONFIG.md)。

## API 文档

详细的 API 文档请参考 [API 文档](./API.md)。

## 文件命名规则

上传文件自动重命名：

```
{作业名}_{学号}_{姓名}_{时间戳}.{扩展名}
```

示例：`第一章作业_01_张三_20260120120000.docx`

## 项目结构

```
cums/
├── static/           # 前端文件
│   └── index.html   # 主页面
├── docs/            # 文档
├── config.json      # 配置文件
├── CHANGELOG.md    # 更新日志
├── embed.go        # 嵌入文件
├── main.go         # 后端主程序
└── go.mod          # Go模块
```

## 打包发布

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

## 依赖

- Go 1.18+

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request。详细贡献指南请参考 [贡献指南](./CONTRIBUTING.md)。
