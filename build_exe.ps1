# 构建 Workbench 桌面版 exe（独立原生窗口程序，目标机无需安装 Python）
#
# 前置：pip install pyinstaller pywebview pywinpty
#       目标机需有 WebView2 Runtime（Windows 11 默认自带）
#       pywinpty 提供 OS 级真 PTY（真回显/编码/Ctrl+C/作业控制）；--collect-all winpty
#       把它的原生件（conpty.dll / OpenConsole.exe / winpty-agent.exe / winpty.dll）打进 exe。
#       脚本模式（python server.py）没装 pywinpty 也能跑，终端自动退回 pipe 模式。
# 用法：在仓库根目录执行
#   powershell -ExecutionPolicy Bypass -File build_exe.ps1
#
# 产物：dist\Workbench.exe —— 双击即开一个原生窗口（无浏览器外壳）。
#   后端 HTTP 服务跑在后台线程并自动挑空闲端口；默认恢复上次工作区，无历史时显示欢迎页。
#   入口 desktop.py 用 pywebview 起窗口；server.py 仍可单独 `python server.py` 跑浏览器版。

Set-Location $PSScriptRoot

# 若有正在运行的实例会锁住产物文件，先停掉并**等锁真正释放**
# （500ms 常不够：PyInstaller 覆盖被锁的 exe 会静默失败、残留旧文件，构建看似成功实则没更新）
Get-Process Workbench -ErrorAction SilentlyContinue | Stop-Process -Force
for ($i = 0; $i -lt 20 -and (Get-Process Workbench -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 300 }
Start-Sleep -Milliseconds 800

# 先删旧产物：让“构建后 exe 是否存在”真实反映本次结果，而不是被上一次的旧文件骗过
Remove-Item dist\Workbench.exe -Force -ErrorAction SilentlyContinue

# --windowed：GUI 程序，不带控制台黑窗
# --add-data "static;static"：把整个 static/（含 vendor 离线库）打进 exe（运行时解压到 _MEIPASS）
# 入口 desktop.py 会 import server，PyInstaller 自动一并打包
pyinstaller --noconfirm --onefile --name Workbench --add-data "static;static" --collect-all winpty --icon icon.ico --windowed desktop.py
$pyExit = $LASTEXITCODE

# 因为上面已先删旧 exe，这里 Test-Path 为真即代表“本次确实新生成了 exe”，不再是假阳性
if ($pyExit -eq 0 -and (Test-Path dist\Workbench.exe)) {
    $mb = [math]::Round((Get-Item dist\Workbench.exe).Length / 1MB, 1)
    Write-Host ""
    Write-Host "[OK] 构建完成: dist\Workbench.exe ($mb MB)  @ $((Get-Item dist\Workbench.exe).LastWriteTime)" -ForegroundColor Green
    Write-Host "     双击运行 → 弹出原生窗口；默认恢复上次工作区，无历史时显示欢迎页"
    Write-Host "     指定工作区: Workbench.exe D:\notes"
} else {
    Write-Host "[FAIL] 构建失败 (PyInstaller exit=$pyExit)，未生成新 exe。" -ForegroundColor Red
    Write-Host "       最常见原因: 仍有 Workbench 实例占用文件锁未释放, 确认进程已退出后重试。" -ForegroundColor Red
    exit 1
}
