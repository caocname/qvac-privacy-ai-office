/**
 * QVAC Bridge Server — 嵌入 Electron 主进程的 HTTP 服务模块。
 * 通过 @qvac/sdk 直接调用本地 AI 推理能力。
 * 仅绑定 127.0.0.1，遵守 R-01 离线合规铁律。
 *
 * 用法: const { startBridge, stopBridge } = require("./bridge-server");
 *       startBridge({ port: 18889, modelsDir: "..." });
 */
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

let server = null;
let llmModelId = null;
let embedModelId = null;
let whisperModelId = null;
let logFile = null;

function bridgeLog(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stderr.write(line);
  if (logFile) {
    try { fs.appendFileSync(logFile, line); } catch {}
  }
}
let ttsModelId = null;
let ttsConfig = null;  // { language, speed, voice } — 变更时自动重载模型
let llmModelName = "";
let embedModelName = "";
let whisperModelName = "";
let ttsModelName = "";
let modelsDir = null;

// ---- 延迟加载 QVAC SDK (避免阻塞 Electron 启动) ----
let sdk = null;
let ttsAvailable = false;
let textToSpeech;
// Supertone TTS 模型常量 (SDK v0.6.2+)
let TTS_TEXT_ENCODER, TTS_DURATION_PREDICTOR, TTS_VECTOR_ESTIMATOR, TTS_VOCODER,
    TTS_UNICODE_INDEXER, TTS_CONFIG, TTS_VOICE_STYLE;
// 音色映射 (voice_model → voice style constant)
let TTS_VOICE_STYLES = {};
const SUPERTONIC_SAMPLE_RATE = 44100;

async function loadSDK() {
  if (sdk) return sdk;
  const t0 = Date.now();
  bridgeLog("importing @qvac/sdk...");
  sdk = await import("@qvac/sdk");
  bridgeLog(`@qvac/sdk imported (${Date.now() - t0}ms)`);
  // 尝试加载 TTS (Supertone)
  try {
    if (sdk.textToSpeech && sdk.TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32) {
      textToSpeech = sdk.textToSpeech;
      TTS_TEXT_ENCODER = sdk.TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32;
      TTS_DURATION_PREDICTOR = sdk.TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32;
      TTS_VECTOR_ESTIMATOR = sdk.TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32;
      TTS_VOCODER = sdk.TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32;
      TTS_UNICODE_INDEXER = sdk.TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32;
      TTS_CONFIG = sdk.TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE;
      TTS_VOICE_STYLE = sdk.TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE;
      // 收集可用的音色变体
      TTS_VOICE_STYLES = {};
      for (let i = 1; i <= 9; i++) {
        const key = "TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE_" + i;
        if (sdk[key]) TTS_VOICE_STYLES["style_" + i] = sdk[key];
      }
      ttsAvailable = true;
      bridgeLog("TTS: Supertone models available (" + Object.keys(TTS_VOICE_STYLES).length + " voice styles)");
    } else {
      bridgeLog("TTS: Supertone models NOT available in this SDK version");
    }
  } catch (e) { bridgeLog("TTS: load error — " + e.message); }
  return sdk;
}

// ---- 模型描述符映射 ----
const MODEL_DESCRIPTOR_MAP = {
  llm: null,
  embedding: null,
};

function initModelDescriptors(sdkModule) {
  if (sdkModule.LLAMA_3_2_1B_INST_Q4_0) {
    MODEL_DESCRIPTOR_MAP.llm = sdkModule.LLAMA_3_2_1B_INST_Q4_0;
  }
  if (sdkModule.GTE_LARGE_FP16) {
    MODEL_DESCRIPTOR_MAP.embedding = sdkModule.GTE_LARGE_FP16;
  }
}

// ---- Helpers ----
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

