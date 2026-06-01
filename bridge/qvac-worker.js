/**
 * QVAC Bare Worker — 在 Bare 运行时内加载原生推理插件。
 * 通过 stdin/stdout (fd 0/1) JSON 协议与 Node.js Bridge 通信。
 */

import fs from 'bare-fs'
import LlamaLlamacpp from '@qvac/llm-llamacpp'
import GGMLBert from '@qvac/embed-llamacpp'

// ---- State ----
let llmInstance = null
let embedInstance = null

// ---- I/O helpers ----
const STDIN_FD = 0
const STDOUT_FD = 1
const STDERR_FD = 2

async function writeStdout(str) {
  const data = Buffer.from(str)
  await fs.write(STDOUT_FD, data)
}

async function writeStderr(str) {
  const data = Buffer.from(str)
  await fs.write(STDERR_FD, data)
}

function respond(id, result) {
  writeStdout(JSON.stringify({ id, result }) + '\n')
}

function respondError(id, error) {
  writeStdout(JSON.stringify({ id, error }) + '\n')
}

function streamEvent(id, event, data) {
  writeStdout(JSON.stringify({ id, event, data }) + '\n')
}

// ---- Stdin polling ----
const readBuf = Buffer.alloc(65536)
let lineBuf = ''

async function pollStdin() {
  try {
    const n = await fs.read(STDIN_FD, readBuf)
    if (n > 0) {
      const chunk = readBuf.toString('utf8', 0, n)
      lineBuf += chunk

      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() || ''

      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed)
          handleMessage(msg)
        } catch (_) {}
      }
    }
  } catch (err) {
    // No data available
  }
}

// ---- Message Router ----

async function handleMessage(msg) {
  const { id, method, params } = msg
  if (!id || !method) return

  try {
    switch (method) {
      case 'health':
        return respond(id, {
          llm_loaded: llmInstance !== null,
          embed_loaded: embedInstance !== null,
        })

      case 'load_llm': {
        if (llmInstance) {
          try { await llmInstance.unload() } catch (_) {}
        }
        const modelPath = params.modelPath
        llmInstance = new LlamaLlamacpp({
          files: { model: [modelPath] },
          config: {
            device: 'gpu',
            ctx_size: 8192,
            temp: 0.7,
          },
        })
        await llmInstance.load()
        return respond(id, { status: 'loaded', model: modelPath })
      }

      case 'load_embed': {
        if (embedInstance) {
          try { await embedInstance.unload() } catch (_) {}
        }
        const modelPath = params.modelPath
        embedInstance = new GGMLBert({
          files: { model: [modelPath] },
          config: { device: 'gpu' },
        })
        await embedInstance.load()
        return respond(id, { status: 'loaded', model: modelPath })
      }

      case 'chat': {
        if (!llmInstance) {
          return respondError(id, 'LLM model not loaded')
        }
        const { messages, maxTokens, temperature } = params

        const response = await llmInstance.run(
          messages.map(function (m) { return { role: m.role, content: m.content } }),
          {
            generationParams: {
              predict: maxTokens || 2048,
              temp: temperature || 0.7,
            },
          }
        )

        const startTime = Date.now()
        let fullText = ''

        response.on('output', function (text) {
          fullText += text
          streamEvent(id, 'token', { token: text })
        })

        const finalOutput = await response.await()
        const totalDurationMs = Date.now() - startTime
        const tokenCount = finalOutput ? finalOutput.length : 0

        const stats = response.stats && response.stats.TPS
          ? {
              tokens_per_second: response.stats.TPS,
              total_tokens: response.stats.total_tokens || tokenCount,
              total_duration_ms: response.stats.total_duration_ms || totalDurationMs,
            }
          : {
              tokens_per_second: tokenCount / Math.max(totalDurationMs / 1000, 0.001),
              total_tokens: tokenCount,
              total_duration_ms: totalDurationMs,
            }

        return respond(id, {
          done: true,
          full_text: fullText,
          stats: stats,
        })
      }

      case 'embed': {
        if (!embedInstance) {
          return respondError(id, 'Embedding model not loaded')
        }
        const { texts } = params
        const embeddings = []
        for (let i = 0; i < texts.length; i++) {
          const result = await embedInstance.run(texts[i])
          const emb = result.await ? await result.await() : result
          const arr = Array.isArray(emb) ? emb : (emb && emb.embedding ? Array.from(emb.embedding) : [])
          embeddings.push(arr)
        }
        return respond(id, { embeddings: embeddings })
      }

      case 'abort': {
        if (llmInstance) {
          try { await llmInstance.cancel() } catch (_) {}
        }
        if (embedInstance) {
          try { await embedInstance.cancel() } catch (_) {}
        }
        return respond(id, { status: 'aborted' })
      }

      case 'unload_llm': {
        if (llmInstance) {
          try { await llmInstance.unload() } catch (_) {}
          llmInstance = null
        }
        return respond(id, { status: 'unloaded' })
      }

      case 'unload_embed': {
        if (embedInstance) {
          try { await embedInstance.unload() } catch (_) {}
          embedInstance = null
        }
        return respond(id, { status: 'unloaded' })
      }

      default:
        return respondError(id, 'Unknown method: ' + method)
    }
  } catch (err) {
    return respondError(id, err.message || String(err))
  }
}

// ---- Main ----
writeStderr('[Worker] QVAC Bare Worker started\n')

// Poll stdin every 50ms
setInterval(pollStdin, 50)
