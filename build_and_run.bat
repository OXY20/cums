@echo off
cd /d C:\Users\ERSHI\code\cums
echo ========================================
echo   CUMS 编译和运行脚本
echo ========================================
echo.

echo [1/3] 检查 Go 环境...
go version
if errorlevel 1 (
    echo 错误: 未找到 Go 环境
    pause
    exit /b 1
)
echo.

echo [2/3] 编译程序...
go build -o cums.exe .
if errorlevel 1 (
    echo 错误: 编译失败
    pause
    exit /b 1
)
echo 编译成功！
echo.

echo [3/3] 程序信息:
dir cums.exe | findstr "cums.exe"
echo.

echo ========================================
echo   按任意键启动程序...
echo ========================================
pause

echo.
echo 正在启动 CUMS 服务器...
echo 访问地址: http://localhost:3000
echo 按 Ctrl+C 停止服务
echo.

cums.exe
