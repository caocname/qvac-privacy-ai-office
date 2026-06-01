# QVAC Hackathon — 一键全栈启动（V0.2 开发模式）
# 用法: .\scripts\dev.ps1

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$PythonPath = "C:\Users\lkdwy\AppData\Local\Programs\Python\Python312\python.exe"
if (-not (Test-Path $PythonPath)) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $PythonPath = $cmd.Source }
    else {
        $cmd = Get-Command python3 -ErrorAction SilentlyContinue
        if ($cmd) { $PythonPath = $cmd.Source }
        else { Write-Host "[ERROR] 未找到 Python 3.12" -ForegroundColor Red; exit 1 }
    }
}

Write-Host "=== QVAC Hackathon V0.2 全栈启动 ===" -ForegroundColor Cyan
Write-Host "  Python: $PythonPath" -ForegroundColor Gray
Write-Host ""

Write-Host "[1/4] 冷启动自检..." -ForegroundColor Yellow
Push-Location "$Root"
& $PythonPath backend/startup_guard.py --self-check
if ($LASTEXITCODE -ne 0) { Write-Host "  [WARN] 自检有告警，继续启动..." -ForegroundColor Yellow }
Pop-Location
Write-Host ""

Write-Host "[2/4] 启动 Bridge 服务 (127.0.0.1:18889)..." -ForegroundColor Yellow
$bridgeDir = Join-Path $Root "bridge"
if (-not (Test-Path (Join-Path $bridgeDir "node_modules"))) {
    Write-Host "  [ERROR] Bridge 依赖未安装" -ForegroundColor Red
    Write-Host "  请先执行：cd bridge; npm install" -ForegroundColor Gray
    exit 1
}

$bridgeProc = Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $bridgeDir -PassThru
Write-Host "  Bridge PID: $($bridgeProc.Id)" -ForegroundColor Gray
Write-Host "  等待 Bridge 就绪..." -ForegroundColor Gray

$retries = 0; $bridgeReady = $false
do {
    Start-Sleep -Milliseconds 800
    $retries++
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:18889/health" -TimeoutSec 1 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { Write-Host "  [OK] Bridge 已就绪" -ForegroundColor Green; $bridgeReady = $true; break }
    } catch {}
} while ($retries -lt 30)

if (-not $bridgeReady) { Write-Host "  [ERROR] Bridge 启动超时" -ForegroundColor Red; exit 1 }
Write-Host ""

Write-Host "[3/4] 启动后端 API (127.0.0.1:18888)..." -ForegroundColor Yellow
$backendProc = Start-Process -FilePath $PythonPath `
    -ArgumentList "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "18888", "--log-level", "info" `
    -WorkingDirectory $Root -PassThru

Write-Host "  后端 PID: $($backendProc.Id)" -ForegroundColor Gray
Write-Host "  等待后端就绪（含模型加载，可能需要 30-60s）..." -ForegroundColor Gray

$retries = 0; $backendReady = $false
do {
    Start-Sleep -Seconds 1
    $retries++
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:18888/health" -TimeoutSec 1 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { Write-Host "  [OK] 后端已就绪" -ForegroundColor Green; $backendReady = $true; break }
    } catch {}
} while ($retries -lt 90)

if (-not $backendReady) { Write-Host "  [ERROR] 后端启动超时" -ForegroundColor Red; exit 1 }
Write-Host ""

Write-Host "[4/4] 启动前端 Electron..." -ForegroundColor Yellow
$electronPath = Join-Path $Root "frontend\node_modules\.bin\electron.cmd"
if (Test-Path $electronPath) {
    Push-Location (Join-Path $Root "frontend")
    Write-Host "  运行: npx electron ." -ForegroundColor Gray
    npx electron .
    Pop-Location
} else {
    Write-Host "  [ERROR] 前端依赖未安装" -ForegroundColor Red
    Write-Host "  请先执行：cd frontend; npm install" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=== 开发环境已关闭 ===" -ForegroundColor Cyan