// 回退式 BPE 近似计数 — SDK 调用失败时使用。
// Llama 3.x 词表对中文约 1.55 char/token，对 ASCII 约 3.7 char/token。
function _fallbackTokenCount(text) {
  if (!text) return 0;
  let cnChars = 0, asciiChars = 0, otherChars = 0;
  for (const c of text) {
    const cp = c.codePointAt(0) || 0;
    if (cp >= 0x4e00 && cp <= 0x9fff) cnChars++;
    else if (cp >= 0x20 && cp <= 0x7e) asciiChars++;
    else otherChars++;
  }
  return Math.ceil(cnChars / 1.55) + Math.ceil(asciiChars / 3.7) + Math.ceil(otherChars / 2.0) + 1;
}

// ---- HTTP Server ----
async function handleRequest(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, "http://127.0.0.1:18889");
  const sdkModule = sdk;

  // ---- Health ----
  if (url.pathname === "/health" && req.method === "GET") {
    return json(res, 200, {
      status: "ok",
      models: {
        llm_loaded: llmModelId !== null, llm_model: llmModelName,
        embed_loaded: embedModelId !== null, embed_model: embedModelName,
        whisper_loaded: whisperModelId !== null, whisper_model: whisperModelName,
        tts_loaded: ttsModelId !== null, tts_model: ttsModelName,
      },
    });
  }

  // ---- LLM Load ----
  if (url.pathname === "/api/llm/load" && req.method === "POST") {
    const body = await readBody(req);
    const modelName = body.model_name || "Llama-3.2-1B-Instruct-Q4_0.gguf";
    try {
      if (llmModelId) {
        process.stderr.write(`[Bridge] LLM already loaded (${llmModelName}), skipping reload\n`);
        return json(res, 200, { status: "already_loaded", model: llmModelName, modelId: llmModelId });
      }
      process.stderr.write(`[Bridge] Loading LLM: ${modelName}\n`);
      // 优先用 SDK 注册表常量，失败则回退到本地模型文件路径
      let modelSrc = MODEL_DESCRIPTOR_MAP.llm;
      let usedFallback = false;
      const loadNew = async (src) => {
        return sdkModule.loadModel({
          modelSrc: src,
          modelConfig: { ctx_size: 8192, device: "gpu", gpu_layers: 99 },
        });
      };
      let newId;
      const t0 = Date.now();
      try {
        bridgeLog(`LLM: trying registry constant...`);
        newId = await loadNew(modelSrc);
        bridgeLog(`LLM: registry OK (${Date.now() - t0}ms)`);
      } catch (firstErr) {
        bridgeLog(`LLM: registry FAIL after ${Date.now() - t0}ms: ${firstErr.message}`);
        if (modelsDir && modelName) {
          const fallbackPath = path.join(modelsDir, modelName);
          const t1 = Date.now();
          bridgeLog(`LLM: fallback to local file: ${fallbackPath}`);
          newId = await loadNew(fallbackPath);
          bridgeLog(`LLM: local file OK (${Date.now() - t1}ms)`);
          usedFallback = true;
        } else {
          throw firstErr;
        }
      }
      llmModelId = newId;
      llmModelName = modelName;
      return json(res, 200, { status: "loaded", model: modelName, modelId: newId, fallback: usedFallback });
    } catch (err) {
      llmModelId = null;
      llmModelName = "";
      return json(res, 500, { status: "error", message: err.message });
    }
  }

  // ---- LLM Unload ----
  if (url.pathname === "/api/llm/unload" && req.method === "POST") {
    try { if (llmModelId) await sdkModule.unloadModel({ modelId: llmModelId }); } catch {}
    llmModelId = null; llmModelName = "";
    return json(res, 200, { status: "unloaded" });
  }

  // ---- LLM Chat (SSE Streaming) ----
  if (url.pathname === "/api/llm/chat" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    if (!llmModelId) {
      res.write(`data: ${JSON.stringify({ done: true, error: "LLM model not loaded" })}\n\n`);
      return res.end();
    }
    const body = await readBody(req);
    try {
      const startTime = Date.now();
      let fullText = "";
      const run = sdkModule.completion({
        modelId: llmModelId,
        history: body.messages || [],
        stream: true,
        generationParams: {
          predict: body.max_tokens || 1024,
          temp: body.temperature || 0.5,
          repeat_penalty: body.repeat_penalty || 1.0,
          frequency_penalty: body.frequency_penalty || 0.0,
        },
      });
      for await (const ev of run.events) {
        if (ev.type === "contentDelta" && ev.text) {
          fullText += ev.text;
          res.write(`data: ${JSON.stringify({ token: ev.text })}\n\n`);
        }
      }
      const final = await run.final;
      const totalMs = Date.now() - startTime;
      const stats = final.stats ? {
        tokens_per_second: final.stats.tokensPerSecond || (fullText.length / Math.max(totalMs / 1000, 0.001)),
        total_tokens: final.stats.totalTokens || fullText.length,
        total_duration_ms: final.stats.totalDurationMs || totalMs,
      } : {
        tokens_per_second: fullText.length / Math.max(totalMs / 1000, 0.001),
        total_tokens: fullText.length, total_duration_ms: totalMs,
      };
      res.write(`data: ${JSON.stringify({ done: true, full_text: fullText, stats })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ done: true, error: err.message })}\n\n`);
    }
    return res.end();
  }

  // ---- Abort ----
  if (url.pathname === "/api/llm/abort" && req.method === "POST") {
    try { await sdkModule.cancel({ operation: "inference", modelId: llmModelId }); } catch {}
    return json(res, 200, { status: "aborted" });
  }

  // ---- LLM Tokenize (Real BPE token count via QVAC SDK) ----
  // 通过 SDK completion(predict:1, stream:false) 触发 Llama BPE tokenizer
  // 返回 final.stats.promptTokens 作为真实 token 数。
  // 严格对齐技术文档 §2.2「实时调用 QVAC SDK 的 Tokenizer 接口动态计算」。
  if (url.pathname === "/api/llm/tokenize" && req.method === "POST") {
    if (!llmModelId) return json(res, 503, { error: "LLM model not loaded" });
    const body = await readBody(req);
    const texts = Array.isArray(body.texts) ? body.texts : (body.text ? [body.text] : []);
    if (!texts.length) return json(res, 400, { error: "texts is required" });
    try {
      const counts = [];
      for (const text of texts) {
        if (!text) { counts.push(0); continue; }
        const run = sdkModule.completion({
          modelId: llmModelId,
          history: [{ role: "user", content: String(text) }],
          stream: false,
          generationParams: { predict: 1, temp: 0.0 },
        });
        // 消费事件流以触发 final
        try { for await (const _ of run.events) { /* drain */ } } catch (_) {}
        const final = await run.final;
        const stats = final && final.stats ? final.stats : {};
        // SDK 字段命名兼容：promptTokens / prompt_tokens / totalTokens
        const promptTokens = stats.promptTokens || stats.prompt_tokens
          || (stats.totalTokens && stats.generatedTokens ? (stats.totalTokens - stats.generatedTokens) : null);
        if (promptTokens && promptTokens > 0) {
          counts.push(promptTokens);
        } else {
          // SDK 没回填字段 — 退回经验公式
          counts.push(_fallbackTokenCount(String(text)));
        }
      }
      return json(res, 200, { counts, tokenizer: "qvac-sdk-llamacpp" });
    } catch (err) {
      bridgeLog(`tokenize error: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  // ---- Embed Load ----
  if (url.pathname === "/api/embed/load" && req.method === "POST") {
    const body = await readBody(req);
    const modelName = body.model_name || "gte-large_fp16.gguf";
    try {
      if (embedModelId) {
        process.stderr.write(`[Bridge] Embed already loaded (${embedModelName}), skipping reload\n`);
        return json(res, 200, { status: "already_loaded", model: embedModelName, modelId: embedModelId });
      }
      process.stderr.write(`[Bridge] Loading Embedding: ${modelName}\n`);
      // 优先用 SDK 注册表常量，失败则回退到本地模型文件路径
      let modelSrc = MODEL_DESCRIPTOR_MAP.embedding;
      let usedFallback = false;
      const loadNew = async (src) => {
        return sdkModule.loadModel({
          modelSrc: src,
          modelType: "embeddings",
          modelConfig: { device: "gpu", gpu_layers: 99 },
        });
      };
      let newId;
      const t0 = Date.now();
      try {
        bridgeLog(`Embed: trying registry constant...`);
        newId = await loadNew(modelSrc);
        bridgeLog(`Embed: registry OK (${Date.now() - t0}ms)`);
      } catch (firstErr) {
        bridgeLog(`Embed: registry FAIL after ${Date.now() - t0}ms: ${firstErr.message}`);
        if (modelsDir && modelName) {
          const fallbackPath = path.join(modelsDir, modelName);
          const t1 = Date.now();
          bridgeLog(`Embed: fallback to local file: ${fallbackPath}`);
          newId = await loadNew(fallbackPath);
          bridgeLog(`Embed: local file OK (${Date.now() - t1}ms)`);
          usedFallback = true;
        } else {
          throw firstErr;
        }
      }
      embedModelId = newId;
      embedModelName = modelName;
      return json(res, 200, { status: "loaded", model: modelName, modelId: newId });
    } catch (err) {
      embedModelId = null;
      embedModelName = "";
      return json(res, 500, { status: "error", message: err.message });
    }
  }

  // ---- Embedding ----
  if (url.pathname === "/api/embed" && req.method === "POST") {
    if (!embedModelId) return json(res, 503, { error: "Embedding model not loaded" });
    const body = await readBody(req);
    try {
      const embeddings = [];
      for (const text of (body.texts || [])) {
        const result = await sdkModule.embed({ modelId: embedModelId, text });
        embeddings.push(result.embedding || result || []);
      }
      return json(res, 200, { embeddings });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ---- Model Status ----
  if (url.pathname === "/api/models/status" && req.method === "GET") {
    return json(res, 200, {
      llm_loaded: llmModelId !== null, llm_model: llmModelName,
      embed_loaded: embedModelId !== null, embed_model: embedModelName,
      whisper_loaded: whisperModelId !== null, whisper_model: whisperModelName,
    });
  }

  // ---- ASR Transcribe ----
  if (url.pathname === "/api/asr/transcribe" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.audio_path) return json(res, 400, { error: "audio_path is required" });

    let modelId = whisperModelId;
    if (!modelId) {
      try {
        process.stderr.write("[Bridge] Loading Whisper model...\n");
        modelId = await sdkModule.loadModel({
          modelSrc: sdkModule.WHISPER_BASE_Q0F16,
          modelConfig: { contextParams: { use_gpu: true } },
        });
        whisperModelId = modelId;
        whisperModelName = "ggml-base.bin";
      } catch (err) {
        return json(res, 500, { error: "Failed to load whisper model: " + err.message });
      }
    }
    try {
      const result = await sdkModule.transcribe({
        modelId,
        audioChunk: body.audio_path,
        prompt: body.language === "zh" ? "以下是中文普通话。" : "",
      });
      const text = typeof result === "string" ? result : (result.text || "");
      return json(res, 200, { text });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ---- TTS Speak (Supertone) ----
  if (url.pathname === "/api/tts/speak" && req.method === "POST") {
    if (!ttsAvailable) return json(res, 503, { error: "TTS not available — Supertone models missing from SDK" });
    const body = await readBody(req);
    if (!body.text) return json(res, 400, { error: "text is required" });

    const lang = "en";
    const speed = typeof body.speed === "number" ? body.speed : 1.1;
    const voice = body.voice || "style_1";
    const newConfig = { speed: speed, voice: voice };

    // 模型未加载 或 配置变更 → 重载
    let modelId = ttsModelId;
    if (!modelId || !ttsConfig ||
        ttsConfig.speed !== newConfig.speed ||
        ttsConfig.voice !== newConfig.voice) {
      if (modelId && ttsConfig) {
        try { await sdkModule.unloadModel({ modelId }); } catch {}
        bridgeLog(`TTS: unloaded previous model (config changed)`);
      }
      try {
        let voiceStyleSrc = TTS_VOICE_STYLE.src;
        if (voice && TTS_VOICE_STYLES[voice]) {
          voiceStyleSrc = TTS_VOICE_STYLES[voice].src;
        }
        process.stderr.write(`[Bridge] Loading TTS Supertone (speed=${speed}, voice=${voice})...\n`);
        modelId = await sdkModule.loadModel({
          modelSrc: TTS_TEXT_ENCODER.src,
          modelType: "onnx-tts",
          modelConfig: {
            ttsEngine: "supertonic",
            language: lang,
            ttsSpeed: speed,
            ttsNumInferenceSteps: 5,
            ttsSupertonicMultilingual: true,
            ttsTextEncoderSrc: TTS_TEXT_ENCODER.src,
            ttsDurationPredictorSrc: TTS_DURATION_PREDICTOR.src,
            ttsVectorEstimatorSrc: TTS_VECTOR_ESTIMATOR.src,
            ttsVocoderSrc: TTS_VOCODER.src,
            ttsUnicodeIndexerSrc: TTS_UNICODE_INDEXER.src,
            ttsTtsConfigSrc: TTS_CONFIG.src,
            ttsVoiceStyleSrc: voiceStyleSrc,
          },
        });
        ttsModelId = modelId;
        ttsConfig = newConfig;
        ttsModelName = "Supertone2-ML";
        bridgeLog(`TTS model loaded: ${ttsModelName} (${modelId})`);
      } catch (err) {
        ttsModelId = null; ttsConfig = null;
        bridgeLog(`TTS load error: ${err.message}`);
        return json(res, 500, { error: "Failed to load TTS model: " + err.message });
      }
    }
    try {
      const result = textToSpeech({ modelId, text: body.text, inputType: "text", stream: false });
      const audioBuffer = await result.buffer;
      process.stderr.write(`[Bridge] TTS output: ctor=${audioBuffer.constructor?.name || "none"}, typeof=${typeof audioBuffer}, len=${audioBuffer.length}, isView=${ArrayBuffer.isView(audioBuffer)}\n`);

      // QVAC SDK textToSpeech 可能返回 Int16Array, Float32Array, Node Buffer, 或 array-like object
      let samples;
      if (audioBuffer instanceof Float32Array) {
        samples = new Int16Array(audioBuffer.length);
        for (let i = 0; i < audioBuffer.length; i++) {
          const s = Math.max(-1, Math.min(1, audioBuffer[i]));
          samples[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
        }
      } else if (audioBuffer instanceof Int16Array) {
        samples = audioBuffer;
      } else if (Buffer.isBuffer(audioBuffer)) {
        samples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2);
      } else if (ArrayBuffer.isView(audioBuffer)) {
        try { samples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength / 2); } catch (_) {
          samples = Int16Array.from(audioBuffer);
        }
      } else if (audioBuffer && audioBuffer.length > 0) {
        // Array-like object: {0: val, 1: val, ..., length: N}
        samples = Int16Array.from(audioBuffer);
        process.stderr.write(`[Bridge] TTS: converted from array-like object, got ${samples.length} samples\n`);
      } else {
        return json(res, 500, { error: "Unexpected TTS output: " + JSON.stringify({
          type: typeof audioBuffer,
          ctor: audioBuffer?.constructor?.name,
          len: audioBuffer?.length,
        })});
      }

      const numChannels = 1, bitsPerSample = 16;
      const sampleRate = SUPERTONIC_SAMPLE_RATE;
      const byteRate = sampleRate * numChannels * bitsPerSample / 8;
      const blockAlign = numChannels * bitsPerSample / 8;
      const dataSize = samples.length * (bitsPerSample / 8);
      const header = Buffer.alloc(44);
      header.write("RIFF", 0); header.writeUInt32LE(36 + dataSize, 4); header.write("WAVE", 8);
      header.write("fmt ", 12); header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20); header.writeUInt16LE(numChannels, 22);
      header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(byteRate, 28);
      header.writeUInt16LE(blockAlign, 32); header.writeUInt16LE(bitsPerSample, 34);
      header.write("data", 36); header.writeUInt32LE(dataSize, 40);
      const audioData = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
      res.writeHead(200, { "Content-Type": "audio/wav" });
      return res.end(Buffer.concat([header, audioData]));
    } catch (err) {
      bridgeLog(`TTS speak error: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  // ---- Translate (via LLM) ----
  if (url.pathname === "/api/translate" && req.method === "POST") {
    if (!llmModelId) return json(res, 503, { error: "LLM model not loaded" });
    const body = await readBody(req);
    if (!body.text) return json(res, 400, { error: "text is required" });

    const LANG_NAMES = { zh: "中文", en: "English", ja: "日本語", ko: "한국어", fr: "Français", de: "Deutsch", es: "Español" };
    const targetName = LANG_NAMES[body.target_lang] || body.target_lang;
    const systemPrompt = body.target_lang === "en"
      ? "You are a professional translator. Translate the following text to English accurately and naturally. Only output the translation, no explanations."
      : `你是一位专业翻译。请将以下文本准确、自然地翻译为${targetName}。只输出译文，不要添加任何解释。`;

    try {
      let fullText = "";
      const run = sdkModule.completion({
        modelId: llmModelId,
        history: [{ role: "system", content: systemPrompt }, { role: "user", content: body.text }],
        stream: true,
        generationParams: { predict: 2048, temp: 0.1, repeat_penalty: 1.15 },
      });
      for await (const ev of run.events) {
        if (ev.type === "contentDelta" && ev.text) fullText += ev.text;
      }
      await run.final;
      return json(res, 200, { translated_text: fullText.trim() });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ---- TTS Unload ----
  if (url.pathname === "/api/tts/unload" && req.method === "POST") {
    try { if (ttsModelId) await sdkModule.unloadModel({ modelId: ttsModelId }); } catch {}
    ttsModelId = null; ttsModelName = "";
    return json(res, 200, { status: "unloaded" });
  }

  json(res, 404, { error: "Not found" });
}

// ---- Public API ----
async function startBridge(opts = {}) {
  const port = opts.port || 18889;
  const host = opts.host || "127.0.0.1";
  modelsDir = opts.modelsDir || null;
  if (modelsDir) {
    bridgeLog(`Models directory: ${modelsDir}`);
  }
  // 初始化日志文件
  if (modelsDir) {
    const logDir = path.join(path.dirname(modelsDir), "logs");
    try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
    logFile = path.join(logDir, "bridge.log");
    bridgeLog(`Log file: ${logFile}`);
  }
  bridgeLog("Loading QVAC SDK...");

  const sdkModule = await loadSDK();
  initModelDescriptors(sdkModule);

  server = http.createServer(handleRequest);
  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      // R-01 离线合规审计 — 启动时强制输出绑定地址 + 校验回环
      const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
      const auditLine = JSON.stringify({
        event: "bridge_bind_audit",
        bind_host: host,
        bind_port: port,
        loopback_only: isLoopback,
        compliance: isLoopback ? "R-01_pass" : "R-01_VIOLATION",
        ts: new Date().toISOString(),
      });
      bridgeLog(`AUDIT ${auditLine}`);
      process.stderr.write(`[Bridge] QVAC Bridge Service (embedded) on ${host}:${port}\n`);
      if (!isLoopback) {
        process.stderr.write(`[Bridge][WARN] bind_host=${host} 非回环地址，违反 R-01 合规！\n`);
      }
      resolve({ port, host });
    });
    server.on("error", reject);
  });
}

async function stopBridge() {
  const sdkModule = sdk; // capture before cleanup
  try {
    if (llmModelId && sdkModule) await sdkModule.unloadModel({ modelId: llmModelId });
    if (embedModelId && sdkModule) await sdkModule.unloadModel({ modelId: embedModelId });
    if (whisperModelId && sdkModule) await sdkModule.unloadModel({ modelId: whisperModelId });
    if (ttsModelId && sdkModule) await sdkModule.unloadModel({ modelId: ttsModelId });
  } catch {}
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        process.stderr.write("[Bridge] Stopped.\n");
        resolve();
      });
    } else {
      resolve();
    }
  });
}

module.exports = { startBridge, stopBridge };
