# QVAC Hackathon — 一键全栈启动（开发模式）
# 用法: .\scripts\dev.ps1

$Root = Split-Path -Parent $PSScriptRoot
$PythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $PythonCmd) { $PythonCmd = Get-Command python3 -ErrorAction SilentlyContinue }

Write-Host "=== QVAC Hackathon 全栈开发启动 ===" -ForegroundColor Cyan
Write-Host ""

# 冷启动自检
Write-Host "[1/2] 冷启动自检..." -ForegroundColor Yellow
Push-Location "$Root"
& $PythonCmd.Source backend\startup_guard.py --self-check
Pop-Location

# 启动后端（后台）
Write-Host "[2/2] 启动后端 & 前端..." -ForegroundColor Yellow
Start-Process -FilePath $PythonCmd.Source -ArgumentList "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "18888", "--log-level", "info" -NoNewWindow

Start-Sleep -Seconds 2

# 启动前端
Push-Location "$Root\frontend"
npm start
Pop-Location

Write-Host "=== 开发环境已关闭 ===" -ForegroundColor Cyan
