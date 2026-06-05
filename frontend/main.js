const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");

const BACKEND_URL = "http://127.0.0.1:18888";

let mainWindow;

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

  // 移除应用菜单栏
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
ipcMain.handle("win:minimize", () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle("win:maximize", () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle("win:isMaximized", () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.handle("win:close", () => {
  if (mainWindow) mainWindow.close();
});

// 最大化/还原状态变化时通知渲染进程
app.on("browser-window-created", (_, win) => {
  win.on("maximize", () => {
    win.webContents.send("win:maximizeChange", true);
  });
  win.on("unmaximize", () => {
    win.webContents.send("win:maximizeChange", false);
  });
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle("get-backend-url", () => BACKEND_URL);
