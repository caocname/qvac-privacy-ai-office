/**
 * QVAC Bridge Service — 连接 Python 后端与 QVAC SDK 的桥接服务。
 *
 * 职责:
 * - 加载并管理 QVAC LLM / Embedding / ASR / TTS 模型生命周期
 * - 提供本地 HTTP API 供 Python FastAPI 后端调用
 * - 流式推理响应通过 Server-Sent Events (SSE) 推送
 *
 * 仅绑定 127.0.0.1，遵守 R-01 离线合规铁律。
 */

import http from "node:http";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 18889;
const MODELS_DIR = new URL("../data/models", import.meta.url).pathname;

// ---- Model Registry ----
let llmModel = null;
let embedModel = null;
let modelInfo = { llm_loaded: false, llm_model: "", embed_loaded: false, embed_model: "" };

// ---- Event Bus ----
const events = new EventEmitter();

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

// ---- Load QVAC Models ----
async function loadLLMModel(modelName) {
  try {
    const LlmLlamacpp = (await import("@qvac/llm-llamacpp")).default || await import("@qvac/llm-llamacpp");
    const FilesystemDL = (await import("@qvac/dl-filesystem")).default || await import("@qvac/dl-filesystem");

    const fsDL = new FilesystemDL({ dirPath: MODELS_DIR });
    const args = {
      loader: fsDL,
      opts: {
        stats: true,
        contextSize: 8192,
        gpuLayers: 32,
        threads: 4,
      },
      diskPath: MODELS_DIR,
      modelName: modelName,
    };

    const model = new LlmLlamacpp(args);
    await model.load();
    modelInfo.llm_loaded = true;
    modelInfo.llm_model = modelName;
    console.log(`[Bridge] LLM model loaded: ${modelName}`);
    return { model, fsDL };
  } catch (err) {
    console.error(`[Bridge] Failed to load LLM model: ${err.message}`);
    return null;
  }
}

async function loadEmbedModel(modelName) {
  try {
    const GGMLBert = (await import("@qvac/embed-llamacpp")).default || await import("@qvac/embed-llamacpp");
    const FilesystemDL = (await import("@qvac/dl-filesystem")).default || await import("@qvac/dl-filesystem");

    const fsDL = new FilesystemDL({ dirPath: MODELS_DIR });
    const args = {
      loader: fsDL,
      opts: { threads: 2 },
      diskPath: MODELS_DIR,
      modelName: modelName,
    };

    const model = new GGMLBert(args);
    await model.load();
    modelInfo.embed_loaded = true;
    modelInfo.embed_model = modelName;
    console.log(`[Bridge] Embedding model loaded: ${modelName}`);
    return { model, fsDL };
  } catch (err) {
    console.error(`[Bridge] Failed to load embedding model: ${err.message}`);
    return null;
  }
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
    return json(res, 200, { status: "ok", models: modelInfo });
  }

  // ---- LLM Load ----
  if (url.pathname === "/api/llm/load" && req.method === "POST") {
    const body = await readBody(req);
    const modelName = body.model_name || "Llama-3.2-1B-Instruct-Q4_0.gguf";
    const result = await loadLLMModel(modelName);
    if (result) {
      llmModel = { instance: result.model, loader: result.fsDL };
      return json(res, 200, { status: "loaded", model: modelName });
    }
    return json(res, 500, { status: "error", message: "Failed to load LLM model" });
  }

  // ---- LLM Unload ----
  if (url.pathname === "/api/llm/unload" && req.method === "POST") {
    if (llmModel) {
      try {
        await llmModel.instance.unload();
        await llmModel.loader.close();
      } catch {}
      llmModel = null;
      modelInfo.llm_loaded = false;
    }
    return json(res, 200, { status: "unloaded" });
  }

  // ---- LLM Chat (Streaming) ----
  if (url.pathname === "/api/llm/chat" && req.method === "POST") {
    if (!llmModel || !llmModel.instance) {
      return json(res, 503, { error: "LLM model not loaded" });
    }

    const body = await readBody(req);
    const messages = body.messages || [];
    const maxTokens = body.max_tokens || 2048;
    const temperature = body.temperature || 0.7;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      const prompt = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await llmModel.instance.run(prompt, {
        maxTokens,
        temperature,
      });

      let fullText = "";

      await response
        .onUpdate((data) => {
          fullText += data;
          res.write(`data: ${JSON.stringify({ token: data })}\n\n`);
        })
        .await();

      const stats = response.stats || {};
      res.write(
        `data: ${JSON.stringify({
          done: true,
          full_text: fullText,
          stats: {
            tokens_per_second: stats.tokensPerSecond || 0,
            total_tokens: stats.totalTokens || fullText.length,
            total_duration_ms: stats.totalDurationMs || 0,
          },
        })}\n\n`
      );
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    return res.end();
  }

  // ---- Embedding ----
  if (url.pathname === "/api/embed" && req.method === "POST") {
    if (!embedModel || !embedModel.instance) {
      return json(res, 503, { error: "Embedding model not loaded" });
    }

    const body = await readBody(req);
    const texts = body.texts || [];

    try {
      const embeddings = [];
      for (const text of texts) {
        const result = await embedModel.instance.embed(text);
        embeddings.push(Array.from(result.embedding || result));
      }
      return json(res, 200, { embeddings });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ---- Embed Load ----
  if (url.pathname === "/api/embed/load" && req.method === "POST") {
    const body = await readBody(req);
    const modelName = body.model_name || "gte-large_fp16.gguf";
    const result = await loadEmbedModel(modelName);
    if (result) {
      embedModel = { instance: result.model, loader: result.fsDL };
      return json(res, 200, { status: "loaded", model: modelName });
    }
    return json(res, 500, { status: "error", message: "Failed to load embedding model" });
  }

  // ---- Model Status ----
  if (url.pathname === "/api/models/status" && req.method === "GET") {
    return json(res, 200, modelInfo);
  }

  // ---- Abort ----
  if (url.pathname === "/api/llm/abort" && req.method === "POST") {
    if (llmModel && llmModel.instance) {
      try {
        await llmModel.instance.abort();
      } catch {}
    }
    events.emit("abort");
    return json(res, 200, { status: "aborted" });
  }

  // 404
  json(res, 404, { error: "Not found" });
});

server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
  console.log(`[Bridge] QVAC Bridge Service running on ${BRIDGE_HOST}:${BRIDGE_PORT}`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("[Bridge] Shutting down...");
  if (llmModel) {
    try { await llmModel.instance.unload(); } catch {}
    try { await llmModel.loader.close(); } catch {}
  }
  if (embedModel) {
    try { await embedModel.instance.unload(); } catch {}
    try { await embedModel.loader.close(); } catch {}
  }
  server.close();
  process.exit(0);
});
