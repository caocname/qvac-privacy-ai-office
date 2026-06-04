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
let selectedDocIds = [];  // 当前选中的知识库文档 ID 列表

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
  translate: document.getElementById("page-translate"),
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
    if (target === "knowledge") { loadFolderTree().then(function () { loadKnowledgeList(); }); }
    if (target === "asr") { loadASRArchives(); loadFolderTree(); }
    if (target === "translate") { loadTranslateHistory(); loadFolderTree(); }
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
        pollCredentialStatus();
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

// ---- 文档上下文选择器 ----
var docInfoMap = {};

function toggleDocsDropdown(e) {
  if (e) e.stopPropagation();
  var dd = document.getElementById("chat-docs-dropdown");
  if (!dd) return;
  if (dd.style.display === "none" || dd.style.display === "") {
    loadDocSelectorList();
    dd.style.display = "flex";
  } else {
    dd.style.display = "none";
  }
}

function closeDocsDropdown(e) {
  if (e) e.stopPropagation();
  var dd = document.getElementById("chat-docs-dropdown");
  if (dd) dd.style.display = "none";
}

function onDocItemClick(fileId) {
  var idx = selectedDocIds.indexOf(fileId);
  if (idx !== -1) { selectedDocIds.splice(idx, 1); }
  else { selectedDocIds.push(fileId); }
  renderDocTags();
  var dd = document.getElementById("chat-docs-dropdown");
  if (dd) dd.style.display = "none";
}

function removeDocTag(fileId) {
  selectedDocIds = selectedDocIds.filter(function (id) { return id !== fileId; });
  renderDocTags();
}

document.addEventListener("click", function (e) {
  var dd = document.getElementById("chat-docs-dropdown");
  if (!dd || dd.style.display === "none") return;
  var toggle = document.getElementById("chat-docs-toggle");
  if ((toggle && toggle.contains(e.target)) || dd.contains(e.target)) return;
  dd.style.display = "none";
});

function loadDocSelectorList() {
  var list = document.getElementById("chat-docs-dropdown-list");
  if (!list) return;
  fetch(BACKEND_URL + "/api/v1/knowledge/list")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.data || data.data.length === 0) {
        list.innerHTML = '<div style="color:var(--text-secondary);padding:8px 12px;font-size:12px">暂无文档，请先上传</div>';
        return;
      }
      docInfoMap = {};
      data.data.forEach(function (doc) {
        docInfoMap[doc.file_id] = { name: doc.file_name, pages: doc.total_pages };
      });
      list.innerHTML = data.data.map(function (doc) {
        var sel = selectedDocIds.indexOf(doc.file_id) !== -1;
        return '<div class="chat-docs-dropdown-item' + (sel ? " selected" : "") +
          '" onclick="event.stopPropagation();onDocItemClick(\'' + doc.file_id + '\')">' +
          (sel ? "✓ " : "") + escapeHtml(doc.file_name) +
          '<span style="color:var(--text-secondary);font-size:10px;margin-left:auto">' + (doc.total_pages || 0) + ' 块</span></div>';
      }).join("");
    })
    .catch(function () {
      list.innerHTML = '<div style="color:var(--error);padding:8px 12px;font-size:12px">加载失败</div>';
    });
}

function renderDocTags() {
  var tags = document.getElementById("chat-docs-tags");
  if (!tags) return;
  if (selectedDocIds.length === 0) {
    tags.innerHTML = '<span style="color:var(--text-secondary);font-size:11px">未选择文档</span>';
    return;
  }
  tags.innerHTML = selectedDocIds.map(function (id) {
    var info = docInfoMap[id];
    var name = info ? info.name : id.substring(0, 20) + "...";
    return '<span class="chat-docs-tag">' + escapeHtml(name) +
      '<span class="chat-docs-tag-remove" onclick="event.stopPropagation();removeDocTag(\'' + id + '\')">x</span></span>';
  }).join("");
}

renderDocTags();

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
  await createNewSession();
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
    // 获取完整会话列表，避免历史会话被隐藏
    var listResp = await fetch(BACKEND_URL + "/api/v1/chat/sessions");
    var listData = await listResp.json();
    if (listData.data && listData.data.length > 0) {
      renderSessionList(listData.data);
    }
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
  // 清空文档选择
  selectedDocIds = [];
  renderDocTags();
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
  // 切换到对话页
  document.querySelectorAll(".nav-item").forEach(function (n) { n.classList.remove("active"); });
  var chatNav = document.querySelector('.nav-item[data-page="chat"]');
  if (chatNav) chatNav.classList.add("active");
  Object.values(pages).forEach(function (p) { if (p) p.classList.remove("active"); });
  if (pages.chat) pages.chat.classList.add("active");
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
  if (!text || !connected || currentStreaming) return;
  if (!currentSessionId) {
    await initSession();
    if (!currentSessionId) { showToast("会话初始化失败，请稍后重试", "error"); return; }
  }

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
        context_document_ids: selectedDocIds,
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
document.getElementById("kb-folder-select").addEventListener("change", function () {
  selectFolder(this.value);
});

// ---- 知识库文件夹树 ----
var currentFolderId = "";

