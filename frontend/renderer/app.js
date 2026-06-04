// ============================================================
// QVAC Hackathon V0.2 — 离线 AI 办公助手 前端渲染逻辑
// ============================================================

const BACKEND_URL = "http://127.0.0.1:18888";

// ---- 全局状态 ----
let connected = false;
let currentSessionId = null;
let currentIsolateMode = "session";
let currentStreaming = false;
let audioCtx = null;
let asrPollTimer = null;

// ---- DOM 引用 ----
const statusBadge = document.getElementById("status-badge");
const connectionDot = document.getElementById("connection-dot");
const footerStatus = document.getElementById("footer-status");
const sendBtn = document.getElementById("send-btn");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");
const overlay = document.getElementById("overlay");
const overlayText = document.getElementById("overlay-text");
const toast = document.getElementById("toast");
const sessionList = document.getElementById("session-list");

// ---- Toast ----
let toastTimer = null;
function showToast(msg, type) {
  if (type === void 0) type = "";
  toast.textContent = msg;
  toast.className = "toast toast-" + type;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.classList.add("hidden"); }, 3000);
}

// ---- 确认弹窗 (3s 倒计时锁) ----
function showConfirm(title, msg, onConfirm) {
  var modal2 = document.getElementById("confirm-modal");
  var yesBtn = document.getElementById("confirm-yes-btn");
  var noBtn = document.getElementById("confirm-no-btn");
  document.getElementById("confirm-modal-title").textContent = title;
  document.getElementById("confirm-modal-msg").textContent = msg;

  modal2.classList.remove("hidden");
  yesBtn.disabled = true;
  var count = 3;
  yesBtn.textContent = "确认 (" + count + "s)";
  var timer = setInterval(function () {
    count--;
    if (count <= 0) {
      clearInterval(timer);
      yesBtn.disabled = false;
      yesBtn.textContent = "确认";
    } else {
      yesBtn.textContent = "确认 (" + count + "s)";
    }
  }, 1000);

  function cleanup() {
    clearInterval(timer);
    modal2.classList.add("hidden");
    yesBtn.removeEventListener("click", handler);
    noBtn.removeEventListener("click", cleanup2);
  }

  function handler() {
    cleanup();
    // 支持 async onConfirm — 关闭按钮在回调期间禁用
    yesBtn.disabled = true;
    yesBtn.textContent = "处理中...";
    var result = onConfirm();
    if (result && typeof result.then === "function") {
      result.catch(function () {}).finally(function () {
        yesBtn.disabled = false;
        yesBtn.textContent = "确认";
      });
    }
  }

  function cleanup2() {
    cleanup();
  }

  yesBtn.addEventListener("click", handler);
  noBtn.addEventListener("click", cleanup2);
}

// ---- 页面路由 ----
var pages = {
  chat: document.getElementById("page-chat"),
  knowledge: document.getElementById("page-knowledge"),
  asr: document.getElementById("page-asr"),
  audit: document.getElementById("page-audit"),
  settings: document.getElementById("page-settings"),
};

document.querySelectorAll(".nav-item").forEach(function (item) {
  item.addEventListener("click", function () {
    var target = item.dataset.page;
    document.querySelectorAll(".nav-item").forEach(function (n) { n.classList.remove("active"); });
    item.classList.add("active");
    Object.values(pages).forEach(function (p) { if (p) p.classList.remove("active"); });
    if (pages[target]) pages[target].classList.add("active");
    if (target === "audit") loadAuditLogs();
    if (target === "settings") loadSystemState();
    if (target === "knowledge") loadKnowledgeList();
    if (target === "asr") loadASRArchives();
    if (target === "chat") pages.chat.classList.add("active");
  });
});

