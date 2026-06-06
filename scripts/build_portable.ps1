# QVAC Assistant — 绿色免安装便携版构建脚本
# 输出: dist/QVAC Assistant/ (可分发目录，不含 @qvac 和模型文件)
param(
    [switch]$SkipPyInstaller,
    [switch]$SkipElectronBuild,
    [switch]$SkipArchive
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Dist = "$Root\dist\QVAC Assistant"
$TempDir = "$Root\dist\.build_temp"
$PythonPath = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
if (-not (Test-Path $PythonPath)) {
    try { $PythonPath = (Get-Command python -ErrorAction Stop).Source } catch {}
}
$ArchiveName = "QVAC-Assistant-Portable-v1.0.0.zip"

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   QVAC Assistant — 绿色免安装便携版构建              ║" -ForegroundColor Cyan
Write-Host "║   输出不含 @qvac SDK 和模型文件                      ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ---- Clean ----
Write-Host "[1/7] 清理旧构建..." -ForegroundColor Yellow
if (Test-Path $Dist) { Remove-Item -Recurse -Force $Dist }
if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
New-Item -ItemType Directory -Path $Dist -Force | Out-Null
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
Write-Host "  [OK] 清理完成"

# ---- PyInstaller: backend.exe ----
if (-not $SkipPyInstaller) {
    Write-Host "[2/7] PyInstaller — backend.exe (Python 后端)..." -ForegroundColor Yellow
    Push-Location $Root
    try {
        & $PythonPath -m PyInstaller backend\pyinstaller.spec --distpath "$TempDir\backend" --workpath "$TempDir\pyi_backend" --clean --noconfirm 2>&1
        if ($LASTEXITCODE -ne 0) { throw "PyInstaller backend failed" }
        Write-Host "  [OK] backend.exe"
    } finally { Pop-Location }
}

# ---- PyInstaller: 安装依赖.exe ----
if (-not $SkipPyInstaller) {
    Write-Host "[3/7] PyInstaller — 安装依赖.exe..." -ForegroundColor Yellow
    Push-Location $Root
    try {
        & $PythonPath -m PyInstaller scripts\installer.spec --distpath "$TempDir\installer" --workpath "$TempDir\pyi_installer" --clean --noconfirm 2>&1
        if ($LASTEXITCODE -ne 0) { throw "PyInstaller installer failed" }
        Write-Host "  [OK] 安装依赖.exe"
    } finally { Pop-Location }
}

# ---- PyInstaller: 一键启动.exe (New) ----
if (-not $SkipPyInstaller) {
    Write-Host "[4/7] PyInstaller — 一键启动.exe..." -ForegroundColor Yellow
    Push-Location $Root
    try {
        & $PythonPath -m PyInstaller scripts\launcher.spec --distpath "$TempDir\launcher" --workpath "$TempDir\pyi_launcher" --clean --noconfirm 2>&1
        if ($LASTEXITCODE -ne 0) { throw "PyInstaller launcher failed" }
        Write-Host "  [OK] 一键启动.exe"
    } finally { Pop-Location }
}

# ---- Electron: portable dir build ----
if (-not $SkipElectronBuild) {
    Write-Host "[5/7] Electron builder — 前端应用..." -ForegroundColor Yellow
    Push-Location "$Root\frontend"
    try {
        # 确保 node_modules 存在
        if (-not (Test-Path "node_modules\electron\dist\electron.exe")) {
            Write-Host "  正在安装 Electron 依赖..." -ForegroundColor Gray
            npm install --no-audit --no-fund 2>&1 | Out-Null
        }
        # 构建 unpacked 目录 (不含 @qvac)
        npx electron-builder --dir --win --x64 2>&1
        if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
        Write-Host "  [OK] dist/win-unpacked/"
    } finally { Pop-Location }
}

# ---- Assemble final portable directory ----
Write-Host "[6/7] 组装便携版目录..." -ForegroundColor Yellow

# Copy Electron unpacked files (frontend output)
$Unpacked = "$Root\dist\win-unpacked"
if (Test-Path $Unpacked) {
    Write-Host "  复制 Electron 运行时..."
    Copy-Item -Recurse "$Unpacked\*" $Dist
    # Clean up
    Remove-Item -Recurse -Force $Unpacked
}
else {
    Write-Host "  [WARN] 未找到 Electron 构建输出，检查路径: $Unpacked"
}

# Clean up builder artifacts
foreach ($f in @("builder-effective-config.yaml", "builder-debug.yml")) {
    $p = "$Dist\$f"
    if (Test-Path $p) { Remove-Item $p }
}

# ---- Process @qvac: remove from output, create empty placeholder ----
$QvacOutput = "$Dist\resources\app\node_modules\@qvac"
if (Test-Path $QvacOutput) {
    Write-Host "  移除打包的 @qvac (用户需手动复制)..."
    Remove-Item -Recurse -Force $QvacOutput
}
# Create empty @qvac directory with README
New-Item -ItemType Directory -Path $QvacOutput -Force | Out-Null
@"
========================================
  QVAC SDK 占位目录
========================================

请将 @qvac 整个文件夹复制到此目录。

获取方式:
  1. 从已有的 QVAC SDK 安装中复制 frontend/node_modules/@qvac/
  2. 在有网络的环境中执行:
     cd resources/app
     npm install @qvac/sdk

正常安装后，本目录应包含以下子目录:
  sdk, llm-llamacpp, embed-llamacpp, transcription-whispercpp,
  tts-onnx, onnx, rag, decoder-audio, error, logging, 等
"@ | Out-File -FilePath "$QvacOutput\请将@qvac包放入此目录.txt" -Encoding UTF8

Write-Host "  [OK] @qvac 占位目录已创建"

# Copy backend.exe
$BackendExe = "$TempDir\backend\backend.exe"
if (Test-Path $BackendExe) {
    $BackendTarget = "$Dist\resources\backend"
    New-Item -ItemType Directory -Path $BackendTarget -Force | Out-Null
    Copy-Item $BackendExe $BackendTarget
    Write-Host "  [OK] backend.exe → resources/backend/"
}

# Copy 安装依赖.exe
$InstallerExe = "$TempDir\installer\安装依赖.exe"
if (Test-Path $InstallerExe) {
    Copy-Item $InstallerExe $Dist
    Write-Host "  [OK] 安装依赖.exe"
}

# Copy 一键启动.exe
$LauncherExe = "$TempDir\launcher\一键启动.exe"
if (Test-Path $LauncherExe) {
    Copy-Item $LauncherExe $Dist
    Write-Host "  [OK] 一键启动.exe"
}

# Copy fallback Python scripts
Copy-Item "$Root\scripts\install_deps.py" $Dist
Copy-Item "$Root\scripts\launcher.py" $Dist

# Copy backend source + requirements.txt (for pip install)
$BackendSrc = "$Dist\backend"
New-Item -ItemType Directory -Path $BackendSrc -Force | Out-Null
Get-ChildItem "$Root\backend" -File | ForEach-Object {
    Copy-Item $_.FullName $BackendSrc
}
Write-Host "  [OK] backend 源码已复制"

# Create data directories (models dir with placeholder)
$DataDirs = @(
    "$Dist\data",
    "$Dist\data\models",
    "$Dist\data\uploads",
    "$Dist\data\faiss_indices",
    "$Dist\data\logs"
)
foreach ($d in $DataDirs) {
    New-Item -ItemType Directory -Path $d -Force | Out-Null
}

# models placeholder
@"
========================================
  模型文件占位目录
========================================

请将以下 3 个模型文件放入本目录:

  1. Llama-3.2-1B-Instruct-Q4_0.gguf  (~773 MB) — LLM 对话模型
  2. gte-large_fp16.gguf               (~670 MB) — Embedding 向量模型
  3. ggml-base.bin                     (~148 MB) — ASR 语音转写模型

所有文件必须保持原始文件名，请勿重命名。
"@ | Out-File -FilePath "$Dist\data\models\请将模型文件放入此目录.txt" -Encoding UTF8

# uploads placeholder
@"
此目录用于存放用户上传的知识库文件。
程序运行时会自动将上传文件保存在此。
"@ | Out-File -FilePath "$Dist\data\uploads\说明.txt" -Encoding UTF8

Write-Host "  [OK] 数据目录和占位文件已创建"

# ---- Generate README ----
Write-Host "[7/7] 生成使用说明书..." -ForegroundColor Yellow

$Readme = @"
╔══════════════════════════════════════════════════════════╗
║          QVAC Assistant — 绿色免安装便携版               ║
║          v1.0.0  |  Apache 2.0 开源                      ║
╚══════════════════════════════════════════════════════════╝

【系统要求】
  • Windows 10/11 x64
  • 16 GB RAM (建议)
  • NVIDIA RTX 3060 6GB+ 或等效 GPU
  • 约 6 GB 磁盘空间 (含模型和 SDK)

【安装步骤 — 请严格按顺序执行】

  ◆ 第 1 步: 放置模型文件
    将以下 3 个文件放入 data\models\ 目录:
      - Llama-3.2-1B-Instruct-Q4_0.gguf (773 MB)
      - gte-large_fp16.gguf (670 MB)
      - ggml-base.bin (148 MB)
    ⚠ 文件名必须完全一致，请勿修改！

  ◆ 第 2 步: 放置 QVAC SDK
    将 @qvac 整个文件夹复制到:
      resources\app\node_modules\@qvac\

    @qvac 包的获取方式:
    a) 从已有开发环境的 frontend\node_modules\@qvac\ 复制
    b) 在联网环境中，进入 resources\app\ 目录，执行:
       npm install @qvac/sdk
       (这会从 npm 仓库下载 @qvac/sdk 及全部依赖子包)

  ◆ 第 3 步: 安装依赖
    双击运行 "安装依赖.exe"
    这将自动:
      - 检测系统环境 (Python / RAM / GPU)
      - 安装 Python 后端依赖 (pip install)
      - 检查 QVAC SDK 和模型文件是否就位
      - 创建必要的数据目录
    ⚠ 首次运行需要管理员权限安装 Python 包

