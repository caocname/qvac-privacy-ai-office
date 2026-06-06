﻿# QVAC Assistant — 一键全栈启动
# 架构: Backend (:18888) → Frontend (Electron, 内嵌 Bridge :18889)
# 用法: .\scripts\dev.ps1 [-Dev]

param([switch]$Dev)

$ErrorActionPreference = "SilentlyContinue"
$Root = Split-Path -Parent $PSScriptRoot

# Python 路径自动发现
$PythonPath = $null
$candidates = @(
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "C:\Python312\python.exe",
    "C:\Program Files\Python312\python.exe"
)
foreach ($cand in $candidates) {
    if (Test-Path $cand) { $PythonPath = $cand; break }
}
if (-not $PythonPath) {
    try { $PythonPath = (Get-Command python -ErrorAction Stop).Source } catch {}
}
if (-not $PythonPath) {
    Write-Host "[ERROR] 未找到 Python 3.12。请先运行 setup.ps1" -ForegroundColor Red
    Read-Host "按任意键退出"
    exit 1
}

Write-Host "=== QVAC Assistant 全栈启动 ===" -ForegroundColor Cyan

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

# 1. Backend (Python FastAPI)
Write-Host "[1/2] 启动 Backend (127.0.0.1:18888)..." -ForegroundColor Yellow
$backend = Start-Process -FilePath $PythonPath `
    -ArgumentList "-m uvicorn backend.main:app --host 127.0.0.1 --port 18888 --log-level warning" `
    -WorkingDirectory $Root -PassThru -WindowStyle Minimized
Write-Host "  Backend PID: $($backend.Id)" -ForegroundColor Gray
Start-Sleep -Seconds 3

# 2. Frontend (Electron, 内嵌 Bridge)
Write-Host "[2/2] 启动 Electron 前端 (内嵌 Bridge)..." -ForegroundColor Yellow
Push-Location "$Root\frontend"
try {
    if ($Dev) {
        npx electron . --dev
    } else {
        npx electron .
    }
} finally {
    Pop-Location
}

# 前端退出后清理
Write-Host "`n=== 正在关闭后台服务 ===" -ForegroundColor Cyan
if (!$backend.HasExited) { Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue }
Write-Host "=== 已停止 ===" -ForegroundColor Green