// ---- 后端连接检测 ----
async function checkHealth() {
  try {
    var resp = await fetch(BACKEND_URL + "/health");
    if (resp.ok) {
      if (!connected) {
        connected = true;
        statusBadge.textContent = "就绪";
        statusBadge.className = "badge badge-idle";
        connectionDot.className = "dot dot-connected";
        footerStatus.textContent = "后端已连接";
        sendBtn.disabled = false;
        chatInput.disabled = false;
        if (!currentSessionId) initSession();
        checkSetupStatus();
      }
      return;
    }
  } catch (_) {}

  connected = false;
  statusBadge.textContent = "离线";
  statusBadge.className = "badge badge-error";
  connectionDot.className = "dot dot-disconnected";
  footerStatus.textContent = "后端未连接";
  sendBtn.disabled = true;
  chatInput.disabled = true;
}

checkHealth();
setInterval(checkHealth, 5000);

// ---- 首次设置引导 ----
async function checkSetupStatus() {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/system/credential/status");
    var data = await resp.json();
    if (data.data && data.data.credential_present) {
      // 检查是否已导出过 (用 localStorage 标记)
      if (!localStorage.getItem("qvac_key_exported")) {
        showSetupModal();
      }
    }
  } catch (_) {}
}

async function showSetupModal() {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/system/setup/mnemonic");
    var data = await resp.json();
    if (data.data) {
      document.getElementById("setup-key-hex").textContent = data.data.recovery_key_hex || "--";
      document.getElementById("setup-mnemonic").textContent = data.data.mnemonic_12_words || "--";
    }
  } catch (_) {}

  document.getElementById("setup-modal").classList.remove("hidden");

  document.getElementById("setup-copy-key").onclick = function () {
    var hex = document.getElementById("setup-key-hex").textContent;
    navigator.clipboard.writeText(hex).then(function () { showToast("已复制到剪贴板", "success"); });
  };
  document.getElementById("setup-copy-mnemonic").onclick = function () {
    var mnemonic = document.getElementById("setup-mnemonic").textContent;
    navigator.clipboard.writeText(mnemonic).then(function () { showToast("已复制到剪贴板", "success"); });
  };
  document.getElementById("setup-download-btn").onclick = function () {
    var hex = document.getElementById("setup-key-hex").textContent;
    var blob = new Blob([hex], { type: "text/plain" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "safe_recovery.key";
    a.click();
    URL.revokeObjectURL(url);
    showToast("恢复密钥已下载", "success");
  };
  document.getElementById("setup-done-btn").onclick = function () {
    localStorage.setItem("qvac_key_exported", "1");
    document.getElementById("setup-modal").classList.add("hidden");
    showToast("安全配置完成", "success");
  };
}

// ---- 凭证恢复弹窗 ----
var credModal = document.getElementById("credential-modal");
var credSubmit = document.getElementById("credential-submit-btn");
var credCancel = document.getElementById("credential-cancel-btn");
var credInput = document.getElementById("credential-input");

document.getElementById("import-key-btn").addEventListener("click", function () {
  credModal.classList.remove("hidden");
  credInput.value = "";
});

credSubmit.addEventListener("click", async function () {
  var key = credInput.value.trim();
  if (!key) { showToast("请输入恢复密钥或助记词", "error"); return; }
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/system/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_version: "v1", recovery_key: key }),
    });
    var data = await resp.json();
    if (data.code === 100) {
      showToast("密钥恢复成功", "success");
      credModal.classList.add("hidden");
      loadSystemState();
    } else {
      showToast(data.message || "恢复失败", "error");
    }
  } catch (err) {
    showToast("恢复请求失败: " + err.message, "error");
  }
});

credCancel.addEventListener("click", function () { credModal.classList.add("hidden"); });

// ---- 会话管理 ----
async function initSession() {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/chat/sessions");
    var data = await resp.json();
    if (data.data && data.data.length > 0) {
      currentSessionId = data.data[0].session_id;
      renderSessionList(data.data);
      loadChatHistory(currentSessionId);
      return;
    }
  } catch (_) {}
  createNewSession();
}

async function createNewSession() {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/chat/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_version: "v1", title: "新会话" }),
    });
    var data = await resp.json();
    currentSessionId = data.data.session_id;
    renderSessionList([data.data]);
  } catch (_) {}
}

