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

// ---- I18N 国际化 ----
let currentLang = localStorage.getItem("qvac_lang") || "zh";

// ---- Lucide SVG 图标库 (纯离线, stroke-based) ----
const ICONS = {
  folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  volume2: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
};

const I18N = {
  // 导航
  "app.title":             { zh: "QVAC Hackathon 离线 AI 办公助手", en: "QVAC Hackathon Offline AI Office Assistant" },
  "app.brand":             { zh: "QVAC 办公助手", en: "QVAC Assistant" },
  "app.ready":             { zh: "就绪", en: "Ready" },
  "app.offline":           { zh: "离线", en: "Offline" },
  "app.connected":         { zh: "后端已连接", en: "Backend Connected" },
  "app.disconnected":      { zh: "后端未连接", en: "Backend Disconnected" },
  "nav.sessions":          { zh: "会话", en: "Sessions" },
  "nav.newSession":        { zh: "新建会话", en: "New Session" },
  "nav.newSessionTitle":   { zh: "新会话", en: "New Session" },
  "nav.aiChat":            { zh: "AI 对话", en: "AI Chat" },
  "nav.knowledge":         { zh: "知识库", en: "Knowledge Base" },
  "nav.asr":               { zh: "语音转写", en: "Speech to Text" },
  "nav.translate":         { zh: "翻译", en: "Translate" },
  "nav.audit":             { zh: "审计日志", en: "Audit Log" },
  "nav.settings":          { zh: "系统设置", en: "Settings" },

  // 对话页
  "chat.emptyTitle":       { zh: "开始离线隐私对话", en: "Start Offline Private Chat" },
  "chat.emptySub":         { zh: "所有推理 100% 本地运行，数据零外泄", en: "100% local inference. Zero data leakage." },
  "chat.contextDocs":      { zh: "上下文文档:", en: "Context Docs:" },
  "chat.selectDoc":        { zh: "选择文档", en: "Select Documents" },
  "chat.placeholder":      { zh: "输入消息...", en: "Type a message..." },
  "chat.send":             { zh: "发送", en: "Send" },
  "chat.userRole":         { zh: "用户", en: "User" },
  "chat.assistantRole":    { zh: "助手", en: "Assistant" },
  "chat.emptyResponse":    { zh: "(空响应)", en: "(Empty response)" },
  "chat.truncatedTag":     { zh: "[已自动归档早期历史记忆]", en: "[Early history auto-archived]" },
  "chat.loadedDoc":        { zh: "已加载文档: ", en: "Loaded document: " },
  "chat.loadedDocSub":     { zh: "文档全文已注入 AI 上下文，可直接提问", en: "Full text injected into AI context. You can ask questions directly." },
  "chat.noDocs":           { zh: "暂无文档，请先上传", en: "No documents. Please upload first." },
  "chat.loadFailed":       { zh: "加载失败", en: "Load failed" },
  "chat.noDocSelected":    { zh: "未选择文档", en: "No document selected" },
  "chat.chunks":           { zh: " 块", en: " chunks" },
  "chat.ttsPlay":          { zh: "朗读", en: "Read Aloud" },
  "chat.ttsStop":          { zh: "停止", en: "Stop" },
  "chat.sessionDefault":   { zh: "会话", en: "Session" },
  "chat.dblClickRename":   { zh: "双击重命名", en: "Double-click to rename" },
  "chat.closeSession":     { zh: "关闭会话", en: "Close Session" },

  // 知识库
  "kb.title":              { zh: "知识库管理", en: "Knowledge Base" },
  "kb.root":               { zh: "根目录", en: "Root" },
  "kb.allDocs":            { zh: "全部文档", en: "All Documents" },
  "kb.upload":             { zh: "上传文档", en: "Upload" },
  "kb.uploading":          { zh: "上传中...", en: "Uploading..." },
  "kb.selectAll":          { zh: "全选", en: "Select All" },
  "kb.selected":           { zh: "已选 ", en: "Selected: " },
  "kb.selectedItems":      { zh: " 项", en: "" },
  "kb.batchIsolate":       { zh: "批量隔离...", en: "Batch Isolate..." },
  "kb.global":             { zh: "全局", en: "Global" },
  "kb.session":            { zh: "会话", en: "Session" },
  "kb.temp":               { zh: "临时", en: "Temp" },
  "kb.batchDelete":        { zh: "批量删除", en: "Batch Delete" },
  "kb.batchTranslate":     { zh: "批量翻译", en: "Batch Translate" },
  "kb.batchExport":        { zh: "批量导出", en: "Batch Export" },
  "kb.batchImport":        { zh: "批量导入", en: "Batch Import" },
  "kb.folders":            { zh: "文件夹", en: "Folders" },
  "kb.newFolder":          { zh: "新建文件夹", en: "New Folder" },
  "kb.emptyState":         { zh: "尚未上传任何文档", en: "No documents uploaded yet" },
  "kb.versions":           { zh: "共 ", en: "" },
  "kb.versionsSuffix":     { zh: " 个版本", en: " versions" },
  "kb.expand":             { zh: "展开 ▼", en: "Expand ▼" },
  "kb.collapse":           { zh: "收起 ▲", en: "Collapse ▲" },
  "kb.moveToFolder":       { zh: "移至文件夹...", en: "Move to folder..." },
  "kb.download":           { zh: "下载", en: "Download" },
  "kb.downloadTitle":      { zh: "下载原文件", en: "Download original file" },
  "kb.export":             { zh: "导出...", en: "Export..." },
  "kb.ttsDocTitle":        { zh: "播放文档内容", en: "Play document content" },
  "kb.translateTitle":     { zh: "全文翻译", en: "Full-text translation" },
  "kb.translateBtn":       { zh: "翻译", en: "Translate" },
  "kb.delete":             { zh: "删除", en: "Delete" },
  "kb.rename":             { zh: "重命名", en: "Rename" },
  "kb.dataError":          { zh: "无法加载知识库数据", en: "Failed to load knowledge base data" },
  "kb.clickSwitchMode":    { zh: "点击切换隔离模式", en: "Click to switch isolation mode" },
  "kb.pageSize":           { zh: " 块", en: " chunks" },

  // ASR
  "asr.title":             { zh: "语音转写 (ASR)", en: "Speech to Text (ASR)" },
  "asr.hint":              { zh: "仅支持标准 WAV 格式", en: "WAV format only" },
  "asr.dropText":          { zh: "拖入 WAV 音频文件或点击选择", en: "Drop WAV audio files or click to select" },
  "asr.dropSub":           { zh: "支持单声道/立体声 16bit WAV", en: "Supports mono/stereo 16bit WAV" },
  "asr.selectFile":        { zh: "选择音频文件", en: "Select Audio File" },
  "asr.processing":        { zh: "处理中", en: "Processing" },
  "asr.completed":         { zh: "已完成", en: "Completed" },
  "asr.remaining":         { zh: "剩余: ", en: "Remaining: " },
  "asr.done":              { zh: "完成", en: "Done" },
  "asr.duration":          { zh: "时长: ", en: "Duration: " },
  "asr.empty":             { zh: "(空)", en: "(Empty)" },
  "asr.result":            { zh: "转写结果", en: "Transcription Result" },
  "asr.exportBtn":         { zh: "导出", en: "Export" },
  "asr.importKbBtn":       { zh: "导入知识库", en: "Import to KB" },
  "asr.archive":           { zh: "历史转写记录", en: "Transcription History" },
  "asr.archiveEmpty":      { zh: "暂无转写记录", en: "No transcription records" },
  "asr.archiveError":      { zh: "无法加载转写记录", en: "Failed to load transcription records" },

  // 翻译
  "tr.title":              { zh: "翻译文本视窗", en: "Translation View" },
  "tr.exportBtn":          { zh: "导出", en: "Export" },
  "tr.importKbBtn":        { zh: "导入知识库", en: "Import to KB" },
  "tr.history":            { zh: "翻译记录", en: "Translation History" },
  "tr.historyEmpty":       { zh: "暂无翻译记录", en: "No translation history" },
  "tr.source":             { zh: "原文", en: "Original" },
  "tr.target":             { zh: "译文", en: "Translation" },
  "tr.targetLang":         { zh: "目标语言:", en: "Target Language:" },
  "tr.langZH":             { zh: "中文", en: "Chinese" },
  "tr.sourceEmpty":        { zh: "选择文档并点击翻译按钮开始", en: "Select a document and click translate to start" },
  "tr.targetEmpty":        { zh: "翻译结果将在此显示", en: "Translation result will be displayed here" },
  "tr.origNotSaved":       { zh: "(原文未保存，请重新翻译)", en: "(Original not saved, please re-translate)" },
  "tr.exportDocxWarn":     { zh: "DOCX 导出请使用后端接口", en: "DOCX export requires backend API" },
  "tr.progressTitle":      { zh: "正在翻译...", en: "Translating..." },
  "tr.progressHint":       { zh: "请稍候，翻译完成后将自动显示结果", en: "Please wait, results will appear automatically" },

  // 审计日志
  "audit.title":           { zh: "审计日志", en: "Audit Log" },
  "audit.exportBtn":       { zh: "一键导出 (JSON+CSV)", en: "Export (JSON+CSV)" },
  "audit.relTime":         { zh: "相对时间", en: "Relative Time" },
  "audit.absTime":         { zh: "绝对时间", en: "Absolute Time" },
  "audit.type":            { zh: "类型", en: "Type" },
  "audit.summary":         { zh: "摘要", en: "Summary" },
  "audit.loadHint":        { zh: "点击「导出 JSON」加载审计数据", en: "Click Export to load audit data" },
  "audit.noConnection":    { zh: "无法加载审计数据 — 后端未连接", en: "Cannot load audit data — backend disconnected" },
  "audit.noData":          { zh: "暂无日志记录", en: "No log records" },
  "audit.total":           { zh: "共 ", en: "Total: " },
  "audit.records":         { zh: " 条", en: "" },
  "audit.pageInfo":        { zh: " 条 / ", en: " / " },
  "audit.pages":           { zh: " 页", en: " pages" },
  "audit.prev":            { zh: "上一页", en: "Previous" },
  "audit.next":            { zh: "下一页", en: "Next" },
  "audit.exporting":       { zh: "导出中...", en: "Exporting..." },

  // 系统设置
  "settings.title":        { zh: "系统设置", en: "Settings" },
  "settings.systemStatus": { zh: "系统状态", en: "System Status" },
  "settings.masterState":  { zh: "主线程状态", en: "Master Thread" },
  "settings.activeWorkers":{ zh: "活跃 Worker", en: "Active Workers" },
  "settings.killSwitch":   { zh: "Kill Switch", en: "Kill Switch" },
  "settings.hardware":     { zh: "硬件信息", en: "Hardware Info" },
  "settings.gpuMem":       { zh: "GPU 显存", en: "GPU Memory" },
  "settings.cpuUsage":     { zh: "CPU 利用率", en: "CPU Usage" },
  "settings.ramUsage":     { zh: "RAM 使用", en: "RAM Usage" },
  "settings.dataSecurity": { zh: "数据安全", en: "Data Security" },
  "settings.credManager":  { zh: "凭据管理器", en: "Credential Manager" },
  "settings.encryption":   { zh: "加密状态", en: "Encryption" },
  "settings.exportKey":    { zh: "导出恢复密钥 (.key)", en: "Export Recovery Key (.key)" },
  "settings.genMnemonic":  { zh: "生成助记词", en: "Generate Mnemonic" },
  "settings.importKey":    { zh: "导入恢复密钥", en: "Import Recovery Key" },
  "settings.language":     { zh: "语言 / Language", en: "Language / 语言" },
  "settings.langLabel":    { zh: "界面语言", en: "Interface Language" },
  "settings.appearance":   { zh: "外观 / Appearance", en: "Appearance / 外观" },
  "settings.themeLabel":   { zh: "深色模式", en: "Dark Mode" },
  "settings.none":         { zh: "无", en: "None" },
  "settings.locked":       { zh: "已锁定", en: "Locked" },
  "settings.normal":       { zh: "正常", en: "Normal" },
  "settings.managed":      { zh: "已托管", en: "Managed" },
  "settings.missing":      { zh: "缺失", en: "Missing" },
  "settings.aes256":       { zh: "AES-256-GCM", en: "AES-256-GCM" },
  "settings.plaintext":    { zh: "明文 (降级)", en: "Plaintext (Degraded)" },

  // 弹窗 / 模态框
  "modal.confirmTitle":    { zh: "确认操作", en: "Confirm" },
  "modal.confirming":      { zh: "确认 (", en: "Confirm (" },
  "modal.confirmDone":     { zh: "确认", en: "Confirm" },
  "modal.processing":      { zh: "处理中...", en: "Processing..." },
  "modal.cancel":          { zh: "取消", en: "Cancel" },
  "modal.credTitle":       { zh: "密钥灾备恢复", en: "Key Recovery" },
  "modal.credMsg":         { zh: "Windows 凭据管理器主密钥丢失，请导入恢复文件或助记词。", en: "Windows Credential Manager master key lost. Please import recovery file or mnemonic." },
  "modal.credPlaceholder": { zh: "粘贴 .key 文件内容 (64位 hex) 或 12 位中文助记词", en: "Paste .key file content (64-char hex) or 12-word mnemonic" },
  "modal.credSubmit":      { zh: "提交恢复", en: "Submit Recovery" },
  "modal.credLater":       { zh: "稍后处理", en: "Later" },
  "modal.setupTitle":      { zh: "首次启动 — 安全配置", en: "First Launch — Security Setup" },
  "modal.setupMsg":        { zh: "本地加密主密钥已自动生成。请务必导出并安全保存恢复密钥，否则数据将无法恢复。", en: "Local encryption master key has been auto-generated. Please export and safely store the recovery key, otherwise data will be unrecoverable." },
  "modal.setupKeyLabel":   { zh: "恢复密钥 (64 hex):", en: "Recovery Key (64 hex):" },
  "modal.setupMnemonic":   { zh: "12 位助记词:", en: "12-word Mnemonic:" },
  "modal.loading":         { zh: "加载中...", en: "Loading..." },
  "modal.copy":            { zh: "复制", en: "Copy" },
  "modal.downloadKey":     { zh: "下载 .key 文件", en: "Download .key File" },
  "modal.saved":           { zh: "我已安全保存", en: "I Have Saved It Safely" },
  "modal.importAsrTitle":  { zh: "导入转写结果到知识库", en: "Import Transcription to Knowledge Base" },
  "modal.importTrTitle":   { zh: "导入翻译结果到知识库", en: "Import Translation to Knowledge Base" },
  "modal.docTitle":        { zh: "文档标题", en: "Document Title" },
  "modal.docTitlePlaceholder": { zh: "留空则使用音频文件名", en: "Leave empty to use audio filename" },
  "modal.trDocPlaceholder":{ zh: "翻译文档标题", en: "Translation document title" },
  "modal.importFormat":    { zh: "导入格式", en: "Import Format" },
  "modal.formatTxt":       { zh: "纯文本 (TXT)", en: "Plain Text (TXT)" },
  "modal.formatMd":        { zh: "Markdown (MD)", en: "Markdown (MD)" },
  "modal.isolateMode":     { zh: "隔离模式", en: "Isolation Mode" },
  "modal.global":          { zh: "全局 (global)", en: "Global" },
  "modal.session":         { zh: "会话 (session)", en: "Session" },
  "modal.temp":            { zh: "临时 (temp)", en: "Temp" },
  "modal.targetFolder":    { zh: "目标文件夹", en: "Target Folder" },
  "modal.confirmImport":   { zh: "确认导入", en: "Confirm Import" },
  "modal.importing":       { zh: "导入中...", en: "Importing..." },
  "modal.ttsTitle":        { zh: "语音播放", en: "Voice Playback" },
  "modal.ttsPlay":         { zh: "播放/暂停", en: "Play/Pause" },
  "modal.ttsStop":         { zh: "停止", en: "Stop" },
  "modal.ttsSpeed":        { zh: "语速", en: "Speed" },
  "modal.ttsVoice":        { zh: "音色", en: "Voice" },
  "modal.close":           { zh: "关闭", en: "Close" },
  "modal.folderName":      { zh: "文件夹名称", en: "Folder Name" },

  // 网络锁定
  "overlay.locked":        { zh: "检测到程序异常网络行为，AI 功能已锁定。", en: "Abnormal network activity detected. AI features locked." },

  // Toast 消息
  "toast.copied":          { zh: "已复制到剪贴板", en: "Copied to clipboard" },
  "toast.keyDownloaded":   { zh: "恢复密钥已下载", en: "Recovery key downloaded" },
  "toast.setupDone":       { zh: "安全配置完成", en: "Security setup complete" },
  "toast.recoveryInput":   { zh: "请输入恢复密钥或助记词", en: "Please enter recovery key or mnemonic" },
  "toast.recoveryOk":      { zh: "密钥恢复成功", en: "Key recovery successful" },
  "toast.recoveryFail":    { zh: "恢复失败", en: "Recovery failed" },
  "toast.recoveryErr":     { zh: "恢复请求失败: ", en: "Recovery request failed: " },
  "toast.sessionRenamed":  { zh: "会话已重命名", en: "Session renamed" },
  "toast.renameFailed":    { zh: "重命名失败", en: "Rename failed" },
  "toast.sessionClosed":   { zh: "会话已关闭", en: "Session closed" },
  "toast.sessionCloseFail":{ zh: "关闭会话失败", en: "Failed to close session" },
  "toast.noSession":       { zh: "会话初始化失败，请稍后重试", en: "Session init failed. Please retry." },
  "toast.ttsFail":         { zh: "TTS 播放失败: ", en: "TTS playback failed: " },
  "toast.folderCreated":   { zh: "文件夹「", en: "Folder \"" },
  "toast.folderCreated2":  { zh: "」已创建", en: "\" created" },
  "toast.createFailed":    { zh: "创建失败", en: "Create failed" },
  "toast.folderRenamed":   { zh: "已重命名为「", en: "Renamed to \"" },
  "toast.folderRenamed2":  { zh: "」", en: "\"" },
  "toast.folderDeleted":   { zh: "文件夹已删除", en: "Folder deleted" },
  "toast.deleteFailed":    { zh: "删除失败", en: "Delete failed" },
  "toast.docDownloading":  { zh: "文档下载中...", en: "Downloading document..." },
  "toast.exportFailed":    { zh: "导出失败", en: "Export failed" },
  "toast.exportedAs":      { zh: "已导出为 ", en: "Exported as " },
  "toast.uploadSuccess":   { zh: "文档上传成功，正在创建文档会话...", en: "Upload successful. Creating document session..." },
  "toast.uploadFailed":    { zh: "上传失败", en: "Upload failed" },
  "toast.uploadFailed2":   { zh: "上传失败：", en: "Upload failed: " },
  "toast.sessionCreated":  { zh: "已创建会话「", en: "Session created: \"" },
  "toast.sessionCreated2": { zh: "」并加载文档", en: "\" with loaded document" },
  "toast.fileMoved":       { zh: "文件已移动", en: "File moved" },
  "toast.moveFailed":      { zh: "移动失败", en: "Move failed" },
  "toast.docDeleted":      { zh: "文档已删除", en: "Document deleted" },
  "toast.wavOnly":         { zh: "仅支持标准 WAV 格式音频文件", en: "Only WAV format audio files supported" },
  "toast.wavOnlyShort":    { zh: "仅支持 WAV 格式", en: "WAV format only" },
  "toast.asrSubmitting":   { zh: "ASR 任务投递中...", en: "Submitting ASR task..." },
  "toast.asrSubmitted":    { zh: "ASR 任务已投递", en: "ASR task submitted" },
  "toast.asrSubmitFail":   { zh: "ASR 投递失败", en: "ASR submission failed" },
  "toast.asrException":    { zh: "ASR 投递异常: ", en: "ASR submission error: " },
  "toast.asrDone":         { zh: "ASR 转写完成", en: "ASR transcription complete" },
  "toast.asrTaskFail":     { zh: "ASR 任务失败: ", en: "ASR task failed: " },
  "toast.unknownError":    { zh: "未知错误", en: "Unknown error" },
  "toast.noResultExport":  { zh: "暂无可导出的转写结果", en: "No transcription result to export" },
  "toast.exported":        { zh: "已导出", en: "Exported" },
  "toast.noAsrImport":     { zh: "没有可导入的转写结果", en: "No transcription result to import" },
  "toast.importedKb":      { zh: "已导入知识库 (", en: "Imported to KB (" },
  "toast.importedKb2":     { zh: " 个分片)", en: " chunks)" },
  "toast.importFailed":    { zh: "导入失败", en: "Import failed" },
  "toast.importReqFailed": { zh: "导入请求失败", en: "Import request failed" },
  "toast.translatingTo":   { zh: "正在翻译为 ", en: "Translating to " },
  "toast.translatingTo2":  { zh: "...", en: "..." },
  "toast.translateDone":   { zh: "翻译完成", en: "Translation complete" },
  "toast.translateFailed": { zh: "翻译失败", en: "Translation failed" },
  "toast.translateUnavail":{ zh: "翻译服务不可用", en: "Translation service unavailable" },
  "toast.selectRecord":    { zh: "请先选择翻译记录", en: "Please select a translation record first" },
  "toast.recordNotFound":  { zh: "翻译记录未找到", en: "Translation record not found" },
  "toast.exportedAs2":     { zh: "已导出: ", en: "Exported: " },
  "toast.trImportedKb":    { zh: "翻译结果已导入知识库", en: "Translation result imported to KB" },
  "toast.selectDocs":      { zh: "请先选择文档", en: "Please select documents first" },
  "toast.selectAsrRecords":{ zh: "请先选择转写记录", en: "Please select transcription records first" },
  "toast.docNotFound":     { zh: "文档未找到", en: "Document not found" },
  "toast.isolateChanged":  { zh: "隔离模式已切换为: ", en: "Isolation mode changed to: " },
  "toast.switchFailed":    { zh: "切换失败", en: "Switch failed" },
  "toast.opFailed":        { zh: "操作失败", en: "Operation failed" },
  "toast.batchIsolated":   { zh: " 个文档设为: ", en: " documents set to: " },
  "toast.batchIsolated2":  { zh: "已将 ", en: "" },
  "toast.batchIsolateFail":{ zh: "批量隔离失败", en: "Batch isolate failed" },
  "toast.batchDeleted":    { zh: "已删除 ", en: "Deleted " },
  "toast.batchDeleted2":   { zh: " 个文档", en: " documents" },
  "toast.batchDeleteFail": { zh: "批量删除失败", en: "Batch delete failed" },
  "toast.batchTranslating":{ zh: "正在批量翻译 ", en: "Batch translating " },
  "toast.batchTranslating2":{ zh: " 个文档...", en: " documents..." },
  "toast.batchTrDone":     { zh: "翻译完成，点击翻译页面查看", en: "Translation complete. Check translation page." },
  "toast.batchTrFail":     { zh: "批量翻译失败", en: "Batch translation failed" },
  "toast.batchExportDone": { zh: "批量导出完成", en: "Batch export complete" },
  "toast.batchExportFail": { zh: "批量导出失败", en: "Batch export failed" },
  "toast.batchImportDone": { zh: "导入完成: ", en: "Import complete: " },
  "toast.batchImportOk":   { zh: " 成功, ", en: " success, " },
  "toast.batchImportFail2":{ zh: " 失败", en: " failed" },
  "toast.batchAsrImport":  { zh: "正在批量导入 ", en: "Batch importing " },
  "toast.batchAsrImport2": { zh: " 条记录...", en: " records..." },
  "toast.batchAsrOk":      { zh: "成功导入 ", en: "Successfully imported " },
  "toast.batchAsrOk2":     { zh: " 条到知识库", en: " records to KB" },
  "toast.batchAsrFail":    { zh: "批量导入失败", en: "Batch import failed" },
  "toast.asrDeleted":      { zh: "已删除 ", en: "Deleted " },
  "toast.asrDeleted2":     { zh: " 条记录", en: " records" },
  "toast.asrDeleteFail":   { zh: "批量删除失败", en: "Batch delete failed" },
  "toast.auditExported":   { zh: "已导出 JSON + CSV (", en: "Exported JSON + CSV (" },
  "toast.auditExported2":  { zh: " 条)", en: " records)" },
  "toast.credMissing":     { zh: "凭据丢失，请在设置页导入恢复密钥", en: "Credential missing. Please import recovery key in Settings." },
  "toast.credMissing2":    { zh: "检测到加密凭据丢失！请立即导入恢复密钥", en: "Encryption credential lost! Please import recovery key immediately." },
  "toast.mnemonicSaved":   { zh: "请妥善保管助记词", en: "Please keep the mnemonic safe" },
  "toast.ttsError":        { zh: "语音播放出错: ", en: "Voice playback error: " },
  "toast.ttsNoContent":    { zh: "无法获取文档内容", en: "Cannot fetch document content" },
  "toast.ttsUnavailable":  { zh: "TTS 服务不可用", en: "TTS service unavailable" },
  "toast.exportReqFailed": { zh: "导出请求失败", en: "Export request failed" },

  // Confirm 弹窗消息
  "confirm.closeSessionMsg":  { zh: "关闭此会话将永久删除会话及所有聊天记录。确认？", en: "Closing this session will permanently delete the session and all chat records. Confirm?" },
  "confirm.deleteFolderMsg":  { zh: "删除文件夹后其中的文档不会被删除，仅解除关联。确认？", en: "Deleting this folder will not delete documents inside, only remove the association. Confirm?" },
  "confirm.deleteFolderTitle":{ zh: "删除文件夹", en: "Delete Folder" },
  "confirm.deleteDocTitle":   { zh: "删除文档", en: "Delete Document" },
  "confirm.deleteDocMsg":     { zh: "确认永久删除此文档？此操作不可撤销。", en: "Permanently delete this document? This cannot be undone." },
  "confirm.batchDeleteTitle": { zh: "批量删除", en: "Batch Delete" },
  "confirm.batchDeleteMsg":   { zh: "确定要删除选中的 ", en: "Are you sure you want to delete the selected " },
  "confirm.batchDeleteMsg2":  { zh: " 个文档吗？此操作不可恢复。", en: " documents? This cannot be undone." },
  "confirm.batchAsrDelMsg":   { zh: "确定要删除选中的 ", en: "Are you sure you want to delete the selected " },
  "confirm.batchAsrDelMsg2":  { zh: " 条转写记录吗？此操作不可恢复。", en: " transcription records? This cannot be undone." },
  "confirm.renameFolder":     { zh: "重命名文件夹:", en: "Rename folder:" },

  // 翻译目标语言标签
  "lang.zh": { zh: "中文", en: "Chinese" },
  "lang.en": { zh: "English", en: "English" },
  "lang.ja": { zh: "日本語", en: "Japanese" },
  "lang.ko": { zh: "한국어", en: "Korean" },
  "lang.fr": { zh: "Français", en: "French" },
  "lang.de": { zh: "Deutsch", en: "German" },
  "lang.es": { zh: "Español", en: "Spanish" },

  // 杂项
  "misc.error": { zh: "错误", en: "Error" },
  "misc.connectionError": { zh: "连接错误", en: "Connection error" },
};

