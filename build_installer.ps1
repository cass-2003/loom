# Build Loom installer:
# 1) build dist\Loom.exe
# 2) compile installer\Loom.iss with Inno Setup
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build_installer.ps1
#
# Goals:
# - no fixed repo path
# - no requirement that ISCC.exe is already on PATH
# - reuse build_exe.ps1

Set-Location $PSScriptRoot

function Resolve-Iscc {
    $cmd = Get-Command iscc.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    )
    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }
    return $null
}

Write-Host "[1/2] Building desktop EXE..." -ForegroundColor Cyan
powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\build_exe.ps1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] EXE build failed. Installer build stopped." -ForegroundColor Red
    exit 1
}

$iscc = Resolve-Iscc
if (-not $iscc) {
    Write-Host "[FAIL] ISCC.exe was not found." -ForegroundColor Red
    Write-Host "       Install Inno Setup 6 or add its folder to PATH, then retry." -ForegroundColor Red
    exit 1
}

Write-Host "[2/2] Building installer..." -ForegroundColor Cyan
& $iscc "$PSScriptRoot\installer\Loom.iss"
$isExit = $LASTEXITCODE
if ($isExit -ne 0) {
    Write-Host "[FAIL] Installer build failed (ISCC exit=$isExit)" -ForegroundColor Red
    exit $isExit
}

$setup = Get-Item "$PSScriptRoot\installer\Output\Loom-Setup-0.1.0.exe" -ErrorAction SilentlyContinue
if (-not $setup) {
    Write-Host "[FAIL] Installer output was not found." -ForegroundColor Red
    exit 1
}

$mb = [math]::Round($setup.Length / 1MB, 1)
Write-Host ""
Write-Host "[OK] Installer created: $($setup.FullName) ($mb MB)  @ $($setup.LastWriteTime)" -ForegroundColor Green