document.getElementById("new-session-btn").addEventListener("click", async function () {
  // 切换到聊天页面
  document.querySelectorAll(".nav-item").forEach(function (n) { n.classList.remove("active"); });
  var chatNav = document.querySelector('.nav-item[data-page="chat"]');
  if (chatNav) chatNav.classList.add("active");
  Object.values(pages).forEach(function (p) { if (p) p.classList.remove("active"); });
  if (pages.chat) pages.chat.classList.add("active");

  if (currentSessionId) {
    // 切换前清理 Temp
    try {
      await fetch(BACKEND_URL + "/api/v1/chat/session/switch?from_session_id=" + currentSessionId + "&to_session_id=new", { method: "POST" });
    } catch (_) {}
  }
  await createNewSession();
  chatMessages.innerHTML = '<div class="chat-placeholder"><div class="placeholder-icon"><svg viewBox="0 0 24 24" width="48" height="48"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" opacity="0.3"/></svg></div><p>开始离线隐私对话</p><p class="sub-text">所有推理 100% 本地运行，数据零外泄</p></div>';
});

function renderSessionList(sessions) {
  sessionList.innerHTML = "";
  sessions.forEach(function (s) {
    var li = document.createElement("li");
    li.className = "session-item";
    if (s.session_id === currentSessionId) li.classList.add("active");
    li.dataset.sessionId = s.session_id;

    var title = document.createElement("span");
    title.className = "session-title";
    title.textContent = s.title || "会话";
    title.title = "双击重命名";
    li.appendChild(title);

    // 双击重命名
    title.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      e.preventDefault();
      startSessionRename(s.session_id, title);
    });

    var closeBtn = document.createElement("button");
    closeBtn.className = "session-close-btn";
    closeBtn.textContent = "x";
    closeBtn.title = "关闭会话";
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      closeSession(s.session_id);
    });
    li.appendChild(closeBtn);

    li.addEventListener("click", function () {
      switchToSession(s.session_id);
    });
    sessionList.appendChild(li);
  });
}

function startSessionRename(sessionId, titleEl) {
  var oldTitle = titleEl.textContent;
  var input = document.createElement("input");
  input.type = "text";
  input.className = "session-rename-input";
  input.value = oldTitle;
  input.maxLength = 64;

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  function finish() {
    var newTitle = input.value.trim() || oldTitle;
    input.replaceWith(titleEl);
    titleEl.textContent = newTitle;
    // 提交到后端
    if (newTitle !== oldTitle) {
      fetch(BACKEND_URL + "/api/v1/chat/session/rename?session_id=" + sessionId + "&title=" + encodeURIComponent(newTitle), {
        method: "POST",
      }).then(function () {
        showToast("会话已重命名", "success");
      }).catch(function () {
        titleEl.textContent = oldTitle;
        showToast("重命名失败", "error");
      });
    }
  }

  input.addEventListener("blur", finish);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = oldTitle; input.blur(); }
  });
}

async function switchToSession(sessionId) {
  if (sessionId === currentSessionId) return;
  try {
    await fetch(BACKEND_URL + "/api/v1/chat/session/switch?from_session_id=" + currentSessionId + "&to_session_id=" + sessionId);
  } catch (_) {}
  currentSessionId = sessionId;
  updateSessionListActive();
  loadChatHistory(sessionId);
}

async function closeSession(sessionId) {
  showConfirm("关闭会话", "关闭此会话将永久删除会话及所有聊天记录。确认？", async function () {
    var ok = false;
    try {
      var resp = await fetch(BACKEND_URL + "/api/v1/chat/session/close?session_id=" + sessionId, { method: "POST" });
      var data = await resp.json();
      ok = data.code === 100;
    } catch (_) {}
    if (!ok) { showToast("关闭会话失败", "error"); return; }
    if (sessionId === currentSessionId) {
      currentSessionId = null;
      chatMessages.innerHTML = '<div class="chat-placeholder"><div class="placeholder-icon"><svg viewBox="0 0 24 24" width="48" height="48"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" opacity="0.3"/></svg></div><p>开始离线隐私对话</p><p class="sub-text">所有推理 100% 本地运行，数据零外泄</p></div>';
    }
    // 刷新会话列表
    try {
      var resp2 = await fetch(BACKEND_URL + "/api/v1/chat/sessions");
      var list = await resp2.json();
      if (list.data && list.data.length > 0) {
        renderSessionList(list.data);
        if (!currentSessionId) {
          currentSessionId = list.data[0].session_id;
          loadChatHistory(currentSessionId);
        }
      } else {
        sessionList.innerHTML = "";
        createNewSession();
      }
    } catch (_) {}
    showToast("会话已关闭", "success");
  });
}