function t(key) {
  var entry = I18N[key];
  if (!entry) return key;
  return entry[currentLang] || entry["zh"] || key;
}

function tLang(code) {
  return I18N["lang." + code] ? t("lang." + code) : code;
}

function applyLanguage(lang) {
  currentLang = lang;
  localStorage.setItem("qvac_lang", lang);
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";

  // 更新所有 [data-i18n] 元素的 textContent
  document.querySelectorAll("[data-i18n]").forEach(function (el) {
    var key = el.getAttribute("data-i18n");
    el.textContent = t(key);
  });

  // 更新 placeholder 属性
  document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
    var key = el.getAttribute("data-i18n-placeholder");
    el.placeholder = t(key);
  });

  // 更新 title 属性
  document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
    var key = el.getAttribute("data-i18n-title");
    el.title = t(key);
  });

  // 更新语言选择器
  var langSel = document.getElementById("setting-lang-select");
  if (langSel) langSel.value = lang;

  // 刷新动态内容
  updateNavStatus();
  refreshCurrentPageTexts();
}

function refreshCurrentPageTexts() {
  var activePage = document.querySelector(".page.active");
  if (!activePage) return;
  if (activePage.id === "page-knowledge") { loadFolderTree().then(function () { loadKnowledgeList(); }); }
  if (activePage.id === "page-asr") { loadASRArchives(); }
  if (activePage.id === "page-translate") { loadTranslateHistory(); }
  if (activePage.id === "page-chat") { renderSessionList(); }
}

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
  yesBtn.textContent = t("modal.confirming") + count + "s)";
  var timer = setInterval(function () {
    count--;
    if (count <= 0) {
      clearInterval(timer);
      yesBtn.disabled = false;
      yesBtn.textContent = t("modal.confirmDone");
    } else {
      yesBtn.textContent = t("modal.confirming") + count + "s)";
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
    yesBtn.textContent = t("modal.processing");
    var result = onConfirm();
    if (result && typeof result.then === "function") {
      result.catch(function () {}).finally(function () {
        yesBtn.disabled = false;
        yesBtn.textContent = t("modal.confirmDone");
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
        statusBadge.textContent = t("app.ready");
        statusBadge.className = "badge badge-idle";
        connectionDot.className = "dot dot-connected";
        footerStatus.textContent = t("app.connected");
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
  statusBadge.textContent = t("app.offline");
  statusBadge.className = "badge badge-error";
  connectionDot.className = "dot dot-disconnected";
  footerStatus.textContent = t("app.disconnected");
  sendBtn.disabled = true;
  chatInput.disabled = true;
}

function updateNavStatus() {
  statusBadge.textContent = connected ? t("app.ready") : t("app.offline");
  statusBadge.className = connected ? "badge badge-idle" : "badge badge-error";
  footerStatus.textContent = connected ? t("app.connected") : t("app.disconnected");
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
    navigator.clipboard.writeText(hex).then(function () { showToast(t("toast.copied"), "success"); });
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
    showToast(t("toast.keyDownloaded"), "success");
  };
  document.getElementById("setup-done-btn").onclick = function () {
    localStorage.setItem("qvac_key_exported", "1");
    document.getElementById("setup-modal").classList.add("hidden");
    showToast(t("toast.setupDone"), "success");
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
  if (!key) { showToast(t("toast.recoveryInput"), "error"); return; }
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/system/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_version: "v1", recovery_key: key }),
    });
    var data = await resp.json();
    if (data.code === 100) {
      showToast(t("toast.recoveryOk"), "success");
      credModal.classList.add("hidden");
      loadSystemState();
    } else {
      showToast(data.message || t("toast.recoveryFail"), "error");
    }
  } catch (err) {
    showToast(t("toast.recoveryErr") + err.message, "error");
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
        list.innerHTML = '<div style="color:var(--text-secondary);padding:8px 12px;font-size:12px">' + t("chat.noDocs") + '</div>';
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
          (sel ? ICONS.check : "") + escapeHtml(doc.file_name) +
          '<span style="color:var(--text-secondary);font-size:10px;margin-left:auto">' + (doc.total_pages || 0) + t("chat.chunks") + '</span></div>';
      }).join("");
    })
    .catch(function () {
      list.innerHTML = '<div style="color:var(--error);padding:8px 12px;font-size:12px">' + t("chat.loadFailed") + '</div>';
    });
}