async function loadFolderTree() {
  var tree = document.getElementById("folder-tree");
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/folders?tree=false");
    var data = await resp.json();
    var folders = data.data || [];
    var html = '<div class="folder-item' + (currentFolderId === "" ? " active" : "") + '" data-folder-id="" onclick="selectFolder(\'\')">' +
      '<span class="folder-icon">📁</span><span class="folder-item-name">全部文档</span></div>';
    folders.forEach(function (f) {
      html += '<div class="folder-item' + (currentFolderId === f.folder_id ? " active" : "") + '" data-folder-id="' + f.folder_id + '" onclick="selectFolder(\'' + f.folder_id + '\')">' +
        '<span class="folder-icon">📁</span>' +
        '<span class="folder-item-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</span>' +
        '<span class="folder-item-actions">' +
          '<button title="重命名" onclick="event.stopPropagation();renameFolderPrompt(\'' + f.folder_id + '\',\'' + escapeHtml(f.name) + '\')">✎</button>' +
          '<button title="删除" onclick="event.stopPropagation();deleteFolderConfirm(\'' + f.folder_id + '\')">✕</button>' +
        '</span></div>';
    });
    tree.innerHTML = html;
    // 保存全局文件夹列表，同步更新选择器
    folderList = folders;
    updateFolderSelectors(folders);
    return folders;
  } catch (_) {
    folderList = [];
    return [];
  }
}

function updateFolderSelectors(folders) {
  var opts = '<option value="">根目录</option>';
  folders.forEach(function (f) {
    opts += '<option value="' + f.folder_id + '">' + escapeHtml(f.name) + '</option>';
  });
  var selectors = [
    document.getElementById("kb-folder-select"),
    document.getElementById("asr-import-folder"),
  ];
  selectors.forEach(function (sel) {
    if (sel) {
      var currentVal = sel.value;
      sel.innerHTML = opts;
      sel.value = currentVal || "";
    }
  });
}

function selectFolder(folderId) {
  currentFolderId = folderId;
  document.querySelectorAll("#folder-tree .folder-item").forEach(function (el) {
    el.classList.toggle("active", el.dataset.folderId === folderId);
  });
  document.getElementById("kb-folder-select").value = folderId;
  loadKnowledgeList();
}

// ---- 文件夹 CRUD ----
document.getElementById("new-folder-btn").addEventListener("click", function (e) {
  e.stopPropagation();
  var tree = document.getElementById("folder-tree");
  // 移除已有的输入框
  var existingInput = tree.querySelector(".folder-input-row");
  if (existingInput) {
    existingInput.remove();
    return;
  }
  // 在树顶部插入输入框
  var inputRow = document.createElement("div");
  inputRow.className = "folder-input-row";
  inputRow.style.cssText = "display:flex;align-items:center;gap:4px;padding:6px 16px;border-bottom:1px solid var(--border)";
  var input = document.createElement("input");
  input.type = "text";
  input.placeholder = "文件夹名称";
  input.maxLength = 64;
  input.style.cssText = "flex:1;background:var(--bg-tertiary);border:1px solid var(--accent);border-radius:3px;color:var(--text-primary);padding:4px 8px;font-size:12px;outline:none";
  var confirmBtn = document.createElement("button");
  confirmBtn.textContent = "✓";
  confirmBtn.className = "btn btn-tiny";
  confirmBtn.style.cssText = "color:var(--success);border-color:var(--success)";
  var cancelBtn = document.createElement("button");
  cancelBtn.textContent = "✕";
  cancelBtn.className = "btn btn-tiny";
  cancelBtn.style.cssText = "color:var(--text-secondary)";

  function doCreate() {
    var name = input.value.trim();
    inputRow.remove();
    if (!name) return;
    fetch(BACKEND_URL + "/api/v1/knowledge/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.code === 100) {
        showToast("文件夹「" + name + "」已创建", "success");
        loadFolderTree();
      } else {
        showToast(data.message || "创建失败", "error");
      }
    }).catch(function () { showToast("创建失败", "error"); });
  }

  input.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") { ev.preventDefault(); doCreate(); }
    if (ev.key === "Escape") { ev.preventDefault(); inputRow.remove(); }
  });
  confirmBtn.addEventListener("click", doCreate);
  cancelBtn.addEventListener("click", function () { inputRow.remove(); });

  inputRow.appendChild(input);
  inputRow.appendChild(confirmBtn);
  inputRow.appendChild(cancelBtn);
  tree.insertBefore(inputRow, tree.firstChild);
  input.focus();
});

function renameFolderPrompt(folderId, oldName) {
  var name = prompt("重命名文件夹:", oldName);
  if (!name || !name.trim() || name.trim() === oldName) return;
  name = name.trim();
  fetch(BACKEND_URL + "/api/v1/knowledge/folders/" + folderId + "?name=" + encodeURIComponent(name), {
    method: "PUT",
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (data.code === 100) {
      showToast("已重命名为「" + name + "」", "success");
      loadFolderTree();
    } else {
      showToast(data.message || "重命名失败", "error");
    }
  }).catch(function () { showToast("重命名失败", "error"); });
}

