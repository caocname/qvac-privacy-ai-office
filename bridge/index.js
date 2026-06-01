/**
 * QVAC Bridge Service — Node.js HTTP 服务器，通过 stdin/stdout JSON 协议
 * 与 Bare 运行时中的推理 Worker 通信。
 *
 * 仅绑定 127.0.0.1，遵守 R-01 离线合规铁律。
 */

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 18889;
const MODELS_DIR = path.join(__dirname, "..", "data", "models");
const BARE_EXE = path.join(__dirname, "bare.exe");
const WORKER_SCRIPT = path.join(__dirname, "qvac-worker.js");

// ---- Worker Management ----
let workerProc = null;
let workerReady = false;
let requestId = 0;
const pending = new Map(); // id -> { resolve, reject, onEvent }
let stdoutBuf = "";

function startWorker() {
  return new Promise((resolve, reject) => {
    workerProc = spawn(BARE_EXE, [WORKER_SCRIPT], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
    });

    workerProc.on("error", (err) => {
      console.error("[Bridge] Worker spawn error:", err.message);
      reject(err);
    });

    workerProc.on("exit", (code) => {
      console.error(`[Bridge] Worker exited with code ${code}`);
      workerReady = false;
      workerProc = null;
    });

    workerProc.stderr.on("data", (chunk) => {
      process.stderr.write(`[Worker] ${chunk}`);
    });

    workerProc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          handleWorkerMessage(msg);
        } catch {}
      }
    });

    // Worker is ready when it writes to stderr
    const checkReady = (chunk) => {
      if (chunk.toString().includes("started")) {
        workerReady = true;
        resolve();
      }
    };
    workerProc.stderr.on("data", checkReady);

    // Timeout after 10s
    setTimeout(() => {
      if (!workerReady) {
        workerReady = true; // Assume ready anyway
        resolve();
      }
    }, 10000);
  });
}

function handleWorkerMessage(msg) {
  if (msg.id && msg.event) {
    // Streaming event
    const req = pending.get(msg.id);
    if (req && req.onEvent) {
      req.onEvent(msg.event, msg.data);
    }
    return;
  }

  if (msg.id) {
    const req = pending.get(msg.id);
    if (!req) return;
    pending.delete(msg.id);

    if (msg.error) {
      req.reject(new Error(msg.error));
    } else {
      req.resolve(msg.result);
    }
  }
}

function sendToWorker(method, params, onEvent) {
  return new Promise((resolve, reject) => {
    const id = String(++requestId);
    pending.set(id, { resolve, reject, onEvent: onEvent || null });
    workerProc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

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

// ---- Model state ----
let llmLoaded = false;
let embedLoaded = false;
let llmModelName = "";
let embedModelName = "";

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
        llm_loaded: llmLoaded,
        llm_model: llmModelName,
        embed_loaded: embedLoaded,
        embed_model: embedModelName,
      },
    });
  }

  // ---- LLM Load ----
  if (url.pathname === "/api/llm/load" && req.method === "POST") {
    const body = await readBody(req);
    const modelName = body.model_name || "Llama-3.2-1B-Instruct-Q4_0.gguf";
    try {
      const result = await sendToWorker("load_llm", {
        modelPath: path.join(MODELS_DIR, modelName),
      });
      llmLoaded = true;
      llmModelName = modelName;
      return json(res, 200, { status: "loaded", model: modelName, ...result });
    } catch (err) {
      return json(res, 500, { status: "error", message: err.message });
    }
  }

  // ---- LLM Unload ----
  if (url.pathname === "/api/llm/unload" && req.method === "POST") {
    try {
      await sendToWorker("unload_llm", {});
    } catch {}
    llmLoaded = false;
    llmModelName = "";
    return json(res, 200, { status: "unloaded" });
  }

  // ---- LLM Chat (Streaming) ----
  if (url.pathname === "/api/llm/chat" && req.method === "POST") {
    if (!llmLoaded) {
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
      const chatPromise = sendToWorker(
        "chat",
        { messages, maxTokens, temperature },
        (event, data) => {
          if (event === "token") {
            res.write(`data: ${JSON.stringify({ token: data.token })}\n\n`);
          }
        }
      );

      const final = await chatPromise;
      res.write(
        `data: ${JSON.stringify({
          done: true,
          full_text: final.full_text,
          stats: final.stats,
        })}\n\n`
      );
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    return res.end();
  }

  // ---- Embedding ----
  if (url.pathname === "/api/embed" && req.method === "POST") {
    if (!embedLoaded) {
      return json(res, 503, { error: "Embedding model not loaded" });
    }
    const body = await readBody(req);
    try {
      const result = await sendToWorker("embed", { texts: body.texts || [] });
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ---- Embed Load ----
  if (url.pathname === "/api/embed/load" && req.method === "POST") {
    const body = await readBody(req);
    const modelName = body.model_name || "gte-large_fp16.gguf";
    try {
      const result = await sendToWorker("load_embed", {
        modelPath: path.join(MODELS_DIR, modelName),
      });
      embedLoaded = true;
      embedModelName = modelName;
      return json(res, 200, { status: "loaded", model: modelName, ...result });
    } catch (err) {
      return json(res, 500, { status: "error", message: err.message });
    }
  }

  // ---- Model Status ----
  if (url.pathname === "/api/models/status" && req.method === "GET") {
    return json(res, 200, {
      llm_loaded: llmLoaded,
      llm_model: llmModelName,
      embed_loaded: embedLoaded,
      embed_model: embedModelName,
    });
  }

  // ---- Abort ----
  if (url.pathname === "/api/llm/abort" && req.method === "POST") {
    try { await sendToWorker("abort", {}); } catch {}
    return json(res, 200, { status: "aborted" });
  }

  // 404
  json(res, 404, { error: "Not found" });
});

// ---- Startup ----
async function main() {
  console.log("[Bridge] Starting QVAC Bare Worker...");
  try {
    await startWorker();
    console.log("[Bridge] Worker ready");
  } catch (err) {
    console.error("[Bridge] Failed to start worker:", err.message);
    process.exit(1);
  }

  server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.log(`[Bridge] QVAC Bridge Service on ${BRIDGE_HOST}:${BRIDGE_PORT}`);
  });
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("[Bridge] Shutting down...");
  if (workerProc) {
    try { await sendToWorker("unload_llm", {}); } catch {}
    try { await sendToWorker("unload_embed", {}); } catch {}
    workerProc.kill();
  }
  server.close();
  process.exit(0);
});

main();