function renderDocTags() {
  var tags = document.getElementById("chat-docs-tags");
  if (!tags) return;
  if (selectedDocIds.length === 0) {
    tags.innerHTML = '<span style="color:var(--text-secondary);font-size:11px">' + t("chat.noDocSelected") + '</span>';
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
      body: JSON.stringify({ api_version: "v1", title: t("nav.newSessionTitle") }),
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
  chatMessages.innerHTML = '<div class="chat-placeholder"><div class="placeholder-icon"><svg viewBox="0 0 24 24" width="48" height="48"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" opacity="0.3"/></svg></div><p>' + t("chat.emptyTitle") + '</p><p class="sub-text">' + t("chat.emptySub") + '</p></div>';
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
    title.textContent = s.title || t("chat.sessionDefault");
    title.title = t("chat.dblClickRename");
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
    closeBtn.title = t("chat.closeSession");
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
        showToast(t("toast.sessionRenamed"), "success");
      }).catch(function () {
        titleEl.textContent = oldTitle;
        showToast(t("toast.renameFailed"), "error");
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
  showConfirm(t("chat.closeSession"), t("confirm.closeSessionMsg"), async function () {
    var ok = false;
    try {
      var resp = await fetch(BACKEND_URL + "/api/v1/chat/session/close?session_id=" + sessionId, { method: "POST" });
      var data = await resp.json();
      ok = data.code === 100;
    } catch (_) {}
    if (!ok) { showToast(t("toast.sessionCloseFail"), "error"); return; }
    if (sessionId === currentSessionId) {
      currentSessionId = null;
      chatMessages.innerHTML = '<div class="chat-placeholder"><div class="placeholder-icon"><svg viewBox="0 0 24 24" width="48" height="48"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" opacity="0.3"/></svg></div><p>' + t("chat.emptyTitle") + '</p><p class="sub-text">' + t("chat.emptySub") + '</p></div>';
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
    showToast(t("toast.sessionClosed"), "success");
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
    if (!currentSessionId) { showToast(t("toast.noSession"), "error"); return; }
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
            contentEl.textContent = "[" + t("misc.error") + "] " + chunk.error;
            contentEl.classList.remove("streaming");
            break;
          }
          if (chunk.done) {
            fullText = chunk.full_text || fullText;
            contentEl.textContent = fullText;
            if (chunk.memory_truncated) {
              var tag = document.createElement("span");
              tag.className = "truncation-tag";
              tag.textContent = t("chat.truncatedTag");
              contentEl.appendChild(tag);
            }
            contentEl.classList.remove("streaming");
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
      contentEl.textContent = fullText || t("chat.emptyResponse");
    }
  } catch (err) {
    assistantBubble.querySelector(".message-content").textContent = "[" + t("misc.connectionError") + "] " + err.message;
    assistantBubble.querySelector(".message-content").classList.remove("streaming");
  }

  currentStreaming = false;
  chatInput.disabled = false;
  sendBtn.disabled = false;
  chatInput.focus();
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ---- TTS 控制 ----
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
  roleLabel.textContent = role === "user" ? t("chat.userRole") : t("chat.assistantRole");

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
      '<span class="folder-icon">' + ICONS.folder + '</span><span class="folder-item-name">' + t("kb.allDocs") + '</span></div>';
    folders.forEach(function (f) {
      html += '<div class="folder-item' + (currentFolderId === f.folder_id ? " active" : "") + '" data-folder-id="' + f.folder_id + '" onclick="selectFolder(\'' + f.folder_id + '\')">' +
        '<span class="folder-icon">' + ICONS.folder + '</span>' +
        '<span class="folder-item-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</span>' +
        '<span class="folder-item-actions">' +
          '<button title="' + t("kb.rename") + '" onclick="event.stopPropagation();renameFolderPrompt(\'' + f.folder_id + '\',\'' + escapeHtml(f.name) + '\')">✎</button>' +
          '<button title="' + t("kb.delete") + '" onclick="event.stopPropagation();deleteFolderConfirm(\'' + f.folder_id + '\')">✕</button>' +
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
  var opts = '<option value="">' + t("kb.root") + '</option>';
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
  input.placeholder = t("modal.folderName");
  input.maxLength = 64;
  input.style.cssText = "flex:1;background:var(--bg-tertiary);border:1px solid var(--accent);border-radius:3px;color:var(--text-primary);padding:4px 8px;font-size:12px;outline:none";
  var confirmBtn = document.createElement("button");
  confirmBtn.innerHTML = ICONS.check;
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
        showToast(t("toast.folderCreated") + name + t("toast.folderCreated2"), "success");
        loadFolderTree();
      } else {
        showToast(data.message || t("toast.createFailed"), "error");
      }
    }).catch(function () { showToast(t("toast.createFailed"), "error"); });
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
  var name = prompt(t("confirm.renameFolder"), oldName);
  if (!name || !name.trim() || name.trim() === oldName) return;
  name = name.trim();
  fetch(BACKEND_URL + "/api/v1/knowledge/folders/" + folderId + "?name=" + encodeURIComponent(name), {
    method: "PUT",
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (data.code === 100) {
      showToast(t("toast.folderRenamed") + name + t("toast.folderRenamed2"), "success");
      loadFolderTree();
    } else {
      showToast(data.message || t("toast.renameFailed"), "error");
    }
  }).catch(function () { showToast(t("toast.renameFailed"), "error"); });
}

function deleteFolderConfirm(folderId) {
  showConfirm(t("confirm.deleteFolderTitle"), t("confirm.deleteFolderMsg"), async function () {
    try {
      var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/folders/" + folderId, { method: "DELETE" });
      var data = await resp.json();
      if (data.code === 100) {
        showToast(t("toast.folderDeleted"), "success");
        if (currentFolderId === folderId) { currentFolderId = ""; }
        loadFolderTree();
        loadKnowledgeList();
      } else {
        showToast(data.message || t("toast.deleteFailed"), "error");
      }
    } catch (_) { showToast(t("toast.deleteFailed"), "error"); }
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
      container.innerHTML = '<p class="empty-state">' + t("kb.emptyState") + '</p>';
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
              '<span class="version-group-meta">' + t("kb.versions") + g.length + t("kb.versionsSuffix") + '</span>' +
            '</div>' +
            '<span style="font-size:11px;color:var(--text-secondary)">' + t("kb.expand") + '</span>' +
          '</div>' +
          '<div class="version-list" style="display:none" id="vg-list-' + gidSafe + '">' +
            g.map(function (v) {
              var vid = v.file_id.replace(/[^a-zA-Z0-9_-]/g, "");
              return '<div class="version-item">' +
                '<input type="checkbox" class="kb-check" id="ck-' + vid + '" data-file-id="' + v.file_id + '" onchange="updateKBBatchCount()" />' +
                '<div class="version-item-info">' +
                  '<span class="version-badge" style="opacity:' + (v.version === latest.version ? '1' : '0.6') + '">v' + v.version + '</span>' +
                  '<span class="version-item-time">' + (v.create_time || "") + '</span>' +
                  '<span style="font-size:11px;color:var(--text-secondary)">' + formatSize(v.file_size) + ' · ' + v.total_pages + t("kb.pageSize") + '</span>' +
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

    container.innerHTML = html || '<p class="empty-state">' + t("kb.emptyState") + '</p>';
  } catch (_) {
    container.innerHTML = '<p class="empty-state">' + t("kb.dataError") + '</p>';
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
        '<span>' + f.total_pages + t("kb.pageSize") + '</span>' +
        '<span class="kb-isolate-toggle" title="' + t("kb.clickSwitchMode") + '" onclick="event.stopPropagation();changeIsolate(\'' + f.file_id + '\')">' +
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
  var folderOpts = '<option value="">' + t("kb.moveToFolder") + '</option>';
  folderList.forEach(function (fl) {
    var sel = (f.folder_id === fl.folder_id) ? " selected" : "";
    folderOpts += '<option value="' + fl.folder_id + '"' + sel + '>' + escapeHtml(fl.name) + '</option>';
  });
  return '<button class="btn btn-tiny" onclick="downloadDocument(\'' + f.file_id + '\')" title="' + t("kb.downloadTitle") + '">' + t("kb.download") + '</button>' +
    '<select class="export-select" onchange="exportDocument(\'' + f.file_id + '\',this.value);this.value=\'\'">' +
      '<option value="">' + t("kb.export") + '</option>' +
      '<option value="txt">TXT</option>' +
      '<option value="md">MD</option>' +
      '<option value="docx">DOCX</option>' +
    '</select>' +
    '<select class="export-select" onchange="moveFileToFolder(\'' + f.file_id + '\',this.value)">' +
      folderOpts +
    '</select>' +
    '<button class="btn btn-tiny btn-primary" onclick="translateDocument(\'' + f.file_id + '\',\'' + escapeHtml(f.file_name).replace(/'/g, "\\'") + '\')" title="' + t("kb.translateTitle") + '">' + t("kb.translateBtn") + '</button>' +
    '<button class="btn btn-tiny btn-danger" onclick="deleteKnowledge(\'' + f.file_id + '\')">' + t("kb.delete") + '</button>';
}

function toggleVersionGroup(gid) {
  var list = document.getElementById("vg-list-" + gid);
  if (!list) return;
  if (list.style.display === "none") {
    list.style.display = "block";
    var header = list.previousElementSibling;
    if (header) header.querySelector("span:last-child").textContent = t("kb.collapse");
  } else {
    list.style.display = "none";
    var header = list.previousElementSibling;
    if (header) header.querySelector("span:last-child").textContent = t("kb.expand");
  }
}

function downloadDocument(fileId) {
  var a = document.createElement("a");
  a.href = BACKEND_URL + "/api/v1/knowledge/download/" + fileId;
  a.download = "";
  a.click();
  showToast(t("toast.docDownloading"), "success");
}

async function exportDocument(fileId, format) {
  if (!format) return;
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, format: format }),
    });
    if (!resp.ok) { showToast(t("toast.exportFailed"), "error"); return; }
    var blob = await resp.blob();
    var disposition = resp.headers.get("Content-Disposition") || "";
    var fname = disposition.match(/filename="?(.+?)"?($|;)/);
    var filename = fname ? fname[1] : "export." + format;
    downloadBlob(blob, filename);
    showToast(t("toast.exportedAs") + filename, "success");
  } catch (_) { showToast(t("toast.exportFailed"), "error"); }
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
  uploadBtn.textContent = t("kb.uploading");

  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/upload", {
      method: "POST",
      body: formData,
    });
    var data = await resp.json();
    if (data.code === 100) {
      var fileId = data.data ? data.data.file_id : null;
      var docName = file.name.replace(/\.[^.]+$/, "");
      showToast(t("toast.uploadSuccess"), "success");

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
            chatMessages.innerHTML = '<div class="chat-placeholder"><div class="placeholder-icon"><svg viewBox="0 0 24 24" width="48" height="48"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="currentColor" opacity="0.3"/></svg></div><p>' + t("chat.loadedDoc") + escapeHtml(docName) + '</p><p class="sub-text">' + t("chat.loadedDocSub") + '</p></div>';
            showToast(t("toast.sessionCreated") + docName + t("toast.sessionCreated2"), "success");
          }
        } catch (_) {}
      }
      loadKnowledgeList();
      loadFolderTree();
    } else {
      showToast(data.message || t("toast.uploadFailed"), "error");
    }
  } catch (err) {
    showToast(t("toast.uploadFailed2") + err.message, "error");
  }

  uploadBtn.disabled = false;
  uploadBtn.textContent = t("kb.upload");
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
      showToast(t("toast.fileMoved"), "success");
      loadKnowledgeList();
      loadFolderTree();
    } else {
      showToast(data.message || t("toast.moveFailed"), "error");
    }
  } catch (_) { showToast(t("toast.moveFailed"), "error"); }
}

