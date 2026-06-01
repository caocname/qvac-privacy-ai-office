# QVAC Hackathon — 启动后端守护进程
# 用法: .\scripts\start_backend.ps1

$Root = Split-Path -Parent $PSScriptRoot

# Python 路径 (锁定 Python 3.12)
$PythonPath = "C:\Users\lkdwy\AppData\Local\Programs\Python\Python312\python.exe"
if (-not (Test-Path $PythonPath)) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $PythonPath = $cmd.Source }
    else {
        $cmd = Get-Command python3 -ErrorAction SilentlyContinue
        if ($cmd) { $PythonPath = $cmd.Source }
        else {
            Write-Host "[ERROR] 未找到 Python" -ForegroundColor Red
            exit 1
        }
    }
}

Write-Host "=== 启动 QVAC 后端守护进程 ===" -ForegroundColor Cyan
Write-Host "  Python: $PythonPath" -ForegroundColor Gray
Write-Host "  绑定: 127.0.0.1:18888" -ForegroundColor Gray
Write-Host ""

# 冷启动自检
Push-Location "$Root"
& $PythonPath backend/startup_guard.py --self-check
Pop-Location

Write-Host ""
Write-Host "启动 FastAPI 服务..." -ForegroundColor Yellow

Push-Location "$Root"
& $PythonPath -m uvicorn backend.main:app --host 127.0.0.1 --port 18888 --log-level info
Pop-Location
