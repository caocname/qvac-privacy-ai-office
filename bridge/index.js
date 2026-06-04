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
  cancel,
  LLAMA_3_2_1B_INST_Q4_0,
  EMBEDDINGGEMMA_300M_Q4_0,
} from "@qvac/sdk";

// ---- Model state ----
let llmModelId = null;
let embedModelId = null;
let llmModelName = "";
let embedModelName = "";

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
        modelConfig: { ctx_size: 4096 },
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
    const maxTokens = body.max_tokens || 2048;
    const temperature = body.temperature || 0.7;

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
          _debug: null,
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
      await cancel({ modelId: llmModelId });
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
    });
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
  } catch {}
  server.close();
  process.exit(0);
});

main();