function updateSessionListActive() {
  sessionList.querySelectorAll(".session-item").forEach(function (li) {
    if (li.dataset.sessionId === currentSessionId) li.classList.add("active");
    else li.classList.remove("active");
  });
}

async function loadChatHistory(sessionId) {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/chat/history?session_id=" + sessionId);
    var data = await resp.json();
    if (data.data && data.data.length > 0) {
      chatMessages.innerHTML = "";
      data.data.forEach(function (msg) {
        appendMessage(msg.role, msg.content, msg.message_id, msg.is_truncated);
      });
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  } catch (_) {}
}

// ---- 消息发送 ----
sendBtn.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  var text = chatInput.value.trim();
  if (!text || !connected || !currentSessionId || currentStreaming) return;

  chatInput.value = "";
  chatInput.disabled = true;
  sendBtn.disabled = true;
  currentStreaming = true;

  var placeholder = chatMessages.querySelector(".chat-placeholder");
  if (placeholder) placeholder.remove();

  appendMessage("user", text);
  var assistantBubble = appendMessage("assistant", "", null, false, true);

  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_version: "v1",
        session_id: currentSessionId,
        message: text,
        enable_rag: true,
        isolate_mode: currentIsolateMode,
      }),
    });

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var fullText = "";
    var contentEl = assistantBubble.querySelector(".message-content");
    var buffer = "";

    while (true) {
      var _a = await reader.read(), done = _a.done, value = _a.value;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      var lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf("data: ") !== 0) continue;
        try {
          var chunk = JSON.parse(line.slice(6));
          if (chunk.error) {
            contentEl.textContent = "[错误] " + chunk.error;
            contentEl.classList.remove("streaming");
            break;
          }
          if (chunk.done) {
            if (chunk._debug) {
              console.log("[QVAC Debug]", JSON.stringify(chunk._debug));
            }
            fullText = chunk.full_text || fullText;
            contentEl.textContent = fullText;
            if (chunk.memory_truncated) {
              var tag = document.createElement("span");
              tag.className = "truncation-tag";
              tag.textContent = "[已自动归档早期历史记忆]";
              contentEl.appendChild(tag);
            }
            contentEl.classList.remove("streaming");
            // 添加 TTS 播放按钮
            addTTSButton(assistantBubble, fullText);
          } else if (chunk.token) {
            fullText += chunk.token;
            contentEl.textContent = fullText;
            chatMessages.scrollTop = chatMessages.scrollHeight;
          }
        } catch (_e) {}
      }
    }

    contentEl.classList.remove("streaming");
    if (contentEl.textContent === "..." || !contentEl.textContent) {
      contentEl.textContent = fullText || "(空响应)";
      addTTSButton(assistantBubble, fullText);
    }
  } catch (err) {
    assistantBubble.querySelector(".message-content").textContent = "[连接错误] " + err.message;
    assistantBubble.querySelector(".message-content").classList.remove("streaming");
  }

  currentStreaming = false;
  chatInput.disabled = false;
  sendBtn.disabled = false;
  chatInput.focus();
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ---- TTS 控制 ----
function addTTSButton(bubble, text) {
  if (!text || text.length < 10) return;

  var existing = bubble.querySelector(".message-actions");
  if (existing) existing.remove();

  var actions = document.createElement("div");
  actions.className = "message-actions";

  var playBtn = document.createElement("button");
  playBtn.className = "btn btn-tiny";
  playBtn.textContent = "朗读";
  playBtn.addEventListener("click", function () { playTTS(text, playBtn); });
  actions.appendChild(playBtn);

  bubble.querySelector(".message-body").appendChild(actions);
}

