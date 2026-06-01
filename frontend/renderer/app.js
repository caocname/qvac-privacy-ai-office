// ============================================================
// QVAC Hackathon 离线 AI 办公助手 — 前端渲染逻辑
// 禁止: WebGL / 3D / 玻璃拟态 / backdrop-filter
// ============================================================

const BACKEND_URL = "http://127.0.0.1:18888";

// ---- 全局状态 ----
let connected = false;
let currentSessionId = null;
let currentStreaming = false;
let audioCtx = null;

// ---- DOM 引用 ----
const statusBadge = document.getElementById("status-badge");
const connectionDot = document.getElementById("connection-dot");
const sendBtn = document.getElementById("send-btn");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");
const overlay = document.getElementById("overlay");
const overlayText = document.getElementById("overlay-text");

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
    if (target === "knowledge") loadKnowledgeList();
  });
});

// ---- 后端连接检测 ----
async function checkHealth() {
  try {
    const resp = await fetch(`${BACKEND_URL}/health`);
    if (resp.ok) {
      if (!connected) {
        connected = true;
        statusBadge.textContent = "就绪";
        statusBadge.className = "badge badge-idle";
        connectionDot.className = "dot dot-connected";
        sendBtn.disabled = false;
        chatInput.disabled = false;
        // 自动创建或恢复会话
        if (!currentSessionId) initSession();
      }
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

// ---- 会话管理 ----
async function initSession() {
  try {
    // 尝试获取已有会话
    const resp = await fetch(`${BACKEND_URL}/api/v1/chat/sessions`);
    const data = await resp.json();
    if (data.data && data.data.length > 0) {
      currentSessionId = data.data[0].session_id;
      loadChatHistory(currentSessionId);
      return;
    }
  } catch (_) {}
  // 创建新会话
  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/chat/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_version: "v1", title: "新会话" }),
    });
    const data = await resp.json();
    currentSessionId = data.data.session_id;
  } catch (_) {}
}

async function loadChatHistory(sessionId) {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/chat/history?session_id=${sessionId}`);
    const data = await resp.json();
    if (data.data && data.data.length > 0) {
      chatMessages.innerHTML = "";
      data.data.forEach((msg) => appendMessage(msg.role, msg.content, msg.message_id, msg.is_truncated));
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  } catch (_) {}
}

// ---- 消息发送 ----
sendBtn.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !connected || !currentSessionId || currentStreaming) return;

  chatInput.value = "";
  chatInput.disabled = true;
  sendBtn.disabled = true;
  currentStreaming = true;

  // 清除占位内容
  const placeholder = chatMessages.querySelector(".chat-placeholder");
  if (placeholder) placeholder.remove();

  // 添加用户消息
  appendMessage("user", text);

  // 添加助手占位
  const assistantBubble = appendMessage("assistant", "", null, false, true);

  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_version: "v1",
        session_id: currentSessionId,
        message: text,
        enable_rag: true,
      }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let contentEl = assistantBubble.querySelector(".message-content");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const chunk = JSON.parse(line.slice(6));
          if (chunk.done) {
            if (chunk.error) {
              contentEl.textContent = `[错误] ${chunk.error}`;
            } else {
              fullText = chunk.full_text || fullText;
              contentEl.textContent = fullText;
            }
            if (chunk.memory_truncated) {
              const tag = document.createElement("span");
              tag.className = "truncation-tag";
              tag.textContent = " [已自动归档早期历史记忆]";
              contentEl.appendChild(tag);
            }
            contentEl.classList.remove("streaming");
          } else if (chunk.token) {
            fullText += chunk.token;
            contentEl.textContent = fullText;
            chatMessages.scrollTop = chatMessages.scrollHeight;
          }
        } catch {}
      }
    }

    contentEl.classList.remove("streaming");
    if (contentEl.textContent === "..." || !contentEl.textContent) {
      contentEl.textContent = fullText || "(空响应)";
    }
  } catch (err) {
    assistantBubble.querySelector(".message-content").textContent = `[连接错误] ${err.message}`;
    assistantBubble.querySelector(".message-content").classList.remove("streaming");
  }

  currentStreaming = false;
  chatInput.disabled = false;
  sendBtn.disabled = false;
  chatInput.focus();
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ---- 消息渲染 ----
function appendMessage(role, content, messageId, isTruncated, isStreaming) {
  const div = document.createElement("div");
  div.className = `message message-${role}`;
  if (messageId) div.dataset.messageId = messageId;
  if (isTruncated) div.style.opacity = "0.4";

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "U" : "A";

  const body = document.createElement("div");
  body.className = "message-body";

  const roleLabel = document.createElement("span");
  roleLabel.className = "message-role";
  roleLabel.textContent = role === "user" ? "用户" : "助手";

  const contentEl = document.createElement("div");
  contentEl.className = "message-content";
  contentEl.textContent = isStreaming ? "..." : content;
  if (isStreaming) contentEl.classList.add("streaming");

  body.appendChild(roleLabel);
  body.appendChild(contentEl);
  div.appendChild(avatar);
  div.appendChild(body);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

// ---- 知识库 ----
async function loadKnowledgeList() {
  const container = document.getElementById("knowledge-list");
  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/knowledge/list?session_id=${currentSessionId || ""}`);
    const data = await resp.json();
    if (!data.data || data.data.length === 0) {
      container.innerHTML = '<p class="empty-state">尚未上传任何文档</p>';
      return;
    }
    container.innerHTML = data.data.map((f) => `
      <div class="kb-item">
        <div class="kb-item-info">
          <span class="kb-item-name">${escapeHtml(f.file_name)}</span>
          <span class="kb-item-meta">${formatSize(f.file_size)} · ${f.total_pages} 页 · ${f.isolate_mode}</span>
        </div>
        <div class="kb-item-actions">
          <span class="kb-badge kb-badge-${f.isolate_mode}">${f.isolate_mode}</span>
          <button class="btn btn-small btn-danger" onclick="deleteKnowledge('${f.file_id}')">删除</button>
        </div>
      </div>
    `).join("");
  } catch (_) {
    container.innerHTML = '<p class="empty-state">无法加载知识库数据</p>';
  }
}

