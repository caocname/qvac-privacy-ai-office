/**
 * QVAC Bare Worker — 在 Bare 运行时内加载原生推理插件。
 * 通过 stdin/stdout (fd 0/1) JSON 协议与 Node.js Bridge 通信。
 *
 * V0.3: 使用官方 response.iterate() 异步迭代 API 替代事件监听，
 * 解决 AI 对话空响应问题。
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

// 写队列串行化所有 stdout 写入，避免并发 fs.write 导致输出乱序/截断
let writeQueue = Promise.resolve()

function writeStdout(str) {
  writeQueue = writeQueue.then(() => {
    const data = Buffer.from(str)
    return fs.write(STDOUT_FD, data)
  }).catch(() => {})
  return writeQueue
}

function writeStderr(str) {
  const data = Buffer.from(str)
  fs.write(STDERR_FD, data).catch(() => {})
}

function respond(id, result) {
  return writeStdout(JSON.stringify({ id, result }) + '\n')
}

function respondError(id, error) {
  return writeStdout(JSON.stringify({ id, error }) + '\n')
}

function streamEvent(id, event, data) {
  return writeStdout(JSON.stringify({ id, event, data }) + '\n')
}

// ---- Stdin polling ----
const readBuf = Buffer.alloc(65536)
let lineBuf = ''
let polling = false

async function pollStdin() {
  if (polling) return
  polling = true
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
          await handleMessage(msg)
        } catch (_) {}
      }
    }
  } catch (_) {
    // No data available — normal in polling mode
  } finally {
    polling = false
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
        writeStderr('[Worker] Loading LLM: ' + modelPath + '\n')

        llmInstance = new LlamaLlamacpp({
          files: { model: [modelPath] },
          config: {
            device: 'cpu',
            ctx_size: 4096,
            temp: 0.7,
          },
        })
        await llmInstance.load()
        writeStderr('[Worker] LLM loaded successfully\n')
        return respond(id, { status: 'loaded', model: modelPath })
      }

      case 'load_embed': {
        if (embedInstance) {
          try { await embedInstance.unload() } catch (_) {}
        }
        const modelPath = params.modelPath
        writeStderr('[Worker] Loading Embed: ' + modelPath + '\n')

        embedInstance = new GGMLBert({
          files: { model: [modelPath] },
          config: { device: 'cpu' },
        })
        await embedInstance.load()
        writeStderr('[Worker] Embed loaded successfully\n')
        return respond(id, { status: 'loaded', model: modelPath })
      }

      case 'chat': {
        if (!llmInstance) {
          return respondError(id, 'LLM model not loaded')
        }
        const { messages, maxTokens, temperature } = params

        const startTime = Date.now()
        let fullText = ''

        const chatMessages = messages.map(function (m) {
          return { role: m.role, content: m.content }
        })

        writeStderr('[Worker] chat starting — messages=' + chatMessages.length +
          ' maxTokens=' + maxTokens + ' temp=' + temperature + '\n')

        const response = await llmInstance.run(chatMessages, {
          generationParams: {
            predict: maxTokens || 2048,
            temp: temperature || 0.7,
          },
        })

        // 使用官方 iterate() API 进行流式 token 输出
        // 这是 QVAC SDK 推荐的模式，比事件监听更可靠
        try {
          for await (const token of response.iterate()) {
            fullText += token
            await streamEvent(id, 'token', { token })
          }
        } catch (iterErr) {
          writeStderr('[Worker] chat iterate error: ' + (iterErr.message || iterErr) + '\n')
          return respondError(id, iterErr.message || String(iterErr))
        }

        writeStderr('[Worker] chat done — fullText.length=' + fullText.length +
          ' output.length=' + (response.output ? response.output.length : 'nil') +
          ' stats=' + JSON.stringify(response.stats || {}) + '\n')

        // 兜底：如果 iterate 没有产生输出，从 response.output[] 恢复
        if (!fullText && response.output && response.output.length > 0) {
          fullText = response.output.join('')
          writeStderr('[Worker] chat fallback: restored ' + fullText.length + ' chars from response.output[]\n')
        }

        const totalDurationMs = Date.now() - startTime

        const stats = response.stats && response.stats.TPS
          ? {
              tokens_per_second: response.stats.TPS,
              total_tokens: response.stats.total_tokens || fullText.length,
              total_duration_ms: response.stats.total_duration_ms || totalDurationMs,
            }
          : {
              tokens_per_second: fullText.length / Math.max(totalDurationMs / 1000, 0.001),
              total_tokens: fullText.length,
              total_duration_ms: totalDurationMs,
            }

        return await respond(id, {
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
          const response = await embedInstance.run(texts[i])
          // 使用 await() 获取结果数组
          const result = await response.await()
          if (Array.isArray(result) && result.length > 0) {
            // result 是 output 数组，取第一个元素作为 embedding 向量
            const first = result[0]
            if (Array.isArray(first)) {
              embeddings.push(first)
            } else if (first && typeof first === 'object' && Array.isArray(first.embedding)) {
              embeddings.push(Array.from(first.embedding))
            } else if (typeof first === 'number') {
              // result 本身就是 embedding 向量
              embeddings.push(result)
            } else {
              embeddings.push([])
            }
          } else if (Array.isArray(result)) {
            embeddings.push(result)
          } else if (result && typeof result === 'object' && Array.isArray(result.embedding)) {
            embeddings.push(Array.from(result.embedding))
          } else {
            embeddings.push([])
          }
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
    writeStderr('[Worker] Error handling ' + method + ': ' + (err.message || String(err)) + '\n')
    return respondError(id, err.message || String(err))
  }
}

// ---- Main ----
writeStderr('[Worker] QVAC Bare Worker started (v0.3)\n')

// Poll stdin every 50ms
setInterval(pollStdin, 50)