function deleteFolderConfirm(folderId) {
  showConfirm("删除文件夹", "删除文件夹后其中的文档不会被删除，仅解除关联。确认？", async function () {
    try {
      var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/folders/" + folderId, { method: "DELETE" });
      var data = await resp.json();
      if (data.code === 100) {
        showToast("文件夹已删除", "success");
        if (currentFolderId === folderId) { currentFolderId = ""; }
        loadFolderTree();
        loadKnowledgeList();
      } else {
        showToast(data.message || "删除失败", "error");
      }
    } catch (_) { showToast("删除失败", "error"); }
  });
}

// ---- 知识库文件列表（版本分组） ----
async function loadKnowledgeList() {
  var container = document.getElementById("knowledge-list");
  try {
    var url = BACKEND_URL + "/api/v1/knowledge/list";
    if (currentFolderId) url += "?folder_id=" + currentFolderId;
    var resp = await fetch(url);
    var data = await resp.json();
    if (!data.data || data.data.length === 0) {
      container.innerHTML = '<p class="empty-state">尚未上传任何文档</p>';
      return;
    }
    // 按 import_group_id 分组
    var groups = {};
    var singles = [];
    data.data.forEach(function (f) {
      if (f.import_group_id) {
        if (!groups[f.import_group_id]) groups[f.import_group_id] = [];
        groups[f.import_group_id].push(f);
      } else {
        singles.push(f);
      }
    });
    // 组内按 version 降序
    Object.keys(groups).forEach(function (gid) {
      groups[gid].sort(function (a, b) { return b.version - a.version; });
    });

    var html = "";
    // 渲染版本组
    Object.keys(groups).forEach(function (gid) {
      var g = groups[gid];
      var latest = g[0];
      var gidSafe = gid.replace(/[^a-zA-Z0-9_-]/g, "");
      if (g.length === 1) {
        // 只有一个版本，作为普通条目
        html += renderFileItem(g[0]);
      } else {
        // 多版本，折叠组
        html += '<div class="version-group" id="vg-' + gidSafe + '">' +
          '<div class="version-group-header" onclick="toggleVersionGroup(\'' + gidSafe + '\')">' +
            '<div class="version-group-info">' +
              '<span class="version-group-name">' + escapeHtml(latest.original_name || latest.file_name) + '</span>' +
              '<span class="version-badge">v' + latest.version + '</span>' +
              '<span class="version-group-meta">共 ' + g.length + ' 个版本</span>' +
            '</div>' +
            '<span style="font-size:11px;color:var(--text-secondary)">展开 ▼</span>' +
          '</div>' +
          '<div class="version-list" style="display:none" id="vg-list-' + gidSafe + '">' +
            g.map(function (v) {
              var vid = v.file_id.replace(/[^a-zA-Z0-9_-]/g, "");
              return '<div class="version-item">' +
                '<input type="checkbox" class="kb-check" id="ck-' + vid + '" data-file-id="' + v.file_id + '" onchange="updateKBBatchCount()" />' +
                '<div class="version-item-info">' +
                  '<span class="version-badge" style="opacity:' + (v.version === latest.version ? '1' : '0.6') + '">v' + v.version + '</span>' +
                  '<span class="version-item-time">' + (v.create_time || "") + '</span>' +
                  '<span style="font-size:11px;color:var(--text-secondary)">' + formatSize(v.file_size) + ' · ' + v.total_pages + ' 块</span>' +
                '</div>' +
                '<div class="version-item-actions">' +
                  renderFileActions(v) +
                '</div>' +
              '</div>';
            }).join("") +
          '</div>' +
        '</div>';
      }
    });
    // 渲染单文件
    singles.forEach(function (f) {
      html += renderFileItem(f);
    });

    container.innerHTML = html || '<p class="empty-state">尚未上传任何文档</p>';
  } catch (_) {
    container.innerHTML = '<p class="empty-state">无法加载知识库数据</p>';
  }
}

function renderFileItem(f) {
  var fid = f.file_id.replace(/[^a-zA-Z0-9_-]/g, "");
  return '<div class="kb-file-item">' +
    '<input type="checkbox" class="kb-check" id="ck-' + fid + '" data-file-id="' + f.file_id + '" onchange="updateKBBatchCount()" />' +
    '<div class="kb-file-info">' +
      '<span class="kb-file-name">' + escapeHtml(f.file_name) +
        (f.version > 1 ? ' <span class="version-badge">v' + f.version + '</span>' : '') +
      '</span>' +
      '<span class="kb-file-meta">' +
        '<span>' + formatSize(f.file_size) + '</span>' +
        '<span>' + f.total_pages + ' 块</span>' +
        '<span class="kb-isolate-toggle" title="点击切换隔离模式" onclick="event.stopPropagation();changeIsolate(\'' + f.file_id + '\')">' +
          '<span class="kb-badge kb-badge-' + f.isolate_mode + '">' + f.isolate_mode + '</span>' +
          ' ↻' +
        '</span>' +
        (f.create_time ? '<span>' + f.create_time + '</span>' : '') +
      '</span>' +
    '</div>' +
    '<div class="kb-file-actions">' +
      renderFileActions(f) +
    '</div>' +
  '</div>';
}

var folderList = [];