document.getElementById("upload-btn")?.addEventListener("click", () => {
  document.getElementById("file-input").click();
});

document.getElementById("file-input")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);
  formData.append("isolate_mode", "session");
  formData.append("session_id", currentSessionId || "");

  const uploadBtn = document.getElementById("upload-btn");
  uploadBtn.disabled = true;
  uploadBtn.textContent = "上传中...";

  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/knowledge/upload`, {
      method: "POST",
      body: formData,
    });
    const data = await resp.json();
    if (data.code === 100) {
      loadKnowledgeList();
    } else {
      alert(data.message || "上传失败");
    }
  } catch (err) {
    alert("上传失败：" + err.message);
  }

  uploadBtn.disabled = false;
  uploadBtn.textContent = "上传文档";
  e.target.value = "";
});

async function deleteKnowledge(fileId) {
  if (!confirm("确认删除此文档？")) return;
  try {
    await fetch(`${BACKEND_URL}/api/v1/knowledge/delete?file_id=${fileId}`, { method: "DELETE" });
    loadKnowledgeList();
  } catch (_) {}
}

// ---- 审计日志 ----
let auditPage = 1;

async function loadAuditLogs(page = 1) {
  auditPage = page;
  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/log/export?page=${page}&page_size=20&api_version=v1`);
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
    .map((l) => `
    <tr>
      <td class="col-time">+${l.relative_timestamp_ms}ms</td>
      <td class="col-datetime">${l.absolute_datetime}</td>
      <td><span class="log-type log-type-${l.log_type.toLowerCase()}">${l.log_type}</span></td>
      <td class="col-payload">${escapeHtml(l.payload_snapshot || "")}</td>
    </tr>`)
    .join("");
}

function renderAuditPagination(total, page) {
  const totalPages = Math.ceil(total / 20);
  const div = document.getElementById("audit-pagination");
  if (totalPages <= 1) {
    div.innerHTML = `<span>共 ${total} 条</span>`;
    return;
  }
  div.innerHTML = `
    <span>共 ${total} 条 / ${totalPages} 页</span>
    <button class="btn btn-small" ${page <= 1 ? "disabled" : ""} onclick="loadAuditLogs(${page - 1})">上一页</button>
    <button class="btn btn-small" ${page >= totalPages ? "disabled" : ""} onclick="loadAuditLogs(${page + 1})">下一页</button>
  `;
}

document.getElementById("export-logs-btn")?.addEventListener("click", async () => {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/log/export?page=1&page_size=1000&api_version=v1`);
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

// ---- 系统状态 ----
async function loadSystemState() {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/system/state`);
    const data = await resp.json();
    document.getElementById("state-master").textContent = `${data.master_state} ${data.master_name}`;
    document.getElementById("state-workers").textContent = data.active_workers?.join(", ") || "无";
  } catch (_) {}

  // Kill Switch 状态
  try {
    const stateResp = await fetch(`${BACKEND_URL}/api/v1/system/state`);
    const stateData = await stateResp.json();
    document.getElementById("state-ks").textContent =
      stateData.master_state === 999 ? "已锁定" : "正常";
    document.getElementById("state-ks").style.color =
      stateData.master_state === 999 ? "var(--error)" : "var(--success)";
  } catch (_) {}

  // 硬件信息
  try {
    const logResp = await fetch(`${BACKEND_URL}/api/v1/log/export?page=1&page_size=1&api_version=v1`);
    const logData = await logResp.json();
    if (logData.logs && logData.logs.length > 0) {
      const latest = logData.logs[0];
      if (latest.metrics) {
        if (latest.metrics.gpu_memory_used_mb) {
          document.getElementById("hw-gpu").textContent = `${latest.metrics.gpu_memory_used_mb} MB`;
        }
        if (latest.metrics.cpu_utilization_percent) {
          document.getElementById("hw-cpu").textContent = `${latest.metrics.cpu_utilization_percent}%`;
        }
        if (latest.metrics.ram_used_mb) {
          document.getElementById("hw-ram").textContent = `${latest.metrics.ram_used_mb} MB`;
        }
      }
    }
  } catch (_) {}
}

// ---- 网络锁定覆层检测 (999 NETWORK_LOCKED) ----
async function checkLockState() {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/system/state`);
    const data = await resp.json();
    if (data.master_state === 999) {
      overlay.classList.remove("hidden");
      overlayText.textContent = "检测到程序异常网络行为，AI 功能已锁定。";
      sendBtn.disabled = true;
      chatInput.disabled = true;
    } else {
      overlay.classList.add("hidden");
      if (connected) {
        sendBtn.disabled = false;
        chatInput.disabled = false;
      }
    }
  } catch (_) {}
}

setInterval(checkLockState, 3000);

// ---- 工具函数 ----
function escapeHtml(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
