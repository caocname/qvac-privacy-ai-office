# QVAC Assistant — 启动前端 Electron UI
# 用法: .\scripts\start_frontend.ps1 [-Dev]

param([switch]$Dev)

$Root = Split-Path -Parent $PSScriptRoot

Write-Host "=== 启动 QVAC 前端 Electron 应用 ===" -ForegroundColor Cyan

if (-not (Test-Path "$Root\frontend\node_modules")) {
    Write-Host "[ERROR] 前端依赖未安装" -ForegroundColor Red
    Write-Host "请先运行: cd frontend && npm install" -ForegroundColor Gray
    exit 1
}

Push-Location "$Root\frontend"
Write-Host "启动 Electron (内嵌 Bridge :18889)..." -ForegroundColor Yellow
if ($Dev) {
    npx electron . --dev
} else {
    npx electron .
}
Pop-Location