async function deleteKnowledge(fileId) {
  showConfirm(t("confirm.deleteDocTitle"), t("confirm.deleteDocMsg"), async function () {
    try {
      await fetch(BACKEND_URL + "/api/v1/knowledge/delete?file_id=" + fileId, { method: "DELETE" });
      loadKnowledgeList();
      loadFolderTree();
      showToast(t("toast.docDeleted"), "success");
    } catch (_) {
      showToast(t("toast.deleteFailed"), "error");
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
    showToast(t("toast.wavOnly"), "error");
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
    if (ext !== "wav") { showToast(t("toast.wavOnlyShort"), "error"); return; }
    submitASRTask(file);
  }
});

async function submitASRTask(file) {
  showToast(t("toast.asrSubmitting"), "");

  // 优先使用 Electron 本地路径直传 (更快，免上传)
  if (window.qvacAPI && file.path) {
    try {
      var resp = await window.qvacAPI.submitASR(file.path);
      if (resp.code === 160) {
        showToast(t("toast.asrSubmitted"), "success");
        startASRPolling(resp.data.task_id);
        return;
      } else {
        showToast(resp.message || t("toast.asrSubmitFail"), "error");
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
      showToast(t("toast.asrSubmitted"), "success");
      startASRPolling(uploadData.data.task_id);
    } else {
      showToast(uploadData.message || t("toast.asrSubmitFail"), "error");
    }
  } catch (err) {
    showToast(t("toast.asrException") + err.message, "error");
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
        document.getElementById("asr-remaining-text").textContent = t("asr.remaining") + (data.data.remaining_time_s || 0).toFixed(0) + "s";
      } else if (data.code === 100) {
        clearInterval(asrPollTimer);
        asrPollTimer = null;
        document.getElementById("asr-progress-bar").style.width = "100%";
        document.getElementById("asr-progress-text").textContent = "100%";
        document.getElementById("asr-remaining-text").textContent = t("asr.done");
        document.getElementById("asr-task-status").textContent = t("asr.completed");
        document.getElementById("asr-task-status").className = "badge badge-idle";

        // 显示结果
        var resultPanel = document.getElementById("asr-result-panel");
        resultPanel.classList.remove("hidden");
        document.getElementById("asr-result-duration").textContent =
          t("asr.duration") + (data.data.duration || 0).toFixed(1) + "s";
        var transcribedText = data.data.transcribed_text || t("asr.empty");
        document.getElementById("asr-result-text").textContent = transcribedText;
        // 保存结果供导出和导入
        window._lastASRText = transcribedText;
        window._lastASRAudioName = data.data.audio_name || "transcription";
        window._lastASRArchiveId = data.data.archive_id;  // for import-to-kb

        loadASRArchives();
        showToast(t("toast.asrDone"), "success");
      } else if (data.code === 500) {
        clearInterval(asrPollTimer);
        asrPollTimer = null;
        showToast(t("toast.asrTaskFail") + (data.message || t("toast.unknownError")), "error");
      }
    } catch (_) {}
  }, 2000);
}