function renderFileActions(f) {
  var folderOpts = '<option value="">移至文件夹...</option>';
  folderList.forEach(function (fl) {
    var sel = (f.folder_id === fl.folder_id) ? " selected" : "";
    folderOpts += '<option value="' + fl.folder_id + '"' + sel + '>' + escapeHtml(fl.name) + '</option>';
  });
  return '<button class="btn btn-tiny" onclick="downloadDocument(\'' + f.file_id + '\')" title="下载原文件">下载</button>' +
    '<select class="export-select" onchange="exportDocument(\'' + f.file_id + '\',this.value);this.value=\'\'">' +
      '<option value="">导出...</option>' +
      '<option value="txt">TXT</option>' +
      '<option value="md">MD</option>' +
      '<option value="docx">DOCX</option>' +
    '</select>' +
    '<select class="export-select" onchange="moveFileToFolder(\'' + f.file_id + '\',this.value)">' +
      folderOpts +
    '</select>' +
    '<button class="btn btn-tiny" onclick="playTTS(\'' + f.file_id + '\')" title="播放文档内容">🔊 TTS</button>' +
    '<button class="btn btn-tiny btn-primary" onclick="translateDocument(\'' + f.file_id + '\',\'' + escapeHtml(f.file_name).replace(/'/g, "\\'") + '\')" title="全文翻译">翻译</button>' +
    '<button class="btn btn-tiny btn-danger" onclick="deleteKnowledge(\'' + f.file_id + '\')">删除</button>';
}

function toggleVersionGroup(gid) {
  var list = document.getElementById("vg-list-" + gid);
  if (!list) return;
  if (list.style.display === "none") {
    list.style.display = "block";
    var header = list.previousElementSibling;
    if (header) header.querySelector("span:last-child").textContent = "收起 ▲";
  } else {
    list.style.display = "none";
    var header = list.previousElementSibling;
    if (header) header.querySelector("span:last-child").textContent = "展开 ▼";
  }
}

function downloadDocument(fileId) {
  var a = document.createElement("a");
  a.href = BACKEND_URL + "/api/v1/knowledge/download/" + fileId;
  a.download = "";
  a.click();
  showToast("文档下载中...", "success");
}

async function exportDocument(fileId, format) {
  if (!format) return;
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, format: format }),
    });
    if (!resp.ok) { showToast("导出失败", "error"); return; }
    var blob = await resp.blob();
    var disposition = resp.headers.get("Content-Disposition") || "";
    var fname = disposition.match(/filename="?(.+?)"?($|;)/);
    var filename = fname ? fname[1] : "export." + format;
    downloadBlob(blob, filename);
    showToast("已导出为 " + filename, "success");
  } catch (_) { showToast("导出失败", "error"); }
}

document.getElementById("upload-btn").addEventListener("click", function () {
  document.getElementById("file-input").click();
});

document.getElementById("file-input").addEventListener("change", async function (e) {
  var file = e.target.files[0];
  if (!file) return;

  var isolateMode = "session";
  var folderId = document.getElementById("kb-folder-select").value;
  var formData = new FormData();
  formData.append("file", file);
  formData.append("isolate_mode", isolateMode);
  formData.append("session_id", currentSessionId || "");
  if (folderId) formData.append("folder_id", folderId);

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
      var fileId = data.data ? data.data.file_id : null;
      var docName = file.name.replace(/\.[^.]+$/, "");
      showToast("文档上传成功，正在创建文档会话...", "success");

      // 自动创建同名会话 + 加载文档全文到上下文
      if (fileId) {
        try {
          var sessResp = await fetch(BACKEND_URL + "/api/v1/chat/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_version: "v1", title: docName }),
          });
          var sessData = await sessResp.json();
          if (sessData.data) {
            currentSessionId = sessData.data.session_id;
            selectedDocIds = [fileId];
            renderDocTags();
            // 刷新会话列表
            var listResp = await fetch(BACKEND_URL + "/api/v1/chat/sessions");
            var listData = await listResp.json();
            if (listData.data) renderSessionList(listData.data);
            // 切换到对话页
            document.querySelectorAll(".nav-item").forEach(function (n) { n.classList.remove("active"); });
            var chatNav = document.querySelector('.nav-item[data-page="chat"]');
            if (chatNav) chatNav.classList.add("active");
            Object.values(pages).forEach(function (p) { if (p) p.classList.remove("active"); });
            if (pages.chat) pages.chat.classList.add("active");
            chatMessages.innerHTML = '<div class="chat-placeholder"><div class="placeholder-icon"><svg viewBox="0 0 24 24" width="48" height="48"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" opacity="0.3"/></svg></div><p>已加载文档: ' + escapeHtml(docName) + '</p><p class="sub-text">文档全文已注入 AI 上下文，可直接提问</p></div>';
            showToast("已创建会话「" + docName + "」并加载文档", "success");
          }
        } catch (_) {}
      }
      loadKnowledgeList();
      loadFolderTree();
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

async function moveFileToFolder(fileId, folderId) {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/files/move", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, folder_id: folderId || null }),
    });
    var data = await resp.json();
    if (data.code === 100) {
      showToast("文件已移动", "success");
      loadKnowledgeList();
      loadFolderTree();
    } else {
      showToast(data.message || "移动失败", "error");
    }
  } catch (_) { showToast("移动失败", "error"); }
}

