# QVAC Hackathon - 全栈启动 V0.4
# 架构: QVAC SDK -> Bridge (:18889) -> Backend (Python :18888) -> Frontend (Electron)
# 模型在后台异步加载，不阻塞 HTTP 服务启动。

$Root = Split-Path -Parent $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---- config ----
$PythonPath = "C:\Users\lkdwy\AppData\Local\Programs\Python\Python312\python.exe"
$BridgeDir = Join-Path $Root "bridge"
$FrontendDir = Join-Path $Root "frontend"
$LogDir = Join-Path $Root "data\logs"
$BridgeLog = Join-Path $LogDir "bridge.log"
$BackendLog = Join-Path $LogDir "backend.log"

# ---- helpers ----
function Write-Step($Msg) { Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] $Msg" -ForegroundColor Yellow }
function Write-OK($Msg) { Write-Host "  [OK] $Msg" -ForegroundColor Green }
function Write-Err($Msg) { Write-Host "  [ERROR] $Msg" -ForegroundColor Red }
function Write-Warn($Msg) { Write-Host "  [WARN] $Msg" -ForegroundColor Magenta }

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# ---- cleanup ----
function Cleanup-StaleProcesses {
    Write-Step "Cleaning up stale processes..."

    foreach ($port in @(18888, 18889)) {
        $line = netstat -ano 2>$null | Select-String ":$port " | Select-String "LISTENING"
        if ($line) {
            $parts = $line -split '\s+'
            $procId = $parts[$parts.Length - 1]
            if ($procId -match '^\d+$' -and [int]$procId -ne 0) {
                try {
                    $proc = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
                    if ($proc) {
                        Write-Warn "Killing $($proc.ProcessName) (PID: $procId) on port $port"
                        Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue
                    }
                } catch {}
            }
        }
    }

    # Clean leftover SDK worker
    Get-Process -Name "bare" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process -Name "electron" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    # Clean SDK worker lock file
    $lockFile = Join-Path $env:USERPROFILE ".qvac\.worker.lock"
    if (Test-Path $lockFile) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }

    Start-Sleep -Seconds 1
}

# ---- preflight ----
function Preflight-Checks {
    Write-Step "Preflight checks..."

    if (-not (Test-Path $PythonPath)) {
        Write-Err "Python 3.12 not found: $PythonPath"
        Pause; return $false
    }
    $pyVer = & $PythonPath --version 2>&1
    Write-OK "Python: $pyVer"

    $nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodeCmd) {
        Write-Err "Node.js not found."
        Pause; return $false
    }
    $nodeVer = & node --version 2>&1
    Write-OK "Node.js: $nodeVer"

    if (-not (Test-Path (Join-Path $BridgeDir "node_modules"))) {
        Write-Err "Bridge dependencies not installed. Run: cd bridge; npm install"
        Pause; return $false
    }
    Write-OK "Bridge deps ready"

    if (-not (Test-Path (Join-Path $FrontendDir "node_modules"))) {
        Write-Err "Frontend dependencies not installed. Run: cd frontend; npm install"
        Pause; return $false
    }
    Write-OK "Frontend deps ready"

    $modelsDir = Join-Path $Root "data\models"
    $llmModel = Join-Path $modelsDir "Llama-3.2-1B-Instruct-Q4_0.gguf"
    if (Test-Path $llmModel) { Write-OK "LLM model ready" } else { Write-Warn "LLM model not found: $llmModel" }

    return $true
}

# ---- helper: wait for HTTP endpoint ----
function Wait-ForHttp($Url, $Description, $TimeoutSec = 15) {
    Write-Host "  Waiting for $Description..." -ForegroundColor Gray
    for ($i = 1; $i -le $TimeoutSec; $i++) {
        Start-Sleep -Seconds 1
        try {
            $null = Invoke-RestMethod -Uri $Url -TimeoutSec 2 -ErrorAction Stop
            Write-OK "$Description ready ($($i)s)"
            return $true
        } catch {}
    }
    Write-Err "$Description did not respond within $($TimeoutSec)s"
    return $false
}

# ---- Bridge ----
$global:BridgeProcess = $null

function Start-Bridge {
    Write-Step "[1/3] Starting Bridge (127.0.0.1:18889)..."

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command node).Source
    $psi.Arguments = "index.js"
    $psi.WorkingDirectory = $BridgeDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    $logStream = [System.IO.StreamWriter]::new($BridgeLog, $true)
    $proc.add_OutputDataReceived({
        param($sender, $e)
        if ($e.Data) { $logStream.WriteLine($e.Data); $logStream.Flush() }
    })
    $proc.add_ErrorDataReceived({
        param($sender, $e)
        if ($e.Data) { $logStream.WriteLine("[err] " + $e.Data); $logStream.Flush() }
    })

    $proc.Start() | Out-Null
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    $global:BridgeProcess = $proc
    Write-OK "Bridge PID: $($proc.Id)"
    Write-Host "  Log: $BridgeLog" -ForegroundColor Gray

    if (-not (Wait-ForHttp "http://127.0.0.1:18889/health" "Bridge HTTP" 15)) {
        throw "Bridge failed to start"
    }
}

# ---- Backend ----
$global:BackendProcess = $null