async function exportASRResult() {
  var archiveId = window._lastASRArchiveId;
  if (!archiveId) {
    // 降级：无 archive_id 时用前端文本通过 Blob 导出
    var text = window._lastASRText || "";
    if (!text || text === "(空)") { showToast(t("toast.noResultExport"), "warn"); return; }
    var name = (window._lastASRAudioName || "transcription").replace(/\.[^.]+$/, "");
    var format = document.getElementById("asr-export-format").value;
    var mime = format === "md" ? "text/markdown" : "text/plain;charset=utf-8";
    var blob = new Blob([text], { type: mime });
    downloadBlob(blob, name + "." + format);
    showToast(t("toast.exported"), "success");
    return;
  }
  var format = document.getElementById("asr-export-format").value;
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/asr/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archive_id: archiveId, format: format }),
    });
    if (!resp.ok) { showToast(t("toast.exportFailed"), "error"); return; }
    var blob = await resp.blob();
    var disposition = resp.headers.get("Content-Disposition") || "";
    var fname = disposition.match(/filename="?(.+?)"?($|;)/);
    var filename = fname ? fname[1] : "transcription." + format;
    downloadBlob(blob, filename);
    showToast(t("toast.exportedAs") + filename, "success");
  } catch (_) { showToast(t("toast.exportFailed"), "error"); }
}

