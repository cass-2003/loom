# 构建 Workbench 单文件 exe（独立运行，目标机无需安装 Python）
#
# 前置：pip install pyinstaller
# 用法：在仓库根目录执行
#   powershell -ExecutionPolicy Bypass -File build_exe.ps1
#
# 产物：dist\Workbench.exe（约 10MB，内含 Python 运行时 + static/ 全部资源）
# 双击即用：以 exe 所在文件夹为工作根，自动打开浏览器。

Set-Location $PSScriptRoot

# 若有正在运行的 Workbench.exe 会锁住产物文件，先停掉
Get-Process Workbench -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

# --add-data "static;static"：把整个 static/（含 vendor 离线库）打进 exe，
# 运行时解压到 sys._MEIPASS；server.py 已做 frozen 适配。
pyinstaller --noconfirm --onefile --name Workbench `
    --add-data "static;static" `
    --console `
    server.py

if (Test-Path dist\Workbench.exe) {
    $mb = [math]::Round((Get-Item dist\Workbench.exe).Length / 1MB, 1)
    Write-Host ""
    Write-Host "[OK] 构建完成: dist\Workbench.exe ($mb MB)" -ForegroundColor Green
    Write-Host "     双击运行 → 以 exe 所在文件夹为工作根，浏览器自动打开 http://127.0.0.1:8765"
    Write-Host "     指定根目录/端口: Workbench.exe D:\notes --port 8200"
} else {
    Write-Host "[FAIL] 未生成 exe，请检查上面的 PyInstaller 输出" -ForegroundColor Red
    exit 1
}
