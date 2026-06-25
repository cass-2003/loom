# 构建 Workbench 桌面版 exe（独立原生窗口程序，目标机无需安装 Python）
#
# 前置：pip install pyinstaller pywebview
#       目标机需有 WebView2 Runtime（Windows 11 默认自带）
# 用法：在仓库根目录执行
#   powershell -ExecutionPolicy Bypass -File build_exe.ps1
#
# 产物：dist\Workbench.exe —— 双击即开一个原生窗口（无浏览器外壳）。
#   后端 HTTP 服务跑在后台线程并自动挑空闲端口；以 exe 所在文件夹为工作根。
#   入口 desktop.py 用 pywebview 起窗口；server.py 仍可单独 `python server.py` 跑浏览器版。

Set-Location $PSScriptRoot

# 若有正在运行的实例会锁住产物文件，先停掉
Get-Process Workbench -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

# --windowed：GUI 程序，不带控制台黑窗
# --add-data "static;static"：把整个 static/（含 vendor 离线库）打进 exe（运行时解压到 _MEIPASS）
# 入口 desktop.py 会 import server，PyInstaller 自动一并打包
pyinstaller --noconfirm --onefile --name Workbench --add-data "static;static" --icon icon.ico --windowed desktop.py

if (Test-Path dist\Workbench.exe) {
    $mb = [math]::Round((Get-Item dist\Workbench.exe).Length / 1MB, 1)
    Write-Host ""
    Write-Host "[OK] 构建完成: dist\Workbench.exe ($mb MB)" -ForegroundColor Green
    Write-Host "     双击运行 → 弹出原生窗口（无浏览器外壳），以 exe 所在文件夹为工作根"
    Write-Host "     指定工作根: Workbench.exe D:\notes"
} else {
    Write-Host "[FAIL] 未生成 exe，请检查上面的 PyInstaller 输出" -ForegroundColor Red
    exit 1
}