async function loadASRArchives() {
  var container = document.getElementById("asr-archive-list");
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/asr/list");
    var data = await resp.json();
    if (!data.data || data.data.length === 0) {
      container.innerHTML = '<p class="empty-state">' + t("asr.archiveEmpty") + '</p>';
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
            '<option value="">' + t("kb.export") + '</option>' +
            '<option value="txt">TXT</option>' +
            '<option value="md">MD</option>' +
            '<option value="docx">DOCX</option>' +
          '</select>' +
          '<button class="btn btn-tiny btn-primary" onclick="showASRImportDialog(\'' + aid + '\',\'' + escapeHtml(a.audio_name).replace(/'/g, "\\'") + '\')">' + t("asr.importKbBtn") + '</button>' +
        '</div>' +
      '</div>';
    }).join("");
  } catch (_) {
    container.innerHTML = '<p class="empty-state">' + t("asr.archiveError") + '</p>';
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
    if (!resp.ok) { showToast(t("toast.exportFailed"), "error"); return; }
    var blob = await resp.blob();
    var disposition = resp.headers.get("Content-Disposition") || "";
    var fname = disposition.match(/filename="?(.+?)"?($|;)/);
    var filename = fname ? fname[1] : "transcription." + format;
    downloadBlob(blob, filename);
    showToast(t("toast.exportedAs") + filename, "success");
  } catch (_) { showToast(t("toast.exportFailed"), "error"); }
}

// ---- ASR 导入知识库弹窗 ----
var currentImportArchiveId = null;

function showASRImportDialog(archiveId, audioName) {
  // 如果从历史记录调用，使用传入的 archiveId；否则用当前结果
  currentImportArchiveId = archiveId || window._lastASRArchiveId || null;
  if (!currentImportArchiveId) { showToast(t("toast.noAsrImport"), "warn"); return; }

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
  submitBtn.textContent = t("modal.importing");

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
      showToast(t("toast.importedKb") + (data.data && data.data.chunk_count || 0) + t("toast.importedKb2"), "success");
      document.getElementById("asr-import-modal").classList.add("hidden");
      loadFolderTree();
      loadKnowledgeList();
    } else {
      showToast(data.message || t("toast.importFailed"), "error");
    }
  } catch (_) {
    showToast(t("toast.importReqFailed"), "error");
  }
  submitBtn.disabled = false;
  submitBtn.textContent = t("modal.confirmImport");
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
      '<tr><td colspan="4" class="empty-state">' + t("audit.noConnection") + '</td></tr>';
  }
}

function renderAuditTable(logs) {
  var tbody = document.getElementById("audit-tbody");
  if (!logs || logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">' + t("audit.noData") + '</td></tr>';
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
    div.innerHTML = '<span>' + t("audit.total") + total + t("audit.records") + '</span>';
    return;
  }
  div.innerHTML =
    '<span>' + t("audit.total") + total + t("audit.records") + t("audit.pageInfo") + totalPages + t("audit.pages") + '</span>' +
    '<button class="btn btn-small" ' + (page <= 1 ? "disabled" : "") + ' onclick="loadAuditLogs(' + (page - 1) + ')">' + t("audit.prev") + '</button>' +
    '<button class="btn btn-small" ' + (page >= totalPages ? "disabled" : "") + ' onclick="loadAuditLogs(' + (page + 1) + ')">' + t("audit.next") + '</button>';
}