【日常使用】
  模型和 SDK 就位后，直接双击 "一键启动.exe" 即可:
    - 自动启动后端服务 (127.0.0.1:18888)
    - 自动启动前端界面 (QVAC Assistant)
    - 关闭主窗口时自动停止后端

  也可以单独双击 "QVAC Assistant.exe" 直接启动
  (但启动前需要先运行 "一键启动.exe" 或手动启动后端)

【文件结构】
  QVAC Assistant\
  ├── 一键启动.exe          ← ★ 日常双击启动
  ├── 安装依赖.exe          ← ★ 首次运行前执行
  ├── QVAC Assistant.exe   ← 前端主程序 (可独立启动)
  ├── 使用说明.txt          ← 本文件
  ├── install_deps.py       ← 依赖安装脚本 (备用)
  ├── launcher.py           ← 启动器脚本 (备用)
  ├── backend\              ← Python 后端源码 + requirements.txt
  ├── resources\
  │   ├── app\              ← 前端应用代码
  │   │   ├── main.js
  │   │   ├── bridge-server.js
  │   │   ├── renderer\
  │   │   └── node_modules\
  │   │       └── @qvac\    ← ★ 第2步: QVAC SDK 放这里
  │   └── backend\          ← backend.exe (后端可执行文件)
  │       └── backend.exe
  └── data\
      ├── models\           ← ★ 第1步: 模型文件放这里
      ├── uploads\          ← 知识库上传缓存
      ├── faiss_indices\    ← FAISS 向量索引
      └── logs\             ← 运行日志

