# QVAC Assistant — 启动后端守护进程
# 用法: .\scripts\start_backend.ps1

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
    exit 1
}

Write-Host "=== 启动 QVAC 后端守护进程 ===" -ForegroundColor Cyan
Write-Host "  Python: $PythonPath" -ForegroundColor Gray
Write-Host "  绑定: 127.0.0.1:18888" -ForegroundColor Gray
Write-Host ""

Push-Location "$Root"
& $PythonPath -m uvicorn backend.main:app --host 127.0.0.1 --port 18888 --log-level info
Pop-Location