document.getElementById("export-logs-btn").addEventListener("click", async function () {
  var btn = document.getElementById("export-logs-btn");
  btn.disabled = true;
  btn.textContent = t("audit.exporting");

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

    showToast(t("toast.auditExported") + logs.length + t("toast.auditExported2"), "success");
  } catch (_) {
    showToast(t("toast.exportFailed"), "error");
  }

  btn.disabled = false;
  btn.textContent = t("audit.exportBtn");
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
    document.getElementById("state-workers").textContent = (data.active_workers || []).join(", ") || t("settings.none");

    // Kill Switch
    document.getElementById("state-ks").textContent = data.master_state === 999 ? t("settings.locked") : t("settings.normal");
    document.getElementById("state-ks").style.color = data.master_state === 999 ? "var(--error)" : "var(--success)";
  } catch (_) {}

  // 凭据状态
  try {
    var credResp = await fetch(BACKEND_URL + "/api/v1/system/credential/status");
    var credData = await credResp.json();
    if (credData.data) {
      document.getElementById("sec-cred").textContent = credData.data.credential_present ? t("settings.managed") : t("settings.missing");
      document.getElementById("sec-cred").style.color = credData.data.credential_present ? "var(--success)" : "var(--error)";
      document.getElementById("sec-enc").textContent = credData.data.credential_present ? t("settings.aes256") : t("settings.plaintext");
      document.getElementById("sec-enc").style.color = credData.data.credential_present ? "var(--success)" : "var(--warning)";

      if (!credData.data.credential_present) {
        showToast(t("toast.credMissing"), "error");
      }
    }
  } catch (_) {}

  // 硬件信息 — 直读实时采样端点
  try {
    var hwResp = await fetch(BACKEND_URL + "/api/v1/system/hardware");
    var hwData = await hwResp.json();
    if (hwData.data) {
      var d = hwData.data;
      var gpuUsed = d.gpu_memory_used_mb;
      var gpuTotal = d.gpu_memory_total_mb;
      if (gpuTotal !== undefined && gpuTotal > 0) {
        document.getElementById("hw-gpu").textContent = (gpuUsed || 0) + " / " + gpuTotal + " MB";
      } else if (gpuUsed !== undefined) {
        document.getElementById("hw-gpu").textContent = gpuUsed + " MB";
      }
      var cpuVal = d.cpu_utilization_percent;
      if (cpuVal !== undefined && cpuVal !== null) {
        document.getElementById("hw-cpu").textContent = Math.round(cpuVal) + "%";
      }
      var ramUsed = d.ram_used_mb;
      var ramTotal = d.ram_total_mb;
      if (ramTotal !== undefined && ramTotal > 0) {
        document.getElementById("hw-ram").textContent = Math.round(ramUsed || 0) + " / " + ramTotal + " MB";
      } else if (ramUsed !== undefined) {
        document.getElementById("hw-ram").textContent = Math.round(ramUsed) + " MB";
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
      showToast(data.message || t("toast.exportFailed"), "error");
    }
  } catch (_) {
    showToast(t("toast.exportReqFailed"), "error");
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
        showToast(t("toast.mnemonicSaved"), "warn");
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
      overlayText.textContent = t("overlay.locked");
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
        showToast(t("toast.credMissing2"), "error");
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
  document.getElementById("kb-batch-count").textContent = t("kb.selected") + count + t("kb.selectedItems");
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
    if (!file) { showToast(t("toast.docNotFound"), "error"); return; }
    var curMode = file.isolate_mode;
    var nextIdx = (modes.indexOf(curMode) + 1) % modes.length;
    var nextMode = modes[nextIdx];

    var putResp = await fetch(BACKEND_URL + "/api/v1/knowledge/files/isolate", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, isolate_mode: nextMode, session_id: currentSessionId }),
    });
    if (putResp.ok) {
      showToast(t("toast.isolateChanged") + nextMode, "success");
      loadKnowledgeList();
    } else {
      showToast(t("toast.switchFailed"), "error");
    }
  } catch (_) { showToast(t("toast.opFailed"), "error"); }
}

async function batchIsolate(mode) {
  if (!mode) return;
  var checks = document.querySelectorAll("#knowledge-list .kb-check:checked");
  var fileIds = [];
  checks.forEach(function (c) { fileIds.push(c.dataset.fileId); });
  if (fileIds.length === 0) { showToast(t("toast.selectDocs"), "warn"); return; }
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/batch/isolate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_ids: fileIds, isolate_mode: mode, session_id: currentSessionId }),
    });
    if (resp.ok) {
      showToast(t("toast.batchIsolated2") + fileIds.length + t("toast.batchIsolated") + mode, "success");
      loadKnowledgeList();
    }
  } catch (_) { showToast(t("toast.batchIsolateFail"), "error"); }
}

async function batchKnowledgeAction(action) {
  var checks = document.querySelectorAll("#knowledge-list .kb-check:checked");
  var fileIds = [];
  checks.forEach(function (c) { fileIds.push(c.dataset.fileId); });
  if (fileIds.length === 0) { showToast(t("toast.selectDocs"), "warn"); return; }

  if (action === "delete") {
    showConfirm(t("confirm.batchDeleteTitle"), t("confirm.batchDeleteMsg") + fileIds.length + t("confirm.batchDeleteMsg2"), async function () {
      try {
        var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/batch/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_ids: fileIds }),
        });
        var data = await resp.json();
        showToast(t("toast.batchDeleted") + (data.data ? data.data.deleted_count : 0) + t("toast.batchDeleted2"), "success");
        loadKnowledgeList();
      } catch (_) { showToast(t("toast.batchDeleteFail"), "error"); }
    });
  } else if (action === "translate") {
    var targetLang2 = document.getElementById("tr-target-lang-select").value || "zh";
    showToast(t("toast.batchTranslating") + fileIds.length + t("toast.batchTranslating2"), "success");
    try {
      var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/batch/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: fileIds, source_lang: "auto", target_lang: targetLang2 }),
      });
      var data = await resp.json();
      if (data.data && data.data.results) {
        // 存储到翻译历史
        data.data.results.forEach(function (r) {
          if (r.status === "ok") {
            addTranslateHistory(r.file_id, "", r.translated_text);
          }
        });
        showToast(t("toast.batchTrDone"), "success");
        // 跳转到翻译页
        document.querySelector(".nav-item[data-page=translate]").click();
      }
    } catch (_) { showToast(t("toast.batchTrFail"), "error"); }
  } else if (action === "export") {
    var format = document.getElementById("kb-batch-format") ? document.getElementById("kb-batch-format").value : "txt";
    try {
      var resp2 = await fetch(BACKEND_URL + "/api/v1/knowledge/batch/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: fileIds, format: format }),
      });
      if (resp2.ok) {
        var blob = await resp2.blob();
        downloadBlob(blob, "knowledge_batch_export.zip");
        showToast(t("toast.batchExportDone"), "success");
      } else {
        var errData = await resp2.json();
        showToast(errData.message || t("toast.batchExportFail"), "error");
      }
    } catch (_) { showToast(t("toast.batchExportFail"), "error"); }
  }
}

// ---- 知识库批量导入（本地文件） ----
async function batchImportFiles(input) {
  var files = input.files;
  if (!files || files.length === 0) return;
  var isolateMode = "session";
  var folderId = document.getElementById("kb-folder-select").value;
  var uploaded = 0;
  var failed = 0;

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var formData = new FormData();
    formData.append("file", file);
    formData.append("isolate_mode", isolateMode);
    formData.append("session_id", currentSessionId || "");
    if (folderId) formData.append("folder_id", folderId);

    try {
      var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/upload", {
        method: "POST",
        body: formData,
      });
      var data = await resp.json();
      if (data.code === 100) { uploaded++; }
      else { failed++; }
    } catch (_) { failed++; }
  }

  showToast(t("toast.batchImportDone") + uploaded + t("toast.batchImportOk") + failed + t("toast.batchImportFail2"), uploaded > 0 ? "success" : "error");
  loadKnowledgeList();
  loadFolderTree();
  input.value = "";
}

// ---- 翻译 ----

var translateHistory = [];
var currentTranslateFileId = null;
var currentOriginalText = "";

function addTranslateHistory(fileId, fileName, translatedText, originalText) {
  // 去重
  translateHistory = translateHistory.filter(function (h) { return h.file_id !== fileId; });
  translateHistory.unshift({
    file_id: fileId,
    file_name: fileName,
    translated_text: translatedText,
    original_text: originalText || "",
    time: new Date().toISOString(),
  });
  // 最多保留 50 条
  if (translateHistory.length > 50) translateHistory.pop();
}

