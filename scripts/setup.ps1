# QVAC Hackathon — 一键本地依赖安装
# 用法: .\scripts\setup.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "=== QVAC Hackathon 离线 AI 办公助手 — 依赖安装 ===" -ForegroundColor Cyan
Write-Host ""

# 1. Python 依赖
Write-Host "[1/3] 安装 Python 后端依赖..." -ForegroundColor Yellow
$PythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $PythonCmd) { $PythonCmd = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $PythonCmd) {
    Write-Host "ERROR: 未找到 Python。请安装 Python 3.12+" -ForegroundColor Red
    exit 1
}
Push-Location "$Root"
& $PythonCmd.Source -m pip install -r backend\requirements.txt -q
Pop-Location
Write-Host "  [OK] Python 依赖安装完成" -ForegroundColor Green

# 2. Node.js 依赖
Write-Host "[2/3] 安装 Node.js 前端依赖..." -ForegroundColor Yellow
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Host "ERROR: 未找到 Node.js。请安装 Node.js v22+" -ForegroundColor Red
    exit 1
}
Push-Location "$Root\frontend"
& $NodeCmd.Source -e "console.log('Node.js ' + process.version)" 2>$null
npm install --silent 2>&1 | Out-Null
Pop-Location
Write-Host "  [OK] Node.js 依赖安装完成" -ForegroundColor Green

# 3. 冷启动自检
Write-Host "[3/3] 执行冷启动自检..." -ForegroundColor Yellow
Push-Location "$Root"
& $PythonCmd.Source backend\startup_guard.py --self-check
Pop-Location

Write-Host ""
Write-Host "=== 安装完成 ===" -ForegroundColor Cyan