async function deleteKnowledge(fileId) {
  showConfirm("删除文档", "确认永久删除此文档？此操作不可撤销。", async function () {
    try {
      await fetch(BACKEND_URL + "/api/v1/knowledge/delete?file_id=" + fileId, { method: "DELETE" });
      loadKnowledgeList();
      loadFolderTree();
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
        var transcribedText = data.data.transcribed_text || "(空)";
        document.getElementById("asr-result-text").textContent = transcribedText;
        // 保存结果供导出和导入
        window._lastASRText = transcribedText;
        window._lastASRAudioName = data.data.audio_name || "transcription";
        window._lastASRArchiveId = data.data.archive_id;  // 供导入知识库使用

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

async function exportASRResult() {
  var archiveId = window._lastASRArchiveId;
  if (!archiveId) {
    // 降级：无 archive_id 时用前端文本通过 Blob 导出
    var text = window._lastASRText || "";
    if (!text || text === "(空)") { showToast("暂无可导出的转写结果", "warn"); return; }
    var name = (window._lastASRAudioName || "transcription").replace(/\.[^.]+$/, "");
    var format = document.getElementById("asr-export-format").value;
    var mime = format === "md" ? "text/markdown" : "text/plain;charset=utf-8";
    var blob = new Blob([text], { type: mime });
    downloadBlob(blob, name + "." + format);
    showToast("已导出", "success");
    return;
  }
  var format = document.getElementById("asr-export-format").value;
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/asr/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archive_id: archiveId, format: format }),
    });
    if (!resp.ok) { showToast("导出失败", "error"); return; }
    var blob = await resp.blob();
    var disposition = resp.headers.get("Content-Disposition") || "";
    var fname = disposition.match(/filename="?(.+?)"?($|;)/);
    var filename = fname ? fname[1] : "transcription." + format;
    downloadBlob(blob, filename);
    showToast("已导出为 " + filename, "success");
  } catch (_) { showToast("导出失败", "error"); }
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
      var aid = a.archive_id;
      var aaid = aid.replace(/[^a-zA-Z0-9_-]/g, "");
      return '<div class="kb-item">' +
        '<input type="checkbox" class="kb-check" id="ac-' + aaid + '" data-archive-id="' + aid + '" onchange="updateASRBatchCount()" />' +
        '<div class="kb-item-info">' +
          '<span class="kb-item-name">' + escapeHtml(a.audio_name) + '</span>' +
          '<span class="kb-item-meta">' + (a.duration || 0).toFixed(1) + 's · ' + (a.create_time || "") + '</span>' +
        '</div>' +
        '<div class="kb-item-actions" style="display:flex;align-items:center;gap:6px">' +
          '<select class="export-select" onchange="exportASRArchive(\'' + aid + '\',this.value);this.value=\'\'">' +
            '<option value="">导出...</option>' +
            '<option value="txt">TXT</option>' +
            '<option value="md">MD</option>' +
            '<option value="docx">DOCX</option>' +
          '</select>' +
          '<button class="btn btn-tiny btn-primary" onclick="showASRImportDialog(\'' + aid + '\',\'' + escapeHtml(a.audio_name).replace(/'/g, "\\'") + '\')">导入知识库</button>' +
        '</div>' +
      '</div>';
    }).join("");
  } catch (_) {
    container.innerHTML = '<p class="empty-state">无法加载转写记录</p>';
  }
}

async function exportASRArchive(archiveId, format) {
  if (!format) return;
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/asr/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archive_id: archiveId, format: format }),
    });
    if (!resp.ok) { showToast("导出失败", "error"); return; }
    var blob = await resp.blob();
    var disposition = resp.headers.get("Content-Disposition") || "";
    var fname = disposition.match(/filename="?(.+?)"?($|;)/);
    var filename = fname ? fname[1] : "transcription." + format;
    downloadBlob(blob, filename);
    showToast("已导出为 " + filename, "success");
  } catch (_) { showToast("导出失败", "error"); }
}

// ---- ASR 导入知识库弹窗 ----
var currentImportArchiveId = null;

function showASRImportDialog(archiveId, audioName) {
  // 如果从历史记录调用，使用传入的 archiveId；否则用当前结果
  currentImportArchiveId = archiveId || window._lastASRArchiveId || null;
  if (!currentImportArchiveId) { showToast("没有可导入的转写结果", "warn"); return; }

  var title = audioName || window._lastASRAudioName || "";
  document.getElementById("asr-import-title").value = title;
  document.getElementById("asr-import-modal").classList.remove("hidden");
}

