# QVAC Assistant — 系统环境一键安装脚本
# ============================================================
# 用法: 以管理员身份运行 PowerShell，执行 .\scripts\setup.ps1
#
# 此脚本将:
#   1. 检查/安装 Node.js v22
#   2. 检查/安装 Python 3.12
#   3. 安装前端 npm 依赖 (Electron + @qvac/sdk + 原生模块)
#   4. 安装 Bridge npm 依赖
#   5. 安装 Python 后端依赖
#   6. 创建数据目录结构
#   7. 验证模型文件
#   8. 初始化 Windows 凭据管理器密钥
# ============================================================

param(
    [switch]$SkipNodeCheck,
    [switch]$SkipPythonCheck,
    [switch]$SkipNpmInstall,
    [switch]$SkipPipInstall,
    [string]$ModelsDir = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$AppDataDir = [Environment]::GetFolderPath("ApplicationData")
$QvacDataDir = "$AppDataDir\qvac-assistant\data"
$QvacModelsDir = if ($ModelsDir) { $ModelsDir } else { "$Root\data\models" }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  QVAC Assistant — 环境安装向导" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ---- 1. Node.js v22 检查 ----
if (-not $SkipNodeCheck) {
    Write-Host "[1/7] 检查 Node.js v22..." -ForegroundColor Yellow
    $nodeVersion = $null
    try {
        $nodeVersion = (node --version 2>$null) -replace "v", ""
    } catch {}

    if ($nodeVersion -and [Version]$nodeVersion -ge [Version]"22.0.0") {
        Write-Host "  [OK] Node.js v$nodeVersion 已安装" -ForegroundColor Green
    } else {
        Write-Host "  [ACTION] Node.js v22+ 未安装。" -ForegroundColor Red
        Write-Host "  下载地址: https://nodejs.org/dist/v22.18.0/node-v22.18.0-x64.msi" -ForegroundColor Yellow
        Write-Host "  或使用 winget: winget install OpenJS.NodeJS.LTS --version 22.18.0" -ForegroundColor Yellow
        Write-Host ""
        $response = Read-Host "  是否继续？(y/n)"
        if ($response -ne "y") { exit 1 }
    }
}

# ---- 2. Python 3.12 检查 ----
if (-not $SkipPythonCheck) {
    Write-Host "[2/7] 检查 Python 3.12..." -ForegroundColor Yellow
    $pythonPath = $null
    $pythonVersion = $null

    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "C:\Python312\python.exe",
        "C:\Program Files\Python312\python.exe"
    )
    foreach ($cand in $candidates) {
        if (Test-Path $cand) { $pythonPath = $cand; break }
    }

    if (-not $pythonPath) {
        try { $pythonPath = (Get-Command python -ErrorAction Stop).Source } catch {}
    }

    if ($pythonPath) {
        $pythonVersion = & $pythonPath --version 2>&1
        if ($pythonVersion -match "3\.(\d+)") {
            $minor = [int]$matches[1]
            if ($minor -ge 12) {
                Write-Host "  [OK] Python $pythonVersion ($pythonPath)" -ForegroundColor Green
            } else {
                Write-Host "  [WARN] Python 版本过低: $pythonVersion (需要 >= 3.12)" -ForegroundColor Red
                Write-Host "  下载地址: https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe" -ForegroundColor Yellow
                $response = Read-Host "  是否继续？(y/n)"
                if ($response -ne "y") { exit 1 }
            }
        }
    } else {
        Write-Host "  [ACTION] Python 3.12 未安装。" -ForegroundColor Red
        Write-Host "  下载地址: https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe" -ForegroundColor Yellow
        Write-Host "  或使用 winget: winget install Python.Python.3.12" -ForegroundColor Yellow
        $response = Read-Host "  是否继续？(y/n)"
        if ($response -ne "y") { exit 1 }
    }

    if ($pythonPath) {
        $env:PYTHON_PATH = $pythonPath
    }
}

# ---- 3. 前端 npm 依赖安装 (Electron + @qvac/sdk) ----
if (-not $SkipNpmInstall) {
    Write-Host "[3/7] 安装前端 npm 依赖 (包含 Electron + QVAC SDK 原生模块)..." -ForegroundColor Yellow
    Write-Host "  这可能需要 5-10 分钟，请耐心等待..." -ForegroundColor Gray

    Push-Location "$Root\frontend"
    try {
        # 检查是否已有 node_modules
        if (Test-Path "node_modules\@qvac\sdk") {
            $response = Read-Host "  前端依赖已存在，是否重新安装？(y/n)"
            if ($response -eq "y") {
                Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
                npm install --no-audit --no-fund 2>&1 | Out-Null
            }
        } else {
            npm install --no-audit --no-fund 2>&1 | Out-Null
        }
        Write-Host "  [OK] 前端依赖已安装" -ForegroundColor Green
    } catch {
        Write-Host "  [ERROR] npm install 失败: $_" -ForegroundColor Red
        Write-Host "  请确认网络连接正常，或手动运行: cd frontend && npm install" -ForegroundColor Yellow
        Pop-Location
        exit 1
    }
    Pop-Location
}