【注意事项】
  • 程序完全离线运行，不连接外部网络
  • 所有数据存储在 data\ 目录下
  • 日志文件位于 data\logs\，排查问题时请查看
  • 知识库文件上传至 data\uploads\

【常见问题】
  Q: 提示 "后端连接失败"?
  A: 确认 data\models\ 下有完整模型文件，重新运行 安装依赖.exe

  Q: 提示 "QVAC SDK 未找到"?
  A: 确认 resources\app\node_modules\@qvac\sdk\package.json 存在

  Q: 启动后页面黑屏?
  A: 检查 data\logs\ 下的日志，可能是 GPU 内存不足
     尝试关闭其他 GPU 应用后重启

  Q: pip install 失败?
  A: 打开命令行，手动执行:
     pip install -r backend\requirements.txt

  Q: 如何卸载?
  A: 直接删除整个 QVAC Assistant 文件夹即可 (绿色免安装)

══════════════════════════════════════════════════════════
  QVAC Hackathon 2026 — 离线 AI 办公助手 (通用设备赛道)
  GitHub: https://github.com/caocname/qvachackstext
  License: Apache 2.0
══════════════════════════════════════════════════════════
"@

$Readme | Out-File -FilePath "$Dist\使用说明.txt" -Encoding UTF8
Write-Host "  [OK] 使用说明.txt"