async function playTTS(text, btn) {
  if (btn.dataset.playing === "true") {
    // 停止
    await fetch(BACKEND_URL + "/api/v1/tts/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_version: "v1", action: "destroy_handler" }),
    });
    btn.textContent = "朗读";
    btn.dataset.playing = "false";
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    return;
  }

  btn.textContent = "停止";
  btn.dataset.playing = "true";

  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/tts/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_version: "v1", text: text, voice_model: "male_professional", speed: 1.0 }),
    });

    var reader = resp.body.getReader();
    var chunks = [];

    while (true) {
      var _a = await reader.read(), done = _a.done, value = _a.value;
      if (done) break;
      chunks.push(value);
    }

    // 播放音频
    if (chunks.length > 0) {
      var blob = new Blob(chunks, { type: "audio/wav" });
      var url = URL.createObjectURL(blob);
      audioCtx = new AudioContext();
      var arrayBuffer = await (await fetch(url)).arrayBuffer();
      var audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      var source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.onended = function () {
        btn.textContent = "朗读";
        btn.dataset.playing = "false";
      };
      source.start();
    }
  } catch (err) {
    showToast("TTS 播放失败: " + err.message, "error");
    btn.textContent = "朗读";
    btn.dataset.playing = "false";
  }
}

// ---- 消息渲染 ----
function appendMessage(role, content, messageId, isTruncated, isStreaming) {
  var div = document.createElement("div");
  div.className = "message message-" + role;
  if (messageId) div.dataset.messageId = messageId;
  if (isTruncated) div.style.opacity = "0.4";

  var avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "U" : "A";

  var body = document.createElement("div");
  body.className = "message-body";

  var roleLabel = document.createElement("span");
  roleLabel.className = "message-role";
  roleLabel.textContent = role === "user" ? "用户" : "助手";

  var contentEl = document.createElement("div");
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
document.getElementById("isolate-mode-select").addEventListener("change", function () {
  currentIsolateMode = this.value;
});

async function loadKnowledgeList() {
  var container = document.getElementById("knowledge-list");
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/list?session_id=" + (currentSessionId || ""));
    var data = await resp.json();
    if (!data.data || data.data.length === 0) {
      container.innerHTML = '<p class="empty-state">尚未上传任何文档</p>';
      return;
    }
    container.innerHTML = data.data.map(function (f) {
      return '<div class="kb-item">' +
        '<div class="kb-item-info">' +
          '<span class="kb-item-name">' + escapeHtml(f.file_name) + '</span>' +
          '<span class="kb-item-meta">' + formatSize(f.file_size) + ' · ' + f.total_pages + ' 页</span>' +
        '</div>' +
        '<div class="kb-item-actions">' +
          '<span class="kb-badge kb-badge-' + f.isolate_mode + '">' + f.isolate_mode + '</span>' +
          '<button class="btn btn-small btn-danger" onclick="deleteKnowledge(\'' + f.file_id + '\')">删除</button>' +
        '</div>' +
      '</div>';
    }).join("");
  } catch (_) {
    container.innerHTML = '<p class="empty-state">无法加载知识库数据</p>';
  }
}

document.getElementById("upload-btn").addEventListener("click", function () {
  document.getElementById("file-input").click();
});

document.getElementById("file-input").addEventListener("change", async function (e) {
  var file = e.target.files[0];
  if (!file) return;

  var isolateMode = document.getElementById("isolate-mode-select").value;
  var formData = new FormData();
  formData.append("file", file);
  formData.append("isolate_mode", isolateMode);
  formData.append("session_id", currentSessionId || "");

  var uploadBtn = document.getElementById("upload-btn");
  uploadBtn.disabled = true;
  uploadBtn.textContent = "上传中...";

  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/upload", {
      method: "POST",
      body: formData,
    });
    var data = await resp.json();
    if (data.code === 100) {
      showToast("文档上传成功", "success");
      loadKnowledgeList();
    } else {
      showToast(data.message || "上传失败", "error");
    }
  } catch (err) {
    showToast("上传失败：" + err.message, "error");
  }

  uploadBtn.disabled = false;
  uploadBtn.textContent = "上传文档";
  e.target.value = "";
});