async function submitASRImport() {
  if (!currentImportArchiveId) return;
  var title = document.getElementById("asr-import-title").value.trim();
  var format = document.getElementById("asr-import-format").value;
  var isolateMode = document.getElementById("asr-import-isolate").value;
  var folderId = document.getElementById("asr-import-folder").value;
  var submitBtn = document.getElementById("asr-import-submit-btn");
  submitBtn.disabled = true;
  submitBtn.textContent = "导入中...";

  try {
    var body = {
      archive_id: currentImportArchiveId,
      format: format,
      isolate_mode: isolateMode,
    };
    if (title) body.title = title;
    if (folderId) body.folder_id = folderId;
    if (isolateMode === "session" && currentSessionId) body.session_id = currentSessionId;

    var resp = await fetch(BACKEND_URL + "/api/v1/asr/import-to-kb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    var data = await resp.json();
    if (data.code === 100) {
      showToast("已导入知识库 (" + (data.data && data.data.chunk_count || 0) + " 个分片)", "success");
      document.getElementById("asr-import-modal").classList.add("hidden");
      loadFolderTree();
      loadKnowledgeList();
    } else {
      showToast(data.message || "导入失败", "error");
    }
  } catch (_) {
    showToast("导入请求失败", "error");
  }
  submitBtn.disabled = false;
  submitBtn.textContent = "确认导入";
}

// 绑定导入弹窗按钮
document.getElementById("asr-import-submit-btn").addEventListener("click", submitASRImport);
document.getElementById("asr-import-cancel-btn").addEventListener("click", function () {
  document.getElementById("asr-import-modal").classList.add("hidden");
});
// 点击遮罩关闭
document.querySelector("#asr-import-modal .modal-mask").addEventListener("click", function () {
  document.getElementById("asr-import-modal").classList.add("hidden");
});

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
  var btn = document.getElementById("export-logs-btn");
  btn.disabled = true;
  btn.textContent = "导出中...";

  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/log/export/all?format=json&api_version=v1");
    var data = await resp.json();
    var logs = data.logs || [];
    var timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

    // JSON
    var jsonBlob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    downloadBlob(jsonBlob, "audit-log-" + timestamp + ".json");

    // CSV (client-side generation)
    var csvHeader = "log_id,absolute_datetime,relative_timestamp_ms,log_type,metrics,payload_snapshot\n";
    var csvLines = logs.map(function (l) {
      var payload = (l.payload_snapshot || "").replace(/"/g, '""');
      var metrics = l.metrics ? JSON.stringify(l.metrics).replace(/"/g, '""') : "";
      return '"' + l.log_id + '","' + l.absolute_datetime + '",' + l.relative_timestamp_ms + ',"' + l.log_type + '","' + metrics + '","' + payload + '"';
    });
    var csvBlob = new Blob([csvHeader + csvLines.join("\n")], { type: "text/csv" });
    setTimeout(function () { downloadBlob(csvBlob, "audit-log-" + timestamp + ".csv"); }, 300);

    showToast("已导出 JSON + CSV (" + logs.length + " 条)", "success");
  } catch (_) {
    showToast("导出失败", "error");
  }

  btn.disabled = false;
  btn.textContent = "一键导出 (JSON+CSV)";
});

function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

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

// ---- 凭据丢失自动检测 ----
var credentialLostNotified = false;

async function pollCredentialStatus() {
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/system/credential/status");
    var data = await resp.json();
    if (data.data && !data.data.credential_present) {
      if (!credentialLostNotified) {
        credentialLostNotified = true;
        showToast("检测到加密凭据丢失！请立即导入恢复密钥", "error");
        document.getElementById("credential-modal").classList.remove("hidden");
      }
    } else {
      credentialLostNotified = false;
    }
  } catch (_) {}
}

setInterval(pollCredentialStatus, 30000);

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

// ---- 知识库批量操作 ----

function updateKBBatchCount() {
  var checks = document.querySelectorAll("#knowledge-list .kb-check:checked");
  var count = checks.length;
  document.getElementById("kb-batch-count").textContent = "已选 " + count + " 项";
  document.getElementById("kb-check-all").checked = false;
}

function toggleAllKB(cb) {
  var checks = document.querySelectorAll("#knowledge-list .kb-check");
  checks.forEach(function (c) { c.checked = cb.checked; });
  updateKBBatchCount();
}

async function changeIsolate(fileId) {
  var modes = ["global", "session", "temp"];
  // 获取当前模式
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/list");
    var data = await resp.json();
    var file = (data.data || []).find(function (f) { return f.file_id === fileId; });
    if (!file) { showToast("文档未找到", "error"); return; }
    var curMode = file.isolate_mode;
    var nextIdx = (modes.indexOf(curMode) + 1) % modes.length;
    var nextMode = modes[nextIdx];

    var putResp = await fetch(BACKEND_URL + "/api/v1/knowledge/files/isolate", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, isolate_mode: nextMode, session_id: currentSessionId }),
    });
    if (putResp.ok) {
      showToast("隔离模式已切换为: " + nextMode, "success");
      loadKnowledgeList();
    } else {
      showToast("切换失败", "error");
    }
  } catch (_) { showToast("操作失败", "error"); }
}

async function batchIsolate(mode) {
  if (!mode) return;
  var checks = document.querySelectorAll("#knowledge-list .kb-check:checked");
  var fileIds = [];
  checks.forEach(function (c) { fileIds.push(c.dataset.fileId); });
  if (fileIds.length === 0) { showToast("请先选择文档", "warn"); return; }
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/batch/isolate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_ids: fileIds, isolate_mode: mode, session_id: currentSessionId }),
    });
    if (resp.ok) {
      showToast("已将 " + fileIds.length + " 个文档设为: " + mode, "success");
      loadKnowledgeList();
    }
  } catch (_) { showToast("批量隔离失败", "error"); }
}

