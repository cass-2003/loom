@echo off
chcp 65001 >nul
REM Workbench 一键启动
REM 用法: 双击运行 = 以 J:\ 为根目录, 端口 8123
REM      也可拖一个文件夹到本 bat 上, 以该文件夹为根

set PORT=8123
set ROOT=%~1
if "%ROOT%"=="" set ROOT=J:\

echo 正在启动 Workbench...
echo   根目录: %ROOT%
echo   端口:   %PORT%

start "" http://127.0.0.1:%PORT%/
python "%~dp0server.py" "%ROOT%" --port %PORT%
pause
