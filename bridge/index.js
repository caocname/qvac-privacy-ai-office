/**
 * QVAC Bridge Service — Node.js HTTP 服务器，通过 @qvac/sdk 直接调用 QVAC 推理能力。
 *
 * V0.4: 废弃 Bare Worker，改用 @qvac/sdk 高層 API（与 text1 同架构）。
 * 仅绑定 127.0.0.1，遵守 R-01 离线合规铁律。
 */

import http from "node:http";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 18889;

// ---- QVAC SDK ----
import {
  loadModel,
  unloadModel,
  completion,
  embed,
  transcribe,
  cancel,
  LLAMA_3_2_1B_INST_Q4_0,
  EMBEDDINGGEMMA_300M_Q4_0,
  WHISPER_BASE_Q0F16,
} from "@qvac/sdk";

// TTS 可选导入（SDK v0.11+ 才支持 Chatterbox TTS）
let textToSpeech, TTS_T3_TURBO_EN_CHATTERBOX_Q8_0, TTS_S3GEN_EN_CHATTERBOX;
let ttsAvailable = false;
try {
  const ttsModule = await import("@qvac/sdk");
  textToSpeech = ttsModule.textToSpeech;
  TTS_T3_TURBO_EN_CHATTERBOX_Q8_0 = ttsModule.TTS_T3_TURBO_EN_CHATTERBOX_Q8_0;
  TTS_S3GEN_EN_CHATTERBOX = ttsModule.TTS_S3GEN_EN_CHATTERBOX;
  if (textToSpeech && TTS_T3_TURBO_EN_CHATTERBOX_Q8_0) ttsAvailable = true;
} catch {
  process.stderr.write("[Bridge] TTS models not available in this SDK version (requires v0.11+)\n");
}

// ---- Model state ----
let llmModelId = null;
let embedModelId = null;
let whisperModelId = null;
let ttsModelId = null;
let llmModelName = "";
let embedModelName = "";
let whisperModelName = "";
let ttsModelName = "";

