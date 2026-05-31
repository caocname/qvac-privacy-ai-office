const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qvacAPI", {
  getBackendURL: () => ipcRenderer.invoke("get-backend-url"),

  // 通用 HTTP 请求封装
  request: async (method, path, body) => {
    const base = await ipcRenderer.invoke("get-backend-url");
    const url = `${base}${path}`;
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) {
      opts.body = JSON.stringify(body);
    }
    const response = await fetch(url, opts);
    return response.json();
  },

  // 便捷方法
  health: () => ipcRenderer.invoke("get-backend-url").then((base) =>
    fetch(`${base}/health`).then((r) => r.json())
  ),

  uploadKnowledge: (payload) =>
    fetch(
      `${localStorage.getItem("backend_url") || "http://127.0.0.1:18888"}/api/v1/knowledge/upload`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    ).then((r) => r.json()),

  submitASR: (audioPath) =>
    fetch(
      `${localStorage.getItem("backend_url") || "http://127.0.0.1:18888"}/api/v1/asr/submit`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_version: "v1", audio_path: audioPath, audio_type: "wav" }) }
    ).then((r) => r.json()),

  getASRStatus: (taskId) =>
    fetch(
      `${localStorage.getItem("backend_url") || "http://127.0.0.1:18888"}/api/v1/asr/status?task_id=${taskId}&api_version=v1`
    ).then((r) => r.json()),

  exportLogs: (page, pageSize) =>
    fetch(
      `${localStorage.getItem("backend_url") || "http://127.0.0.1:18888"}/api/v1/log/export?page=${page}&page_size=${pageSize}&api_version=v1`
    ).then((r) => r.json()),

  getSystemState: () =>
    fetch(
      `${localStorage.getItem("backend_url") || "http://127.0.0.1:18888"}/api/v1/system/state`
    ).then((r) => r.json()),
});