async function deleteKnowledge(fileId) {
  showConfirm("删除文档", "确认永久删除此文档？此操作不可撤销。", async function () {
    try {
      await fetch(BACKEND_URL + "/api/v1/knowledge/delete?file_id=" + fileId, { method: "DELETE" });
      loadKnowledgeList();
      showToast("文档已删除", "success");
    } catch (_) {
      showToast("删除失败", "error");
    }
  });
}

// ---- ASR ----
document.getElementById("asr-select-btn").addEventListener("click", function () {
  document.getElementById("asr-file-input").click();
});

document.getElementById("asr-file-input").addEventListener("change", async function (e) {
  var file = e.target.files[0];
  if (!file) return;

  // 前端 WAV 格式拦截
  var ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext !== "wav") {
    showToast("仅支持标准 WAV 格式音频文件", "error");
    e.target.value = "";
    return;
  }

  submitASRTask(file);
  e.target.value = "";
});

// 拖拽上传
var dropZone = document.getElementById("asr-drop-zone");
dropZone.addEventListener("dragover", function (e) { e.preventDefault(); dropZone.style.borderColor = "var(--accent)"; });
dropZone.addEventListener("dragleave", function () { dropZone.style.borderColor = ""; });
dropZone.addEventListener("drop", function (e) {
  e.preventDefault();
  dropZone.style.borderColor = "";
  var file = e.dataTransfer.files[0];
  if (file) {
    var ext = (file.name.split(".").pop() || "").toLowerCase();
    if (ext !== "wav") { showToast("仅支持 WAV 格式", "error"); return; }
    submitASRTask(file);
  }
});

async function submitASRTask(file) {
  showToast("ASR 任务投递中...", "");

  // 优先使用 Electron 本地路径直传 (更快，免上传)
  if (window.qvacAPI && file.path) {
    try {
      var resp = await window.qvacAPI.submitASR(file.path);
      if (resp.code === 160) {
        showToast("ASR 任务已投递", "success");
        startASRPolling(resp.data.task_id);
        return;
      } else {
        showToast(resp.message || "ASR 投递失败", "error");
        return;
      }
    } catch (err) {
      // 降级到文件上传方式
    }
  }

  // 降级方案: 通过文件上传接口提交
  var formData = new FormData();
  formData.append("file", file);

  try {
    var uploadResp = await fetch(BACKEND_URL + "/api/v1/asr/upload", {
      method: "POST",
      body: formData,
    });
    var uploadData = await uploadResp.json();
    if (uploadData.code === 160) {
      showToast("ASR 任务已投递", "success");
      startASRPolling(uploadData.data.task_id);
    } else {
      showToast(uploadData.message || "ASR 投递失败", "error");
    }
  } catch (err) {
    showToast("ASR 投递异常: " + err.message, "error");
  }
}

