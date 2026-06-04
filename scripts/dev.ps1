# QVAC Hackathon — 一键全栈启动
# 手动流程: Bridge (:18889) → Backend (:18888) → Frontend (Electron)

$Root = Split-Path -Parent $PSScriptRoot
$Python = "C:\Users\lkdwy\AppData\Local\Programs\Python\Python312\python.exe"

Write-Host "=== QVAC Hackathon 全栈启动 ===" -ForegroundColor Cyan

# 清理端口残留
Write-Host "[pre] 清理残留进程..." -ForegroundColor Gray
$ports = @(18888, 18889)
foreach ($p in $ports) {
    $line = netstat -ano 2>$null | Select-String ":$p " | Select-String "LISTENING"
    if ($line) {
        $pidStr = ($line -split '\s+')[-1]
        if ($pidStr -match '^\d+$' -and [int]$pidStr -ne 0) {
            Stop-Process -Id ([int]$pidStr) -Force -ErrorAction SilentlyContinue
        }
    }
}
Start-Sleep -Seconds 1

# 1. Bridge
Write-Host "[1/3] 启动 Bridge (127.0.0.1:18889)..." -ForegroundColor Yellow
$bridge = Start-Process -FilePath "node" -ArgumentList "index.js" `
    -WorkingDirectory "$Root\bridge" -PassThru -WindowStyle Minimized
Write-Host "  Bridge PID: $($bridge.Id)" -ForegroundColor Gray
Start-Sleep -Seconds 2

# 2. Backend
Write-Host "[2/3] 启动 Backend (127.0.0.1:18888)..." -ForegroundColor Yellow
$backend = Start-Process -FilePath $Python `
    -ArgumentList "-m uvicorn backend.main:app --host 127.0.0.1 --port 18888 --log-level warning" `
    -WorkingDirectory $Root -PassThru -WindowStyle Minimized
Write-Host "  Backend PID: $($backend.Id)" -ForegroundColor Gray
Start-Sleep -Seconds 3

# 3. Frontend
Write-Host "[3/3] 启动 Electron 前端..." -ForegroundColor Yellow
Push-Location "$Root\frontend"
try {
    npx electron .
} finally {
    Pop-Location
}

# 前端退出后清理后台进程
Write-Host "`n=== 正在关闭后台服务 ===" -ForegroundColor Cyan
if (!$bridge.HasExited) { Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue }
if (!$backend.HasExited) { Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue }
Write-Host "=== 已停止 ===" -ForegroundColor Green
