# 部署指南

## 部署方式

### 方式一：直接运行（开发/测试）

#### 1. 准备环境

- 服务器安装 Go 1.18+
- 或使用预编译的二进制文件

#### 2. 上传文件

创建项目目录：

```bash
mkdir -p cums
cd cums
```

上传以下文件：

```
cums/
├── cums.exe (Windows) 或 cums (Linux/Mac)
├── static/
│   └── index.html
├── config.json
└── uploads/
```

#### 3. 创建配置文件

创建 `config.json`：

```json
{
    "version": "1.0.0",
    "server_addr": ":3000",
    "upload_dir": "uploads",
    "classes": {
        "一班": {
            "subjects": {
                "数学": [
                    { "name": "第一章作业" }
                ]
            }
        }
    }
}
```

#### 4. 运行服务

##### Windows
```bash
cums.exe
```

##### Linux/Mac
```bash
chmod +x cums
./cums
```

#### 5. 访问

打开浏览器访问 http://服务器IP:3000

---

### 方式二：使用 Docker

#### 1. 创建 Dockerfile

```dockerfile
# 构建阶段
FROM golang:1.20-alpine AS builder

WORKDIR /app
COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o cums .

# 运行阶段
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

COPY --from=builder /app/cums .
COPY --from=builder /app/static ./static
COPY --from=builder /app/config.json .

EXPOSE 3000

CMD ["./cums"]
```

#### 2. 构建镜像

```bash
docker build -t cums:latest .
```

#### 3. 运行容器

```bash
docker run -d \
  --name cums \
  -p 3000:3000 \
  -v $(pwd)/uploads:/root/uploads \
  -v $(pwd)/config.json:/root/config.json \
  cums:latest
```

---

### 方式三：使用 Systemd（Linux 服务）

#### 1. 创建服务文件

创建 `/etc/systemd/system/cums.service`：

```ini
[Unit]
Description=CUMS File Upload System
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/cums
ExecStart=/opt/cums/cums
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

#### 2. 启动服务

```bash
systemctl daemon-reload
systemctl enable cums
systemctl start cums
```

#### 3. 查看状态

```bash
systemctl status cums
```

#### 4. 查看日志

```bash
journalctl -u cums -f
```

---

### 方式四：使用 Nginx 反向代理

#### 1. 配置 Nginx

创建 `/etc/nginx/conf.d/cums.conf`：

```nginx
upstream cums_backend {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://cums_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 文件上传大小限制
        client_max_body_size 100M;
    }

    # 静态文件缓存
    location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
        proxy_pass http://cums_backend;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

#### 2. 重启 Nginx

```bash
nginx -t
nginx -s reload
```

---

## 配置说明

### 修改端口

编辑 `config.json`：

```json
{
    "server_addr": ":8080"
}
```

### 自定义上传路径

```json
{
    "upload_dir": "/data/uploads"
}
```

或为特定作业指定路径：

```json
{
    "classes": {
        "一班": {
            "subjects": {
                "数学": [
                    { "name": "第一章作业", "upload_path": "/data/math" }
                ]
            }
        }
    }
}
```

---

## 安全建议

### 1. 使用 HTTPS

使用 Nginx 或 Caddy 配置 SSL 证书。

### 2. 设置防火墙

只开放必要端口：

```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

### 3. 文件上传限制

在 Nginx 中限制上传大小：

```nginx
client_max_body_size 100M;
```

### 4. 使用非 root 用户

创建专用用户运行服务：

```bash
useradd -r -s /bin/false cums
chown -R cums:cums /opt/cums
```

---

## 备份策略

### 配置备份

```bash
cp config.json config.json.backup.$(date +%Y%m%d)
```

### 文件备份

```bash
tar -czf uploads_backup_$(date +%Y%m%d).tar.gz uploads/
```

### 自动备份脚本

创建 `backup.sh`：

```bash
#!/bin/bash
BACKUP_DIR="/opt/backup"
DATE=$(date +%Y%m%d)

# 备份配置
cp /opt/cums/config.json $BACKUP_DIR/config_$DATE.json

# 备份文件
tar -czf $BACKUP_DIR/uploads_$DATE.tar.gz /opt/cums/uploads/

# 删除30天前的备份
find $BACKUP_DIR -mtime +30 -delete
```

添加到 crontab：

```bash
crontab -e
```

每天凌晨2点备份：

```
0 2 * * * /opt/scripts/backup.sh
```

---

## 监控

### 健康检查

添加健康检查接口（可选）：

```go
http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
})
```

### 日志监控

使用 `journalctl`：

```bash
journalctl -u cums -f --since today
```

---

## 升级

### 1. 备份

```bash
cp config.json config.json.backup
cp -r uploads uploads.backup
```

### 2. 下载新版本

```bash
wget https://github.com/OXY20/cums/releases/download/v1.0.1/cums_1.0.1_linux_amd64
mv cums_1.0.1_linux_amd64 cums
chmod +x cums
```

### 3. 重启服务

```bash
systemctl restart cums
```

### 4. 验证

```bash
systemctl status cums
curl http://localhost:3000/api/v1/version
```

---

## 故障排查

### 服务无法启动

1. 检查端口是否被占用：
```bash
netstat -tulpn | grep 3000
```

2. 检查配置文件：
```bash
./cums --check-config
```

3. 查看日志：
```bash
journalctl -u cums -n 100
```

### 文件上传失败

1. 检查目录权限：
```bash
ls -la uploads/
```

2. 检查磁盘空间：
```bash
df -h
```

### 无法访问

1. 检查防火墙：
```bash
ufw status
```

2. 检查服务状态：
```bash
systemctl status cums
```

3. 测试端口：
```bash
telnet localhost 3000
```