function startASRPolling(taskId) {
  var panel = document.getElementById("asr-task-panel");
  panel.classList.remove("hidden");
  document.getElementById("asr-task-id").textContent = taskId;
  document.getElementById("asr-result-panel").classList.add("hidden");

  if (asrPollTimer) clearInterval(asrPollTimer);

  asrPollTimer = setInterval(async function () {
    try {
      var resp = await fetch(BACKEND_URL + "/api/v1/asr/status?task_id=" + taskId + "&api_version=v1");
      var data = await resp.json();

      if (data.code === 160) {
        var progress = data.data.progress_percent || 0;
        document.getElementById("asr-progress-bar").style.width = progress + "%";
        document.getElementById("asr-progress-text").textContent = progress.toFixed(1) + "%";
        document.getElementById("asr-remaining-text").textContent = "剩余: " + (data.data.remaining_time_s || 0).toFixed(0) + "s";
      } else if (data.code === 100) {
        clearInterval(asrPollTimer);
        asrPollTimer = null;
        document.getElementById("asr-progress-bar").style.width = "100%";
        document.getElementById("asr-progress-text").textContent = "100%";
        document.getElementById("asr-remaining-text").textContent = "完成";
        document.getElementById("asr-task-status").textContent = "已完成";
        document.getElementById("asr-task-status").className = "badge badge-idle";

        // 显示结果
        var resultPanel = document.getElementById("asr-result-panel");
        resultPanel.classList.remove("hidden");
        document.getElementById("asr-result-duration").textContent =
          "时长: " + (data.data.duration || 0).toFixed(1) + "s";
        document.getElementById("asr-result-text").textContent = data.data.transcribed_text || "(空)";

        loadASRArchives();
        showToast("ASR 转写完成", "success");
      } else if (data.code === 500) {
        clearInterval(asrPollTimer);
        asrPollTimer = null;
        showToast("ASR 任务失败: " + (data.message || "未知错误"), "error");
      }
    } catch (_) {}
  }, 2000);
}

async function loadASRArchives() {
  var container = document.getElementById("asr-archive-list");
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/asr/list");
    var data = await resp.json();
    if (!data.data || data.data.length === 0) {
      container.innerHTML = '<p class="empty-state">暂无转写记录</p>';
      return;
    }
    container.innerHTML = data.data.map(function (a) {
      return '<div class="kb-item">' +
        '<div class="kb-item-info">' +
          '<span class="kb-item-name">' + escapeHtml(a.audio_name) + '</span>' +
          '<span class="kb-item-meta">' + (a.duration || 0).toFixed(1) + 's · ' + (a.create_time || "") + '</span>' +
        '</div>' +
        '<span class="kb-badge kb-badge-session">ASR</span>' +
      '</div>';
    }).join("");
  } catch (_) {
    container.innerHTML = '<p class="empty-state">无法加载转写记录</p>';
  }
}

// ---- 审计日志 ----
var auditPage = 1;

async function loadAuditLogs(page) {
  if (page === void 0) page = 1;
  auditPage = page;
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/log/export?page=" + page + "&page_size=20&api_version=v1");
    var data = await resp.json();
    renderAuditTable(data.logs);
    renderAuditPagination(data.total_records, page);
  } catch (_) {
    document.getElementById("audit-tbody").innerHTML =
      '<tr><td colspan="4" class="empty-state">无法加载审计数据 — 后端未连接</td></tr>';
  }
}

function renderAuditTable(logs) {
  var tbody = document.getElementById("audit-tbody");
  if (!logs || logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">暂无日志记录</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map(function (l) {
    return '<tr>' +
      '<td class="col-time">+' + l.relative_timestamp_ms + 'ms</td>' +
      '<td class="col-datetime">' + l.absolute_datetime + '</td>' +
      '<td><span class="log-type log-type-' + (l.log_type || "").toLowerCase() + '">' + l.log_type + '</span></td>' +
      '<td class="col-payload">' + escapeHtml(l.payload_snapshot || "") + '</td>' +
    '</tr>';
  }).join("");
}

function renderAuditPagination(total, page) {
  var totalPages = Math.ceil(total / 20);
  var div = document.getElementById("audit-pagination");
  if (totalPages <= 1) {
    div.innerHTML = '<span>共 ' + total + ' 条</span>';
    return;
  }
  div.innerHTML =
    '<span>共 ' + total + ' 条 / ' + totalPages + ' 页</span>' +
    '<button class="btn btn-small" ' + (page <= 1 ? "disabled" : "") + ' onclick="loadAuditLogs(' + (page - 1) + ')">上一页</button>' +
    '<button class="btn btn-small" ' + (page >= totalPages ? "disabled" : "") + ' onclick="loadAuditLogs(' + (page + 1) + ')">下一页</button>';
}