function Start-Backend {
    Write-Step "[2/3] Starting Backend API (127.0.0.1:18888)..."

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $PythonPath
    $psi.Arguments = "-u -m uvicorn backend.main:app --host 127.0.0.1 --port 18888 --log-level warning"
    $psi.WorkingDirectory = $Root
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    $logStream = [System.IO.StreamWriter]::new($BackendLog, $true)
    $proc.add_OutputDataReceived({
        param($sender, $e)
        if ($e.Data) { $logStream.WriteLine($e.Data); $logStream.Flush() }
    })
    $proc.add_ErrorDataReceived({
        param($sender, $e)
        if ($e.Data) { $logStream.WriteLine("[err] " + $e.Data); $logStream.Flush() }
    })

    $proc.Start() | Out-Null
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    $global:BackendProcess = $proc
    Write-OK "Backend PID: $($proc.Id)"
    Write-Host "  Log: $BackendLog" -ForegroundColor Gray

    # Backend starts fast — models load in background
    if (-not (Wait-ForHttp "http://127.0.0.1:18888/health" "Backend HTTP" 15)) {
        throw "Backend failed to start"
    }

    # Poll model status (non-blocking info)
    Write-Host "  Models loading in background..." -ForegroundColor Gray
    for ($i = 1; $i -le 120; $i++) {
        Start-Sleep -Seconds 1
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:18888/health" -TimeoutSec 2 -ErrorAction Stop
            $models = $resp.models
            if ($models.llm_loaded -and $models.embed_loaded) {
                Write-OK "Models ready — LLM + Embedding loaded ($($i)s)"
                break
            } elseif ($models.llm_loaded -and $i -eq 15) {
                Write-Host "    LLM loaded, waiting for Embedding..." -ForegroundColor Gray
            }
        } catch {}
        if ($i % 20 -eq 0) {
            Write-Host "    loading... ($($i)s)" -ForegroundColor Gray
        }
    }
}

# ---- Frontend ----
function Start-Frontend {
    Write-Step "[3/3] Starting Electron frontend..."

    Push-Location $FrontendDir
    $electronPath = Join-Path $FrontendDir "node_modules\.bin\electron.cmd"
    if (-not (Test-Path $electronPath)) {
        Write-Err "Electron not found. Run: cd frontend; npm install"
        Pause; return
    }

    Write-OK "Launching Electron..."
    Start-Process -FilePath $electronPath -ArgumentList "." -WorkingDirectory $FrontendDir
    Pop-Location
}

# ---- shutdown ----
function Cleanup-OnExit {
    Write-Host "`n=== Shutting down ===" -ForegroundColor Cyan

    if ($global:BackendProcess -and -not $global:BackendProcess.HasExited) {
        Write-Host "  Stopping Backend..." -ForegroundColor Gray
        $global:BackendProcess.Kill()
        $global:BackendProcess.Dispose()
    }

    if ($global:BridgeProcess -and -not $global:BridgeProcess.HasExited) {
        Write-Host "  Stopping Bridge..." -ForegroundColor Gray
        $global:BridgeProcess.Kill()
        $global:BridgeProcess.Dispose()
    }

    Get-Process -Name "bare" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    Write-Host "=== Stopped ===" -ForegroundColor Cyan
}

# ===================== Main =====================

Write-Host "`n=== QVAC Hackathon V0.4 === " -ForegroundColor Cyan -NoNewline
Write-Host "$(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Gray
Write-Host "  QVAC SDK -> Bridge (:18889) -> Backend (:18888) -> Frontend" -ForegroundColor Gray

try {
    Cleanup-StaleProcesses

    if (-not (Preflight-Checks)) { return }

    Start-Bridge
    Start-Backend
    Start-Frontend

    Write-Host "`n=== All services started ===" -ForegroundColor Green
    Write-Host "  Backend : http://127.0.0.1:18888" -ForegroundColor Gray
    Write-Host "  Bridge  : http://127.0.0.1:18889" -ForegroundColor Gray
    Write-Host "  Logs    : $LogDir" -ForegroundColor Gray
    Write-Host "`nModels loading in background — chat will be ready in ~30s" -ForegroundColor Yellow
    Write-Host "Press Ctrl+C to stop`n" -ForegroundColor Green

} catch {
    Write-Err "Launch failed: $_"
    Cleanup-OnExit
    Write-Host "`nPress Enter to exit..." -ForegroundColor Gray
    Read-Host
    return
}

# Register cleanup
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    if ($global:BackendProcess -and -not $global:BackendProcess.HasExited) {
        $global:BackendProcess.Kill()
    }
    if ($global:BridgeProcess -and -not $global:BridgeProcess.HasExited) {
        $global:BridgeProcess.Kill()
    }
    Get-Process -Name "bare" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
} | Out-Null

# Monitor until Ctrl+C
try {
    while ($true) {
        Start-Sleep -Seconds 3
        if ($global:BridgeProcess -and $global:BridgeProcess.HasExited) {
            Write-Warn "Bridge exited (code: $($global:BridgeProcess.ExitCode))"
            break
        }
        if ($global:BackendProcess -and $global:BackendProcess.HasExited) {
            Write-Warn "Backend exited (code: $($global:BackendProcess.ExitCode))"
            break
        }
    }
} finally {
    Cleanup-OnExit
}
