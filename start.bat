@echo off
chcp 65001 >nul
REM Loom 一键启动
REM 用法: 双击运行 = 恢复上次工作区（无历史则欢迎页）
REM      拖文件夹到本 bat = 以该文件夹为根

set PORT=8123
set ROOT=%~1

echo 正在启动 Loom...
echo   端口: %PORT%

start "" http://127.0.0.1:%PORT%/
if "%ROOT%"=="" (
  python "%~dp0server.py" --port %PORT%
) else (
  echo   根目录: %ROOT%
  python "%~dp0server.py" "%ROOT%" --port %PORT%
)
pause