document.getElementById("export-logs-btn").addEventListener("click", async function () {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/log/export?page=1&page_size=1000&api_version=v1");
    var data = await resp.json();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "audit-log-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(url);
    showToast("审计日志已导出", "success");
  } catch (_) {
    showToast("导出失败", "error");
  }
});

// ---- 系统状态 ----
async function loadSystemState() {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/system/state");
    var data = await resp.json();
    document.getElementById("state-master").textContent = data.master_state + " " + data.master_name;
    document.getElementById("state-workers").textContent = (data.active_workers || []).join(", ") || "无";

    // Kill Switch
    document.getElementById("state-ks").textContent = data.master_state === 999 ? "已锁定" : "正常";
    document.getElementById("state-ks").style.color = data.master_state === 999 ? "var(--error)" : "var(--success)";
  } catch (_) {}

  // 凭据状态
  try {
    var credResp = await fetch(BACKEND_URL + "/api/v1/system/credential/status");
    var credData = await credResp.json();
    if (credData.data) {
      document.getElementById("sec-cred").textContent = credData.data.credential_present ? "已托管" : "缺失";
      document.getElementById("sec-cred").style.color = credData.data.credential_present ? "var(--success)" : "var(--error)";
      document.getElementById("sec-enc").textContent = credData.data.credential_present ? "AES-256-GCM" : "明文 (降级)";
      document.getElementById("sec-enc").style.color = credData.data.credential_present ? "var(--success)" : "var(--warning)";

      if (!credData.data.credential_present) {
        showToast("凭据丢失，请在设置页导入恢复密钥", "error");
      }
    }
  } catch (_) {}

  // 硬件采样
  try {
    var logResp = await fetch(BACKEND_URL + "/api/v1/log/export?page=1&page_size=1&api_version=v1");
    var logData = await logResp.json();
    if (logData.logs && logData.logs.length > 0) {
      var latest = logData.logs[0];
      if (latest.metrics) {
        if (latest.metrics.gpu_memory_used_mb) {
          document.getElementById("hw-gpu").textContent = latest.metrics.gpu_memory_used_mb + " MB";
        }
        if (latest.metrics.cpu_utilization_percent) {
          document.getElementById("hw-cpu").textContent = latest.metrics.cpu_utilization_percent + "%";
        }
        if (latest.metrics.ram_used_mb) {
          document.getElementById("hw-ram").textContent = latest.metrics.ram_used_mb + " MB";
        }
      }
    }
  } catch (_) {}
}

// ---- 安全操作按钮 ----
document.getElementById("export-key-btn").addEventListener("click", async function () {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/system/credential/export");
    var data = await resp.json();
    if (data.code === 100 && data.data) {
      var blob = new Blob([data.data.recovery_key_hex], { type: "text/plain" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "safe_recovery.key";
      a.click();
      URL.revokeObjectURL(url);
      localStorage.setItem("qvac_key_exported", "1");
      showToast("恢复密钥已下载", "success");
    } else {
      showToast(data.message || "导出失败", "error");
    }
  } catch (_) {
    showToast("导出请求失败", "error");
  }
});

document.getElementById("gen-mnemonic-btn").addEventListener("click", async function () {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/system/setup/mnemonic");
    var data = await resp.json();
    if (data.data && data.data.mnemonic_12_words) {
      document.getElementById("setup-mnemonic").textContent = data.data.mnemonic_12_words;
      document.getElementById("setup-key-hex").textContent = data.data.recovery_key_hex || "--";
      document.getElementById("setup-modal").classList.remove("hidden");
      // 复用 setup modal
      document.getElementById("setup-done-btn").onclick = function () {
        document.getElementById("setup-modal").classList.add("hidden");
        showToast("请妥善保管助记词", "warn");
      };
    }
  } catch (_) {}
});

// ---- Kill Switch 覆层检测 ----
async function checkLockState() {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/system/state");
    var data = await resp.json();
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
  var d = document.createElement("div");
  d.textContent = text || "";
  return d.innerHTML;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
