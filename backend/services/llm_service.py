"""
LLM 推理服务 — 通过 Bridge HTTP API 调用 QVAC SDK。
支持 SSE 流式响应，与 RAG 检索结果拼接上下文。
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, AsyncGenerator

import httpx

from backend.config import (
    SYSTEM_PROMPT,
    RAG_TOPK,
    BACKEND_HOST,
)
from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType, InferenceMetric
from backend.state_machine import StateCode, get_state_manager

BRIDGE_URL = "http://127.0.0.1:18889"


class LLMService:
    """LLM 推理编排器 — 桥接 Bridge 服务与后端 API。"""

    def __init__(self):
        self._bridge_url = BRIDGE_URL
        self.is_llm_loaded = False
        self.is_embed_loaded = False

    async def ping(self) -> bool:
        """仅检查 Bridge HTTP 服务是否可达（不要求模型已加载）。"""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"{self._bridge_url}/health", timeout=2.0)
                return resp.status_code == 200
        except Exception:
            return False

    async def health(self) -> bool:
        """检查 Bridge 模型是否已全部加载就绪。"""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"{self._bridge_url}/health", timeout=2.0)
                if resp.status_code != 200:
                    return False
                data = resp.json()
                models = data.get("models", {})
                self.is_llm_loaded = models.get("llm_loaded", False)
                self.is_embed_loaded = models.get("embed_loaded", False)
                return self.is_llm_loaded and self.is_embed_loaded
        except Exception:
            return False

    async def load_model(self, model_name: str | None = None) -> bool:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{self._bridge_url}/api/llm/load",
                    json={"model_name": model_name or "Llama-3.2-1B-Instruct-Q4_0.gguf"},
                    timeout=120.0,
                )
                ok = resp.status_code == 200
                self.is_llm_loaded = ok
                return ok
        except Exception:
            return False

    async def load_embed_model(self, model_name: str | None = None) -> bool:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{self._bridge_url}/api/embed/load",
                    json={"model_name": model_name or "gte-large_fp16.gguf"},
                    timeout=120.0,
                )
                ok = resp.status_code == 200
                self.is_embed_loaded = ok
                return ok
        except Exception:
            return False

    async def unload_model(self) -> bool:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(f"{self._bridge_url}/api/llm/unload", timeout=10.0)
                return resp.status_code == 200
        except Exception:
            return False

    async def abort(self) -> bool:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(f"{self._bridge_url}/api/llm/abort", timeout=5.0)
                return resp.status_code == 200
        except Exception:
            return False

    async def embed(self, texts: list[str]) -> list[list[float]]:
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{self._bridge_url}/api/embed",
                    json={"texts": texts},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return data.get("embeddings", [])
        except Exception:
            pass
        return []

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        rag_context: str = "",
        max_tokens: int = 1024,
        temperature: float = 0.5,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """流式 LLM 推理 — 逐 token 产出 dict, 最终 dict 含 stats。"""
        logger = get_audit_logger()
        logger.log(LogType.INFERENCE_START, {
            InferenceMetric.PROMPT_TOKENS: sum(len(m.get("content", "")) // 4 for m in messages),
            InferenceMetric.MODEL_ID: "qvac-llamacpp",
        })

        # 主动检查 Bridge LLM 状态，带重试（模型可能正在后台加载中）
        llm_ready = False
        for attempt in range(10):
            await self.health()
            if self.is_llm_loaded:
                llm_ready = True
                break
            if attempt < 9:
                await asyncio.sleep(2.0)
        if not llm_ready:
            # 最后尝试触发一次加载
            logger.log(LogType.SYSTEM, {"event": "llm_not_ready_attempting_load"})
            await self.load_model()
            await self.health()
            if not self.is_llm_loaded:
                yield {"done": True, "error": "LLM 模型尚未加载完成，请等待后台加载完毕后重试（通常需要 30-60 秒）。"}
                return

        # 合并系统提示词与 RAG 上下文为单条 system 消息，避免 1B 小模型在多 system 消息下产生重复
        system_content = SYSTEM_PROMPT
        if rag_context:
            system_content += f"\n\n【本次检索到的参考片段 — 回答必须基于此内容】\n{rag_context}"

        full_messages = [{"role": "system", "content": system_content}]
        full_messages.extend(messages)

        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream(
                    "POST",
                    f"{self._bridge_url}/api/llm/chat",
                    json={
                        "messages": full_messages,
                        "max_tokens": max_tokens,
                        "temperature": temperature,
                        "repeat_penalty": 1.15,
                        "frequency_penalty": 0.4,
                    },
                ) as resp:
                    full_text = ""
                    has_data = False
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        has_data = True
                        try:
                            chunk = json.loads(line[6:])
                        except json.JSONDecodeError:
                            continue

                        if chunk.get("done"):
                            if "error" in chunk:
                                logger.log(LogType.ERROR, {"error": chunk["error"]})
                                yield {"done": True, "error": chunk["error"]}
                                return
                            stats = chunk.get("stats", {})
                            # 兜底：若 SSE 流中 full_text 为空但之前累积了 token，使用累积文本
                            final_text = chunk.get("full_text", "") or full_text
                            logger.log(LogType.INFERENCE_END, {
                                InferenceMetric.TOKENS_PER_SECOND: stats.get("tokens_per_second", 0),
                                InferenceMetric.TOTAL_DURATION_MS: stats.get("total_duration_ms", 0),
                                InferenceMetric.COMPLETION_TOKENS: stats.get("total_tokens", 0),
                            })
                            yield {"done": True, "full_text": final_text, "stats": stats, "_debug": chunk.get("_debug")}
                            return

                        if "error" in chunk:
                            logger.log(LogType.ERROR, {"error": chunk["error"]})
                            yield {"done": True, "error": chunk["error"]}
                            return

                        token = chunk.get("token", "")
                        if token:
                            full_text += token
                            yield {"token": token}

                    if not has_data:
                        yield {"done": True, "error": "Bridge 无响应"}

        except Exception as exc:
            logger.log(LogType.ERROR, {"error_class": type(exc).__name__, "message": str(exc)})
            yield {"done": True, "error": str(exc)}


_llm_service: LLMService | None = None


def get_llm_service() -> LLMService:
    global _llm_service
    if _llm_service is None:
        _llm_service = LLMService()
    return _llm_service
