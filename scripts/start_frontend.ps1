# QVAC Hackathon — 启动前端 Electron UI
# 用法: .\scripts\start_frontend.ps1

$Root = Split-Path -Parent $PSScriptRoot

Write-Host "=== 启动 QVAC 前端 Electron 应用 ===" -ForegroundColor Cyan

Push-Location "$Root\frontend"
npm start
Pop-Location
