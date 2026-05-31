# QVAC Hackathon — 启动后端守护进程
# 用法: .\scripts\start_backend.ps1

$Root = Split-Path -Parent $PSScriptRoot
$PythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $PythonCmd) { $PythonCmd = Get-Command python3 -ErrorAction SilentlyContinue }

Write-Host "=== 启动 QVAC 后端守护进程 ===" -ForegroundColor Cyan
Write-Host "  绑定: 127.0.0.1:18888" -ForegroundColor Gray
Write-Host ""

Push-Location "$Root"
& $PythonCmd.Source -m uvicorn backend.main:app --host 127.0.0.1 --port 18888 --log-level info
Pop-Location