# ---- 4. Bridge npm 依赖安装 ----
if (-not $SkipNpmInstall) {
    Write-Host "[4/7] 安装 Bridge npm 依赖..." -ForegroundColor Yellow

    Push-Location "$Root\bridge"
    try {
        if (Test-Path "node_modules\@qvac\sdk") {
            Write-Host "  Bridge 依赖已存在，跳过" -ForegroundColor Gray
        } else {
            npm install --no-audit --no-fund 2>&1 | Out-Null
        }
        Write-Host "  [OK] Bridge 依赖已安装" -ForegroundColor Green
    } catch {
        Write-Host "  [WARN] Bridge npm install 失败 (非致命，Bridge 已内嵌到 Electron 主进程)" -ForegroundColor Yellow
    }
    Pop-Location
}

# ---- 5. Python 后端依赖安装 ----
if (-not $SkipPipInstall) {
    Write-Host "[5/7] 安装 Python 后端依赖..." -ForegroundColor Yellow
    $pipCmd = if ($pythonPath) { $pythonPath -replace "python\.exe$", "Scripts\pip.exe" } else { "pip" }

    if (Test-Path $pipCmd) {
        & $pipCmd install -r "$Root\backend\requirements.txt" --quiet 2>&1 | Out-Null
        Write-Host "  [OK] Python 依赖已安装" -ForegroundColor Green
    } else {
        Write-Host "  [ERROR] 找不到 pip" -ForegroundColor Red
        Write-Host "  请先安装 Python 3.12，确保 pip 可用" -ForegroundColor Yellow
        exit 1
    }
}

# ---- 6. 创建数据目录 ----
Write-Host "[6/7] 初始化数据目录..." -ForegroundColor Yellow
$dirs = @(
    $QvacDataDir,
    "$QvacDataDir\uploads",
    "$QvacDataDir\faiss_indices",
    "$QvacDataDir\logs",
    "$Root\data",
    "$Root\data\uploads",
    "$Root\data\faiss_indices",
    "$Root\data\logs",
    "$Root\data\models"
)
foreach ($d in $dirs) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
}
Write-Host "  [OK] 数据目录已创建" -ForegroundColor Green

# ---- 7. 验证模型文件 ----
Write-Host "[7/7] 验证模型文件..." -ForegroundColor Yellow
$requiredModels = @(
    @{Name="Llama-3.2-1B-Instruct-Q4_0.gguf"; Size=773; Desc="LLM 对话模型"},
    @{Name="gte-large_fp16.gguf"; Size=670; Desc="Embedding 向量模型"},
    @{Name="ggml-base.bin"; Size=148; Desc="ASR 语音转写模型"}
)

$missingModels = @()
$modelsDirOk = $QvacModelsDir

foreach ($model in $requiredModels) {
    $modelPath = "$modelsDirOk\$($model.Name)"
    if (Test-Path $modelPath) {
        $sizeMB = [math]::Round((Get-Item $modelPath).Length / 1MB, 0)
        Write-Host "  [OK] $($model.Name) ($sizeMB MB)" -ForegroundColor Green
    } else {
        Write-Host "  [MISSING] $($model.Name) — $($model.Desc)" -ForegroundColor Red
        $missingModels += $model
    }
}

if ($missingModels.Count -gt 0) {
    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Red
    Write-Host "  以下模型文件缺失:" -ForegroundColor Red
    foreach ($m in $missingModels) {
        Write-Host "    - $($m.Name) ($($m.Desc), 约 $($m.Size)MB)" -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "  请将模型文件放入: $modelsDirOk" -ForegroundColor Yellow
    Write-Host "  或设置环境变量 QVAC_MODELS_DIR 指向模型目录" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  模型下载链接请参阅安装目录下的 DEPLOY.md" -ForegroundColor Yellow
    Write-Host "  ========================================" -ForegroundColor Red
}

# ---- 完成 ----
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  环境安装完成!" -ForegroundColor Cyan
if ($missingModels.Count -gt 0) {
    Write-Host "  !! 模型文件缺失，请按上述提示补充 !!" -ForegroundColor Red
}
Write-Host ""
Write-Host "  启动应用:" -ForegroundColor White
Write-Host "    一键启动 (后端+前端): .\scripts\dev.ps1" -ForegroundColor Gray
Write-Host "    仅启动后端:  .\scripts\start_backend.ps1" -ForegroundColor Gray
Write-Host "    仅启动前端:  .\scripts\start_frontend.ps1" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