# ---- Cleanup build temp ----
Write-Host ""
Write-Host "清理构建临时文件..." -ForegroundColor Gray
if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
Remove-Item -Recurse -Force "$Root\dist\pyi_build" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$Root\dist\pyi_installer_build" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$Root\dist\pyi_launcher_build" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$Root\dist\.build_temp" -ErrorAction SilentlyContinue

# ---- Archive (optional) ----
if (-not $SkipArchive) {
    Write-Host ""
    Write-Host "生成 ZIP 压缩包..." -ForegroundColor Yellow
    Push-Location "$Root\dist"
    try {
        if (Test-Path $ArchiveName) { Remove-Item $ArchiveName }
        # Use Compress-Archive (built-in on Windows)
        Compress-Archive -Path "QVAC Assistant" -DestinationPath $ArchiveName -CompressionLevel Optimal -Force
        $zipSize = [math]::Round((Get-Item $ArchiveName).Length / 1MB, 1)
        Write-Host "  [OK] $ArchiveName ($zipSize MB)"
    } finally { Pop-Location }
}

# ---- Summary ----
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  便携版构建完成!                                    ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  输出目录: $Dist" -ForegroundColor White
Write-Host ""
Write-Host "  ⚠ 注意: 分发包不含以下内容 (用户需手动补充):" -ForegroundColor Yellow
Write-Host "    1. data\models\         — 3 个模型文件" -ForegroundColor Gray
Write-Host "    2. resources\app\node_modules\@qvac\  — QVAC SDK" -ForegroundColor Gray
Write-Host ""
Write-Host "  用户操作流程:" -ForegroundColor White
Write-Host "    ① 解压 ZIP → ② 复制模型 → ③ 复制 @qvac → ④ 双击 安装依赖.exe → ⑤ 双击 一键启动.exe" -ForegroundColor Gray
Write-Host ""

# List key files
Write-Host "  关键文件:" -ForegroundColor Cyan
Get-ChildItem $Dist -File | ForEach-Object {
    $size = if ($_.Length -gt 1MB) { "$([math]::Round($_.Length/1MB,1)) MB" } else { "$([math]::Round($_.Length/1KB,1)) KB" }
    Write-Host "    $($_.Name) ($size)" -ForegroundColor Gray
}

Write-Host ""
$totalSize = [math]::Round((Get-ChildItem -Recurse $Dist | Measure-Object -Property Length -Sum).Sum / 1MB, 0)
Write-Host "  分发包总大小: ~$totalSize MB (不含 @qvac 和模型)" -ForegroundColor White
Write-Host ""
