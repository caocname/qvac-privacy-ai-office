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
let llmModelName = "";
let embedModelName = "";
let whisperModelName = "";
let ttsModelName = "";
let modelsDir = null;

// ---- 延迟加载 QVAC SDK (避免阻塞 Electron 启动) ----
let sdk = null;
let ttsAvailable = false;
let textToSpeech, TTS_T3_TURBO_EN_CHATTERBOX_Q8_0, TTS_S3GEN_EN_CHATTERBOX;

async function loadSDK() {
  if (sdk) return sdk;
  const t0 = Date.now();
  bridgeLog("importing @qvac/sdk...");
  sdk = await import("@qvac/sdk");
  bridgeLog(`@qvac/sdk imported (${Date.now() - t0}ms)`);
  // 尝试加载 TTS
  try {
    if (sdk.textToSpeech && sdk.TTS_T3_TURBO_EN_CHATTERBOX_Q8_0) {
      textToSpeech = sdk.textToSpeech;
      TTS_T3_TURBO_EN_CHATTERBOX_Q8_0 = sdk.TTS_T3_TURBO_EN_CHATTERBOX_Q8_0;
      TTS_S3GEN_EN_CHATTERBOX = sdk.TTS_S3GEN_EN_CHATTERBOX;
      ttsAvailable = true;
    }
  } catch { /* TTS 不可用 */ }
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

  // ---- TTS Speak ----
  if (url.pathname === "/api/tts/speak" && req.method === "POST") {
    if (!ttsAvailable) return json(res, 503, { error: "TTS not available" });
    const body = await readBody(req);
    if (!body.text) return json(res, 400, { error: "text is required" });

    let modelId = ttsModelId;
    if (!modelId) {
      try {
        process.stderr.write("[Bridge] Loading TTS Chatterbox...\n");
        modelId = await sdkModule.loadModel({
          modelSrc: TTS_T3_TURBO_EN_CHATTERBOX_Q8_0.src,
          modelType: "tts",
          modelConfig: {
            ttsEngine: "chatterbox",
            language: body.language === "zh" ? "zh" : "en",
            s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX.src,
          },
        });
        ttsModelId = modelId; ttsModelName = "Chatterbox-T3-Turbo";
      } catch (err) {
        return json(res, 500, { error: "Failed to load TTS model: " + err.message });
      }
    }
    try {
      const result = textToSpeech({ modelId, text: body.text, inputType: "text", stream: false });
      const audioBuffer = await result.buffer;
      const sampleRate = 24000, numChannels = 1, bitsPerSample = 16;
      const byteRate = sampleRate * numChannels * bitsPerSample / 8;
      const blockAlign = numChannels * bitsPerSample / 8;
      const dataSize = audioBuffer.length * 2;
      const header = Buffer.alloc(44);
      header.write("RIFF", 0); header.writeUInt32LE(36 + dataSize, 4); header.write("WAVE", 8);
      header.write("fmt ", 12); header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20); header.writeUInt16LE(numChannels, 22);
      header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(byteRate, 28);
      header.writeUInt16LE(blockAlign, 32); header.writeUInt16LE(bitsPerSample, 34);
      header.write("data", 36); header.writeUInt32LE(dataSize, 40);
      const audioData = Buffer.from(Int16Array.from(audioBuffer).buffer);
      res.writeHead(200, { "Content-Type": "audio/wav" });
      return res.end(Buffer.concat([header, audioData]));
    } catch (err) {
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
      process.stderr.write(`[Bridge] QVAC Bridge Service (embedded) on ${host}:${port}\n`);
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