async function translateDocument(fileId, fileName, silent) {
  var targetLang = document.getElementById("tr-target-lang-select").value || "zh";
  if (!silent) showToast(t("toast.translatingTo") + tLang(targetLang) + t("toast.translatingTo2"), "success");
  showTranslateProgress(targetLang);
  try {
    var resp = await fetch(BACKEND_URL + "/api/v1/knowledge/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, source_lang: "auto", target_lang: targetLang }),
    });
    var data = await resp.json();
    if (data.code === 100 && data.data) {
      addTranslateHistory(fileId, fileName || data.data.file_name, data.data.translated_text, data.data.original_text);
      currentTranslateFileId = fileId;
      currentOriginalText = data.data.original_text;
      // 更新翻译视窗
      document.getElementById("tr-source-text").textContent = data.data.original_text;
      document.getElementById("tr-target-text").textContent = data.data.translated_text;
      document.getElementById("tr-source-name").textContent = data.data.file_name;
      // 同步语言选择器显示
      document.getElementById("tr-target-lang-select").value = targetLang;
      if (!silent) {
        showToast(t("toast.translateDone"), "success");
        document.querySelector(".nav-item[data-page=translate]").click();
      }
      loadTranslateHistory();
    } else {
      showToast(data.message || t("toast.translateFailed"), "error");
    }
  } catch (_) { showToast(t("toast.translateUnavail"), "error"); }
  hideTranslateProgress();
}

function showTranslateProgress(targetLang) {
  var modal = document.getElementById("tr-progress-modal");
  var title = document.getElementById("tr-progress-title");
  var hint = document.getElementById("tr-progress-hint");
  if (title) title.textContent = t("toast.translatingTo") + tLang(targetLang) + t("toast.translatingTo2");
  if (hint) hint.textContent = t("tr.progressHint");
  if (modal) modal.classList.remove("hidden");
}

function hideTranslateProgress() {
  var modal = document.getElementById("tr-progress-modal");
  if (modal) modal.classList.add("hidden");
}

// 目标语言切换时自动重新翻译
document.getElementById("tr-target-lang-select").addEventListener("change", function () {
  if (currentTranslateFileId) {
    translateDocument(currentTranslateFileId, "", true);
  }
});

function loadTranslateHistory() {
  var container = document.getElementById("tr-history-list");
  if (translateHistory.length === 0) {
    container.innerHTML = '<p class="empty-state">' + t("tr.historyEmpty") + '</p>';
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
  currentOriginalText = h.original_text || "";
  document.getElementById("tr-source-text").textContent = h.original_text || t("tr.origNotSaved");
  document.getElementById("tr-target-text").textContent = h.translated_text;
  document.getElementById("tr-source-name").textContent = h.file_name;
  loadTranslateHistory();
}

function exportTranslation() {
  if (!currentTranslateFileId) { showToast(t("toast.selectRecord"), "warn"); return; }
  var h = translateHistory.find(function (x) { return x.file_id === currentTranslateFileId; });
  if (!h) { showToast(t("toast.recordNotFound"), "error"); return; }

  var format = document.getElementById("tr-export-format").value;
  var content = h.translated_text;
  var filename = (h.file_name || "translation") + "_zh." + format;
  var mime = "text/plain";

  if (format === "md") {
    mime = "text/markdown";
    content = "# " + (h.file_name || t("kb.translateBtn")) + "\n\n" + content;
  } else if (format === "docx") {
    showToast(t("tr.exportDocxWarn"), "warn");
    return;
  }

  var blob = new Blob([content], { type: mime });
  downloadBlob(blob, filename);
  showToast(t("toast.exportedAs2") + filename, "success");
}

async function importTranslationToKB() {
  if (!currentTranslateFileId) { showToast(t("toast.selectRecord"), "warn"); return; }
  var h = translateHistory.find(function (x) { return x.file_id === currentTranslateFileId; });
  if (!h) { showToast(t("toast.recordNotFound"), "error"); return; }

  document.getElementById("tr-import-title").value = (h.file_name || "translation") + "_" + tLang("zh");
  // 填充文件夹选择
  var folderSelect = document.getElementById("tr-import-folder");
  folderSelect.innerHTML = '<option value="">' + t("kb.root") + '</option>';
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
    submitBtn.textContent = t("modal.importing");
    var title = document.getElementById("tr-import-title").value.trim() || (h.file_name + "_" + tLang("zh"));
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
        showToast(t("toast.trImportedKb"), "success");
        modal.classList.add("hidden");
        cleanup();
      } else {
        showToast(data.message || t("toast.importFailed"), "error");
        submitBtn.disabled = false;
        submitBtn.textContent = t("modal.confirmImport");
      }
    } catch (_) {
      showToast(t("toast.importFailed"), "error");
      submitBtn.disabled = false;
      submitBtn.textContent = t("modal.confirmImport");
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
  document.getElementById("asr-batch-count").textContent = t("kb.selected") + count + t("kb.selectedItems");
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
  if (ids.length === 0) { showToast(t("toast.selectAsrRecords"), "warn"); return; }

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
        showToast(t("toast.batchExportDone"), "success");
      } else {
        showToast(t("toast.batchExportFail"), "error");
      }
    } catch (_) { showToast(t("toast.batchExportFail"), "error"); }
  } else if (action === "import-kb") {
    var format2 = document.getElementById("asr-batch-format").value;
    showToast(t("toast.batchAsrImport") + ids.length + t("toast.batchAsrImport2"), "success");
    try {
      var resp2 = await fetch(BACKEND_URL + "/api/v1/asr/batch/import-to-kb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archive_ids: ids, format: format2, isolate_mode: "global", session_id: currentSessionId }),
      });
      var data2 = await resp2.json();
      var okCount = (data2.data ? data2.data.results || [] : []).filter(function (r) { return r.status === "ok"; }).length;
      showToast(t("toast.batchAsrOk") + okCount + " / " + ids.length + t("toast.batchAsrOk2"), "success");
      loadFolderTree();
    } catch (_) { showToast(t("toast.batchAsrFail"), "error"); }
  } else if (action === "delete") {
    showConfirm(t("confirm.batchDeleteTitle"), t("confirm.batchAsrDelMsg") + ids.length + t("confirm.batchAsrDelMsg2"), async function () {
      try {
        var resp3 = await fetch(BACKEND_URL + "/api/v1/asr/batch/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archive_ids: ids }),
        });
        var data3 = await resp3.json();
        showToast(t("toast.asrDeleted") + (data3.data ? data3.data.deleted_count : 0) + t("toast.asrDeleted2"), "success");
        loadASRArchives();
      } catch (_) { showToast(t("toast.asrDeleteFail"), "error"); }
    });
  }
}

// ---- 语言切换 ----
document.getElementById("setting-lang-select").addEventListener("change", function () {
  applyLanguage(this.value);
});

// ---- 主题切换 ----
function initTheme() {
  var saved = localStorage.getItem("qvac_theme") || "light";
  applyTheme(saved);
}
function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  localStorage.setItem("qvac_theme", theme);
  var toggle = document.getElementById("setting-theme-toggle");
  if (toggle) toggle.checked = theme === "dark";
}
document.getElementById("setting-theme-toggle").addEventListener("change", function () {
  applyTheme(this.checked ? "dark" : "light");
});

// ---- 标题栏窗口控制 ----
(function initTitlebar() {
  var tbMin = document.getElementById("tb-min");
  var tbMax = document.getElementById("tb-max");
  var tbClose = document.getElementById("tb-close");

  if (tbMin) tbMin.addEventListener("click", function () { window.qvacAPI.winMinimize(); });
  if (tbClose) tbClose.addEventListener("click", function () { window.qvacAPI.winClose(); });

  if (tbMax) {
    tbMax.addEventListener("click", function () { window.qvacAPI.winMaximize(); });
    window.qvacAPI.onMaximizeChange(function (isMaximized) {
      var maxSvg = tbMax.querySelector("svg");
      if (isMaximized) {
        maxSvg.innerHTML = '<rect x="5" y="2" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="7" y="4" width="12" height="12" rx="1" fill="var(--bg-secondary)" stroke="currentColor" stroke-width="2"/>';
        tbMax.setAttribute("title", "Restore");
      } else {
        maxSvg.innerHTML = '<rect x="4" y="4" width="16" height="16" rx="1" fill="none" stroke="currentColor" stroke-width="2"/>';
        tbMax.setAttribute("title", "Maximize");
      }
    });
  }
})();

// ---- 初始化 ----
applyLanguage(currentLang);
initTheme();