async function batchKnowledgeAction(action) {
  var checks = document.querySelectorAll("#knowledge-list .kb-check:checked");
  var fileIds = [];
  checks.forEach(function (c) { fileIds.push(c.dataset.fileId); });
  if (fileIds.length === 0) { showToast("请先选择文档", "warn"); return; }

  if (action === "delete") {
    showConfirm("批量删除", "确定要删除选中的 " + fileIds.length + " 个文档吗？此操作不可恢复。", async function () {
      try {
        var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/batch/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_ids: fileIds }),
        });
        var data = await resp.json();
        showToast("已删除 " + (data.data ? data.data.deleted_count : 0) + " 个文档", "success");
        loadKnowledgeList();
      } catch (_) { showToast("批量删除失败", "error"); }
    });
  } else if (action === "translate") {
    showToast("正在批量翻译 " + fileIds.length + " 个文档...", "success");
    try {
      var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/batch/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: fileIds, source_lang: "auto", target_lang: "zh" }),
      });
      var data = await resp.json();
      if (data.data && data.data.results) {
        // 存储到翻译历史
        data.data.results.forEach(function (r) {
          if (r.status === "ok") {
            addTranslateHistory(r.file_id, "", r.translated_text);
          }
        });
        showToast("翻译完成，点击翻译页面查看", "success");
        // 跳转到翻译页
        document.querySelector(".nav-item[data-page=translate]").click();
      }
    } catch (_) { showToast("批量翻译失败", "error"); }
  }
}

// ---- TTS ----

async function playTTS(fileId) {
  showToast("正在生成语音...", "success");
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, language: "zh" }),
    });
    if (resp.ok) {
      var blob = await resp.blob();
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      audio.onended = function () { URL.revokeObjectURL(url); };
      audio.play();
      showToast("正在播放...", "success");
    } else {
      var errData = await resp.json();
      showToast(errData.message || "TTS 失败", "error");
    }
  } catch (_) { showToast("TTS 服务不可用", "error"); }
}

// ---- 翻译 ----

var translateHistory = [];
var currentTranslateFileId = null;

function addTranslateHistory(fileId, fileName, translatedText) {
  // 去重
  translateHistory = translateHistory.filter(function (h) { return h.file_id !== fileId; });
  translateHistory.unshift({
    file_id: fileId,
    file_name: fileName,
    translated_text: translatedText,
    time: new Date().toISOString(),
  });
  // 最多保留 50 条
  if (translateHistory.length > 50) translateHistory.pop();
}

async function translateDocument(fileId, fileName) {
  showToast("正在翻译...", "success");
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, source_lang: "auto", target_lang: "zh" }),
    });
    var data = await resp.json();
    if (data.code === 100 && data.data) {
      addTranslateHistory(fileId, fileName || data.data.file_name, data.data.translated_text);
      currentTranslateFileId = fileId;
      // 更新翻译视窗
      document.getElementById("tr-source-text").textContent = data.data.original_text;
      document.getElementById("tr-target-text").textContent = data.data.translated_text;
      document.getElementById("tr-source-name").textContent = data.data.file_name;
      showToast("翻译完成", "success");
      // 跳转到翻译页
      document.querySelector(".nav-item[data-page=translate]").click();
      loadTranslateHistory();
    } else {
      showToast(data.message || "翻译失败", "error");
    }
  } catch (_) { showToast("翻译服务不可用", "error"); }
}

function loadTranslateHistory() {
  var container = document.getElementById("tr-history-list");
  if (translateHistory.length === 0) {
    container.innerHTML = '<p class="empty-state">暂无翻译记录</p>';
    return;
  }
  container.innerHTML = translateHistory.map(function (h, idx) {
    return '<div class="tr-history-item' + (h.file_id === currentTranslateFileId ? ' active' : '') + '" onclick="loadTranslateItem(' + idx + ')">' +
      '<span class="tr-history-name">' + escapeHtml(h.file_name || h.file_id) + '</span>' +
      '<span class="tr-history-time">' + (h.time || "").substring(0, 16) + '</span>' +
    '</div>';
  }).join("");
}

function loadTranslateItem(idx) {
  var h = translateHistory[idx];
  if (!h) return;
  currentTranslateFileId = h.file_id;
  document.getElementById("tr-source-text").textContent = "";
  document.getElementById("tr-target-text").textContent = h.translated_text;
  document.getElementById("tr-source-name").textContent = h.file_name;
  loadTranslateHistory();
}

function exportTranslation() {
  if (!currentTranslateFileId) { showToast("请先选择翻译记录", "warn"); return; }
  var h = translateHistory.find(function (x) { return x.file_id === currentTranslateFileId; });
  if (!h) { showToast("翻译记录未找到", "error"); return; }

  var format = document.getElementById("tr-export-format").value;
  var content = h.translated_text;
  var filename = (h.file_name || "translation") + "_zh." + format;
  var mime = "text/plain";

  if (format === "md") {
    mime = "text/markdown";
    content = "# " + (h.file_name || "翻译") + "\n\n" + content;
  } else if (format === "docx") {
    showToast("DOCX 导出请使用后端接口", "warn");
    return;
  }

  var blob = new Blob([content], { type: mime });
  downloadBlob(blob, filename);
  showToast("已导出: " + filename, "success");
}

