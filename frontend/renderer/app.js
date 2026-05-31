// ============================================================
// QVAC Hackathon 离线 AI 办公助手 — 前端渲染逻辑
// 禁止: WebGL / 3D / 玻璃拟态
// ============================================================

const BACKEND_URL = "http://127.0.0.1:18888";

// ---- 页面路由 ----
const pages = {
  chat: document.getElementById("page-chat"),
  knowledge: document.getElementById("page-knowledge"),
  audit: document.getElementById("page-audit"),
  settings: document.getElementById("page-settings"),
};

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    const target = item.dataset.page;
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    item.classList.add("active");
    Object.values(pages).forEach((p) => p && p.classList.remove("active"));
    if (pages[target]) pages[target].classList.add("active");
    if (target === "audit") loadAuditLogs();
    if (target === "settings") loadSystemState();
  });
});

// ---- 后端连接检测 ----
let connected = false;
const statusBadge = document.getElementById("status-badge");
const connectionDot = document.getElementById("connection-dot");
const sendBtn = document.getElementById("send-btn");
const chatInput = document.getElementById("chat-input");

async function checkHealth() {
  try {
    const resp = await fetch(`${BACKEND_URL}/health`);
    if (resp.ok) {
      connected = true;
      statusBadge.textContent = "就绪";
      statusBadge.className = "badge badge-idle";
      connectionDot.className = "dot dot-connected";
      sendBtn.disabled = false;
      chatInput.disabled = false;
      return;
    }
  } catch (_) {}
  connected = false;
  statusBadge.textContent = "离线";
  statusBadge.className = "badge badge-error";
  connectionDot.className = "dot dot-disconnected";
  sendBtn.disabled = true;
  chatInput.disabled = true;
}

checkHealth();
setInterval(checkHealth, 5000);

// ---- 系统状态轮询 ----
async function loadSystemState() {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/system/state`);
    const data = await resp.json();
    document.getElementById("state-master").textContent = `${data.master_state} ${data.master_name}`;
    document.getElementById("state-workers").textContent = data.active_workers?.join(", ") || "无";
  } catch (_) {}
}

// ---- 审计日志加载 ----
let auditPage = 1;

async function loadAuditLogs(page = 1) {
  auditPage = page;
  try {
    const resp = await fetch(
      `${BACKEND_URL}/api/v1/log/export?page=${page}&page_size=20&api_version=v1`
    );
    const data = await resp.json();
    renderAuditTable(data.logs);
    renderAuditPagination(data.total_records, page);
  } catch (_) {
    document.getElementById("audit-tbody").innerHTML =
      '<tr><td colspan="4" class="empty-state">无法加载审计数据 — 后端未连接</td></tr>';
  }
}

function renderAuditTable(logs) {
  const tbody = document.getElementById("audit-tbody");
  if (!logs || logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">暂无日志记录</td></tr>';
    return;
  }
  tbody.innerHTML = logs
    .map(
      (l) => `
    <tr>
      <td class="col-time">+${l.relative_timestamp_ms}ms</td>
      <td class="col-datetime">${l.absolute_datetime}</td>
      <td><span class="log-type log-type-${l.log_type.toLowerCase()}">${l.log_type}</span></td>
      <td class="col-payload">${escapeHtml(l.payload_snapshot || "")}</td>
    </tr>`
    )
    .join("");
}

function renderAuditPagination(total, page) {
  const totalPages = Math.ceil(total / 20);
  const div = document.getElementById("audit-pagination");
  div.innerHTML = `
    <span>共 ${total} 条 / ${totalPages} 页</span>
    <button class="btn btn-small" ${page <= 1 ? "disabled" : ""} onclick="loadAuditLogs(${page - 1})">上一页</button>
    <button class="btn btn-small" ${page >= totalPages ? "disabled" : ""} onclick="loadAuditLogs(${page + 1})">下一页</button>
  `;
}

function escapeHtml(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

// ---- 导出日志 ----
document.getElementById("export-logs-btn")?.addEventListener("click", async () => {
  try {
    const resp = await fetch(
      `${BACKEND_URL}/api/v1/log/export?page=1&page_size=1000&api_version=v1`
    );
    const data = await resp.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (_) {}
});

// ---- 知识库上传 ----
document.getElementById("upload-btn")?.addEventListener("click", () => {
  document.getElementById("file-input").click();
});

// ---- 网络锁定覆层 (999 NETWORK_LOCKED) ----
async function checkLockState() {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/system/state`);
    const data = await resp.json();
    const overlay = document.getElementById("overlay");
    if (data.master_state === 999) {
      overlay.classList.remove("hidden");
      document.getElementById("overlay-text").textContent = "系统已锁定 (999 NETWORK_LOCKED)";
    } else {
      overlay.classList.add("hidden");
    }
  } catch (_) {}
}

setInterval(checkLockState, 3000);