// Map Python backend model names to SDK model descriptors
const MODEL_DESCRIPTOR_MAP = {
  llm: LLAMA_3_2_1B_INST_Q4_0,
  embedding: EMBEDDINGGEMMA_300M_Q4_0,
};

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

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${BRIDGE_HOST}:${BRIDGE_PORT}`);

  // ---- Health ----
  if (url.pathname === "/health" && req.method === "GET") {
    return json(res, 200, {
      status: "ok",
      models: {
        llm_loaded: llmModelId !== null,
        llm_model: llmModelName,
        embed_loaded: embedModelId !== null,
        embed_model: embedModelName,
        whisper_loaded: whisperModelId !== null,
        whisper_model: whisperModelName,
        tts_loaded: ttsModelId !== null,
        tts_model: ttsModelName,
      },
    });
  }

  // ---- LLM Load ----
  if (url.pathname === "/api/llm/load" && req.method === "POST") {
    const body = await readBody(req);
    const modelName = body.model_name || "Llama-3.2-1B-Instruct-Q4_0.gguf";
    try {
      if (llmModelId) {
        try { await unloadModel({ modelId: llmModelId }); } catch {}
        llmModelId = null;
      }
      process.stderr.write(`[Bridge] Loading LLM via SDK: ${modelName}\n`);
      llmModelId = await loadModel({
        modelSrc: MODEL_DESCRIPTOR_MAP.llm,
        modelConfig: { ctx_size: 8192, device: "gpu", gpu_layers: 99 },
      });
      llmModelName = modelName;
      process.stderr.write(`[Bridge] LLM loaded — modelId=${llmModelId}\n`);
      return json(res, 200, { status: "loaded", model: modelName, modelId: llmModelId });
    } catch (err) {
      process.stderr.write(`[Bridge] LLM load error: ${err.message}\n`);
      return json(res, 500, { status: "error", message: err.message });
    }
  }

  // ---- LLM Unload ----
  if (url.pathname === "/api/llm/unload" && req.method === "POST") {
    try {
      if (llmModelId) {
        await unloadModel({ modelId: llmModelId });
      }
    } catch {}
    llmModelId = null;
    llmModelName = "";
    return json(res, 200, { status: "unloaded" });
  }

  // ---- LLM Chat (SSE Streaming) ----
  if (url.pathname === "/api/llm/chat" && req.method === "POST") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    if (!llmModelId) {
      res.write(`data: ${JSON.stringify({ done: true, error: "LLM model not loaded" })}\n\n`);
      return res.end();
    }

    const body = await readBody(req);
    const messages = body.messages || [];
    const maxTokens = body.max_tokens || 1024;
    const temperature = body.temperature || 0.5;
    const repeatPenalty = body.repeat_penalty || 1.0;
    const frequencyPenalty = body.frequency_penalty || 0.0;

    try {
      const startTime = Date.now();
      let fullText = "";

      const run = completion({
        modelId: llmModelId,
        history: messages,
        stream: true,
        generationParams: {
          predict: maxTokens,
          temp: temperature,
          repeat_penalty: repeatPenalty,
          frequency_penalty: frequencyPenalty,
        },
      });

      for await (const ev of run.events) {
        if (ev.type === "contentDelta" && ev.text) {
          fullText += ev.text;
          res.write(`data: ${JSON.stringify({ token: ev.text })}\n\n`);
        }
      }

      const final = await run.final;
      const totalDurationMs = Date.now() - startTime;

      const stats = final.stats
        ? {
            tokens_per_second: final.stats.tokensPerSecond || (fullText.length / Math.max(totalDurationMs / 1000, 0.001)),
            total_tokens: final.stats.totalTokens || fullText.length,
            total_duration_ms: final.stats.totalDurationMs || totalDurationMs,
          }
        : {
            tokens_per_second: fullText.length / Math.max(totalDurationMs / 1000, 0.001),
            total_tokens: fullText.length,
            total_duration_ms: totalDurationMs,
          };

      process.stderr.write(
        `[Bridge] chat done — full_text.length=${fullText.length} stats=${JSON.stringify(stats)}\n`
      );

      res.write(
        `data: ${JSON.stringify({
          done: true,
          full_text: fullText,
          stats: stats,
        })}\n\n`
      );
    } catch (err) {
      process.stderr.write(`[Bridge] chat error: ${err.message}\n`);
      res.write(`data: ${JSON.stringify({ done: true, error: err.message })}\n\n`);
    }
    return res.end();
  }

  // ---- Abort ----
  if (url.pathname === "/api/llm/abort" && req.method === "POST") {
    try {
      await cancel({ operation: "inference", modelId: llmModelId });
    } catch {}
    return json(res, 200, { status: "aborted" });
  }

  // ---- Embed Load ----
  if (url.pathname === "/api/embed/load" && req.method === "POST") {
    const body = await readBody(req);
    const modelName = body.model_name || "gte-large_fp16.gguf";
    try {
      if (embedModelId) {
        try { await unloadModel({ modelId: embedModelId }); } catch {}
        embedModelId = null;
      }
      process.stderr.write(`[Bridge] Loading Embedding via SDK: ${modelName}\n`);
      embedModelId = await loadModel({
        modelSrc: MODEL_DESCRIPTOR_MAP.embedding,
        modelConfig: { device: "gpu", gpu_layers: 99 },
      });
      embedModelName = modelName;
      process.stderr.write(`[Bridge] Embedding loaded — modelId=${embedModelId}\n`);
      return json(res, 200, { status: "loaded", model: modelName, modelId: embedModelId });
    } catch (err) {
      process.stderr.write(`[Bridge] Embed load error: ${err.message}\n`);
      return json(res, 500, { status: "error", message: err.message });
    }
  }

  // ---- Embedding ----
  if (url.pathname === "/api/embed" && req.method === "POST") {
    if (!embedModelId) {
      return json(res, 503, { error: "Embedding model not loaded" });
    }
    const body = await readBody(req);
    const texts = body.texts || [];
    try {
      const embeddings = [];
      for (const text of texts) {
        const result = await embed({ modelId: embedModelId, text: text });
        if (result.embedding && Array.isArray(result.embedding)) {
          embeddings.push(result.embedding);
        } else if (Array.isArray(result)) {
          embeddings.push(result);
        } else {
          embeddings.push([]);
        }
      }
      return json(res, 200, { embeddings });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ---- Model Status ----
  if (url.pathname === "/api/models/status" && req.method === "GET") {
    return json(res, 200, {
      llm_loaded: llmModelId !== null,
      llm_model: llmModelName,
      embed_loaded: embedModelId !== null,
      embed_model: embedModelName,
      whisper_loaded: whisperModelId !== null,
      whisper_model: whisperModelName,
    });
  }

  // ---- ASR Transcribe ----
  if (url.pathname === "/api/asr/transcribe" && req.method === "POST") {
    const body = await readBody(req);
    const audioPath = body.audio_path;
    const language = body.language || "zh";

    if (!audioPath) {
      return json(res, 400, { error: "audio_path is required" });
    }

    let modelId = whisperModelId;
    // 懒加载 whisper 模型
    if (!modelId) {
      try {
        process.stderr.write(`[Bridge] Loading Whisper model...\n`);
        modelId = await loadModel({
          modelSrc: WHISPER_BASE_Q0F16,
          modelConfig: { contextParams: { use_gpu: true } },
        });
        whisperModelId = modelId;
        whisperModelName = "ggml-base.bin";
        process.stderr.write(`[Bridge] Whisper loaded — modelId=${modelId}\n`);
      } catch (err) {
        process.stderr.write(`[Bridge] Whisper load error: ${err.message}\n`);
        return json(res, 500, { error: "Failed to load whisper model: " + err.message });
      }
    }

    try {
      process.stderr.write(`[Bridge] Transcribing: ${audioPath} (lang=${language})\n`);
      const result = await transcribe({
        modelId,
        audioChunk: audioPath,
        prompt: language === "zh" ? "以下是中文普通话。" : "",
      });
      const text = typeof result === "string" ? result : (result.text || "");
      process.stderr.write(`[Bridge] Transcription done — ${text.length} chars\n`);
      return json(res, 200, { text });
    } catch (err) {
      process.stderr.write(`[Bridge] Transcribe error: ${err.message}\n`);
      return json(res, 500, { error: err.message });
    }
  }

  // ---- TTS Speak ----
  if (url.pathname === "/api/tts/speak" && req.method === "POST") {
    if (!ttsAvailable) {
      return json(res, 503, { error: "TTS model not available in this SDK version (requires v0.11+)" });
    }
    const body = await readBody(req);
    const text = body.text || "";
    const language = body.language || "zh";

    if (!text) {
      return json(res, 400, { error: "text is required" });
    }

    let modelId = ttsModelId;
    if (!modelId) {
      try {
        process.stderr.write(`[Bridge] Loading TTS Chatterbox model...\n`);
        modelId = await loadModel({
          modelSrc: TTS_T3_TURBO_EN_CHATTERBOX_Q8_0.src,
          modelType: "tts",
          modelConfig: {
            ttsEngine: "chatterbox",
            language: language === "zh" ? "zh" : "en",
            s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX.src,
          },
        });
        ttsModelId = modelId;
        ttsModelName = "Chatterbox-T3-Turbo";
        process.stderr.write(`[Bridge] TTS loaded — modelId=${modelId}\n`);
      } catch (err) {
        process.stderr.write(`[Bridge] TTS load error: ${err.message}\n`);
        return json(res, 500, { error: "Failed to load TTS model: " + err.message });
      }
    }

    try {
      const result = textToSpeech({ modelId, text, inputType: "text", stream: false });
      const audioBuffer = await result.buffer;
      const sampleRate = 24000;
      // Build minimal WAV header
      const numChannels = 1;
      const bitsPerSample = 16;
      const byteRate = sampleRate * numChannels * bitsPerSample / 8;
      const blockAlign = numChannels * bitsPerSample / 8;
      const dataSize = audioBuffer.length * 2;
      const header = Buffer.alloc(44);
      header.write("RIFF", 0);
      header.writeUInt32LE(36 + dataSize, 4);
      header.write("WAVE", 8);
      header.write("fmt ", 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20); // PCM
      header.writeUInt16LE(numChannels, 22);
      header.writeUInt32LE(sampleRate, 24);
      header.writeUInt32LE(byteRate, 28);
      header.writeUInt16LE(blockAlign, 32);
      header.writeUInt16LE(bitsPerSample, 34);
      header.write("data", 36);
      header.writeUInt32LE(dataSize, 40);
      const audioData = Buffer.from(Int16Array.from(audioBuffer).buffer);
      const wavBuffer = Buffer.concat([header, audioData]);
      process.stderr.write(`[Bridge] TTS done — ${audioBuffer.length} samples\n`);
      res.writeHead(200, { "Content-Type": "audio/wav" });
      return res.end(wavBuffer);
    } catch (err) {
      process.stderr.write(`[Bridge] TTS error: ${err.message}\n`);
      return json(res, 500, { error: err.message });
    }
  }

  // ---- Translate (via LLM) ----
  if (url.pathname === "/api/translate" && req.method === "POST") {
    if (!llmModelId) {
      return json(res, 503, { error: "LLM model not loaded" });
    }
    const body = await readBody(req);
    const text = body.text || "";
    const sourceLang = body.source_lang || "auto";
    const targetLang = body.target_lang || "zh";

    if (!text) {
      return json(res, 400, { error: "text is required" });
    }

    try {
      // 动态构建翻译提示词，支持多语言
      const LANG_NAMES = {
        zh: "中文", en: "English", ja: "日本語", ko: "한국어",
        fr: "Français", de: "Deutsch", es: "Español",
      };
      const targetName = LANG_NAMES[targetLang] || targetLang;
      const systemPrompt = targetLang === "en"
        ? "You are a professional translator. Translate the following text to English accurately and naturally. Only output the translation, no explanations."
        : `你是一位专业翻译。请将以下文本准确、自然地翻译为${targetName}。只输出译文，不要添加任何解释。`;

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ];

      let fullText = "";
      const run = completion({
        modelId: llmModelId,
        history: messages,
        stream: true,
        generationParams: { predict: 2048, temp: 0.1, repeat_penalty: 1.15 },
      });

      for await (const ev of run.events) {
        if (ev.type === "contentDelta" && ev.text) {
          fullText += ev.text;
        }
      }
      await run.final;

      process.stderr.write(`[Bridge] Translation done — ${fullText.length} chars\n`);
      return json(res, 200, { translated_text: fullText.trim() });
    } catch (err) {
      process.stderr.write(`[Bridge] Translate error: ${err.message}\n`);
      return json(res, 500, { error: err.message });
    }
  }

  // ---- TTS Unload ----
  if (url.pathname === "/api/tts/unload" && req.method === "POST") {
    try {
      if (ttsModelId) {
        await unloadModel({ modelId: ttsModelId });
      }
    } catch {}
    ttsModelId = null;
    ttsModelName = "";
    return json(res, 200, { status: "unloaded" });
  }

  // 404
  json(res, 404, { error: "Not found" });
});

// ---- Startup ----

function main() {
  server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    process.stderr.write(`[Bridge] QVAC Bridge Service (SDK mode) on ${BRIDGE_HOST}:${BRIDGE_PORT}\n`);
  });
}

// Graceful shutdown
process.on("SIGINT", async () => {
  process.stderr.write("[Bridge] Shutting down...\n");
  try {
    if (llmModelId) await unloadModel({ modelId: llmModelId });
    if (embedModelId) await unloadModel({ modelId: embedModelId });
    if (whisperModelId) await unloadModel({ modelId: whisperModelId });
    if (ttsModelId) await unloadModel({ modelId: ttsModelId });
  } catch {}
  server.close();
  process.exit(0);
});

main();