async function importTranslationToKB() {
  if (!currentTranslateFileId) { showToast("请先选择翻译记录", "warn"); return; }
  var h = translateHistory.find(function (x) { return x.file_id === currentTranslateFileId; });
  if (!h) { showToast("翻译记录未找到", "error"); return; }

  document.getElementById("tr-import-title").value = (h.file_name || "translation") + "_中文";
  // 填充文件夹选择
  var folderSelect = document.getElementById("tr-import-folder");
  folderSelect.innerHTML = '<option value="">根目录</option>';
  folderList.forEach(function (fl) {
    folderSelect.innerHTML += '<option value="' + fl.folder_id + '">' + escapeHtml(fl.name) + '</option>';
  });
  document.getElementById("tr-import-modal").classList.remove("hidden");

  // 绑定提交事件
  var submitBtn = document.getElementById("tr-import-submit-btn");
  var cancelBtn = document.getElementById("tr-import-cancel-btn");
  var modal = document.getElementById("tr-import-modal");

  function cleanup() {
    submitBtn.removeEventListener("click", handler);
    cancelBtn.removeEventListener("click", cleanup);
  }

  async function handler() {
    submitBtn.disabled = true;
    submitBtn.textContent = "导入中...";
    var title = document.getElementById("tr-import-title").value.trim() || (h.file_name + "_中文");
    var format = document.getElementById("tr-import-format").value;
    var isolateMode = document.getElementById("tr-import-isolate").value;
    var folderId = document.getElementById("tr-import-folder").value;

    try {
      // 先上传翻译文本为文件
      var content = h.translated_text;
      var ext = format === "md" ? "md" : "txt";
      var blob = new Blob([content], { type: "text/plain" });
      var formData = new FormData();
      formData.append("file", blob, title + "." + ext);
      formData.append("isolate_mode", isolateMode);
      formData.append("session_id", currentSessionId || "");
      if (folderId) formData.append("folder_id", folderId);

      var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/upload", {
        method: "POST",
        body: formData,
      });
      var data = await resp.json();
      if (data.code === 100) {
        showToast("翻译结果已导入知识库", "success");
        modal.classList.add("hidden");
        cleanup();
      } else {
        showToast(data.message || "导入失败", "error");
        submitBtn.disabled = false;
        submitBtn.textContent = "确认导入";
      }
    } catch (_) {
      showToast("导入失败", "error");
      submitBtn.disabled = false;
      submitBtn.textContent = "确认导入";
    }
  }

  submitBtn.addEventListener("click", handler);
  cancelBtn.addEventListener("click", function () {
    modal.classList.add("hidden");
    cleanup();
  });
}

// ---- ASR 批量操作 ----

function updateASRBatchCount() {
  var checks = document.querySelectorAll("#asr-archive-list .kb-check:checked");
  var count = checks.length;
  document.getElementById("asr-batch-count").textContent = "已选 " + count + " 项";
  document.getElementById("asr-check-all").checked = false;
}

function toggleAllASR(cb) {
  var checks = document.querySelectorAll("#asr-archive-list .kb-check");
  checks.forEach(function (c) { c.checked = cb.checked; });
  updateASRBatchCount();
}

function getSelectedArchiveIds() {
  var checks = document.querySelectorAll("#asr-archive-list .kb-check:checked");
  var ids = [];
  checks.forEach(function (c) { ids.push(c.dataset.archiveId); });
  return ids;
}

async function batchASR(action) {
  var ids = getSelectedArchiveIds();
  if (ids.length === 0) { showToast("请先选择转写记录", "warn"); return; }

  if (action === "export") {
    var format = document.getElementById("asr-batch-format").value;
    try {
      var resp = await fetch(BACKEND_URL + "/api/v1/asr/batch/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archive_ids: ids, format: format }),
      });
      if (resp.ok) {
        var blob = await resp.blob();
        downloadBlob(blob, "asr_batch_export.zip");
        showToast("批量导出完成", "success");
      } else {
        showToast("批量导出失败", "error");
      }
    } catch (_) { showToast("批量导出失败", "error"); }
  } else if (action === "import-kb") {
    var format2 = document.getElementById("asr-batch-format").value;
    showToast("正在批量导入 " + ids.length + " 条记录...", "success");
    try {
      var resp2 = await fetch(BACKEND_URL + "/api/v1/asr/batch/import-to-kb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archive_ids: ids, format: format2, isolate_mode: "global", session_id: currentSessionId }),
      });
      var data2 = await resp2.json();
      var okCount = (data2.data ? data2.data.results || [] : []).filter(function (r) { return r.status === "ok"; }).length;
      showToast("成功导入 " + okCount + " / " + ids.length + " 条到知识库", "success");
      loadFolderTree();
    } catch (_) { showToast("批量导入失败", "error"); }
  } else if (action === "delete") {
    showConfirm("批量删除", "确定要删除选中的 " + ids.length + " 条转写记录吗？此操作不可恢复。", async function () {
      try {
        var resp3 = await fetch(BACKEND_URL + "/api/v1/asr/batch/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archive_ids: ids }),
        });
        var data3 = await resp3.json();
        showToast("已删除 " + (data3.data ? data3.data.deleted_count : 0) + " 条记录", "success");
        loadASRArchives();
      } catch (_) { showToast("批量删除失败", "error"); }
    });
  }
}
