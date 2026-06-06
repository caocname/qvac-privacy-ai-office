const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

const BACKEND_URL = "http://127.0.0.1:18888";
const BRIDGE_PORT = 18889;
const BACKEND_PORT = 18888;

let mainWindow;
let backendProcess = null;
let bridgeStarted = false;

// ---- 解析资源路径 (开发 vs 生产) ----
function getResourcePath(relativePath) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, relativePath);
  }
  return path.join(__dirname, "..", relativePath);
}

function findPython() {
  // 优先使用环境变量
  if (process.env.PYTHON_PATH) {
    const fs = require("fs");
    if (fs.existsSync(process.env.PYTHON_PATH)) return process.env.PYTHON_PATH;
  }
  // 自动发现 Python 3.12
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs/Python/Python312/python.exe"),
    "C:/Python312/python.exe",
    "C:/Program Files/Python312/python.exe",
  ];
  const fs = require("fs");
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  // 兜底：尝试 PATH 上的 python
  return "python";
}

function getBackendExePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "backend", "backend.exe");
  }
  // 开发模式：查找 dist/backend/backend.exe
  const devPath = path.join(__dirname, "..", "dist", "backend", "backend.exe");
  const fs = require("fs");
  if (fs.existsSync(devPath)) return devPath;
  return null;
}

// ---- 获取应用根目录 (便携版: exe所在目录; 开发: 项目根) ----
function getAppRoot() {
  if (app.isPackaged) {
    // 便携版: resources/ 的父目录即 exe 所在目录
    return path.dirname(process.resourcesPath);
  }
  return path.join(__dirname, "..");
}

// ---- 启动 Python 后端 ----
function startBackend() {
  const exePath = getBackendExePath();
  const appRoot = getAppRoot();

  if (exePath) {
    // 生产模式：启动 PyInstaller 打包的 backend.exe
    process.stderr.write(`[Main] Starting backend: ${exePath}\n`);
    backendProcess = spawn(exePath, [], {
      cwd: path.dirname(exePath),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        QVAC_DATA_DIR: path.join(appRoot, "data"),
        QVAC_MODELS_DIR: path.join(appRoot, "data", "models"),
      },
    });
  } else {
    // 开发模式：使用 Python 启动
    const pythonPath = findPython();
    const backendDir = getResourcePath("backend");
    process.stderr.write(`[Main] Starting backend (dev): ${pythonPath} -m uvicorn backend.main:app\n`);
    backendProcess = spawn(pythonPath, [
      "-m", "uvicorn", "backend.main:app",
      "--host", "127.0.0.1", "--port", String(BACKEND_PORT),
      "--log-level", "warning",
    ], {
      cwd: getResourcePath(""),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  backendProcess.stdout?.on("data", (data) => {
    process.stderr.write(`[Backend] ${data}`);
  });
  backendProcess.stderr?.on("data", (data) => {
    process.stderr.write(`[Backend] ${data}`);
  });
  backendProcess.on("exit", (code) => {
    process.stderr.write(`[Main] Backend exited with code ${code}\n`);
    backendProcess = null;
  });
  backendProcess.on("error", (err) => {
    process.stderr.write(`[Main] Backend error: ${err.message}\n`);
    backendProcess = null;
  });
}

function stopBackend() {
  return new Promise((resolve) => {
    if (!backendProcess) {
      resolve();
      return;
    }
    process.stderr.write("[Main] Stopping backend...\n");

    const pid = backendProcess.pid;
    // Windows 上 subprocess.kill("SIGTERM") 不可靠，用 taskkill /t 杀死整个进程树
    try {
      require("child_process").execSync(`taskkill /pid ${pid} /t /f 2>nul`, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {}

    backendProcess = null;
    process.stderr.write("[Main] Backend stopped.\n");
    resolve();
  });
}

// ---- 启动 Bridge 服务器 (内嵌 HTTP) ----
async function startBridge() {
  try {
    const { startBridge: start } = require("./bridge-server");
    await start({ port: BRIDGE_PORT, host: "127.0.0.1", modelsDir: path.join(getAppRoot(), "data", "models") });
    bridgeStarted = true;
    process.stderr.write(`[Main] Bridge started on 127.0.0.1:${BRIDGE_PORT}\n`);
  } catch (err) {
    process.stderr.write(`[Main] Bridge start failed: ${err.message}\n`);
    process.stderr.write(`[Main] Will retry in 3s...\n`);
    // 重试一次
    await new Promise(r => setTimeout(r, 3000));
    try {
      const { startBridge: start } = require("./bridge-server");
      await start({ port: BRIDGE_PORT, host: "127.0.0.1", modelsDir: path.join(getAppRoot(), "data", "models") });
      bridgeStarted = true;
    } catch (err2) {
      process.stderr.write(`[Main] Bridge retry also failed: ${err2.message}\n`);
    }
  }
}

async function stopBridge() {
  if (bridgeStarted) {
    try {
      const { stopBridge: stop } = require("./bridge-server");
      await stop();
    } catch {}
  }
}

// ---- 窗口创建 ----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "QVAC Assistant",
    frame: false,
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    backgroundColor: "#F4F6F9",
    show: false,
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---- 窗口控制 IPC ----
function setupIPC() {
  ipcMain.handle("win:minimize", () => mainWindow?.minimize());
  ipcMain.handle("win:maximize", () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.handle("win:isMaximized", () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle("win:close", () => mainWindow?.close());
  ipcMain.handle("get-backend-url", () => BACKEND_URL);

  app.on("browser-window-created", (_, win) => {
    win.on("maximize", () => win.webContents.send("win:maximizeChange", true));
    win.on("unmaximize", () => win.webContents.send("win:maximizeChange", false));
  });
}

// ---- 应用生命周期 ----
app.whenReady().then(async () => {
  setupIPC();

  // 1. 启动 Bridge (AI 推理服务)
  process.stderr.write("[Main] Starting Bridge server...\n");
  await startBridge();

  // 2. 启动 Backend (Python API 服务)
  process.stderr.write("[Main] Starting Backend...\n");
  startBackend();

  // 3. 延迟启动窗口，等待后端就绪
  await new Promise(r => setTimeout(r, 2000));
  createWindow();
});

app.on("window-all-closed", async () => {
  process.stderr.write("[Main] Shutting down...\n");
  await stopBackend();
  await stopBridge();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  // 兜底：同步杀死后端进程树，确保 window-all-closed 未触发时也能清理
  if (backendProcess) {
    try {
      require("child_process").execSync(`taskkill /pid ${backendProcess.pid} /t /f 2>nul`, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {}
    backendProcess = null;
  }
});
