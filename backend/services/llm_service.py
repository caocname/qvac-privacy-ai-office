"""
LLM 推理服务 — 通过 Bridge HTTP API 调用 QVAC SDK。
支持 SSE 流式响应，与 RAG 检索结果拼接上下文。
"""
from __future__ import annotations

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

    async def health(self) -> bool:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"{self._bridge_url}/health", timeout=2.0)
                return resp.status_code == 200
        except Exception:
            return False

    async def load_model(self, model_name: str | None = None) -> bool:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{self._bridge_url}/api/llm/load",
                    json={"model_name": model_name or "Llama-3.2-1B-Instruct-Q4_0.gguf"},
                    timeout=30.0,
                )
                return resp.status_code == 200
        except Exception:
            return False

    async def load_embed_model(self, model_name: str | None = None) -> bool:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{self._bridge_url}/api/embed/load",
                    json={"model_name": model_name or "gte-large_fp16.gguf"},
                    timeout=30.0,
                )
                return resp.status_code == 200
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
        max_tokens: int = 2048,
        temperature: float = 0.7,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """流式 LLM 推理 — 逐 token 产出 dict, 最终 dict 含 stats。"""
        logger = get_audit_logger()
        logger.log(LogType.INFERENCE_START, {
            InferenceMetric.PROMPT_TOKENS: sum(len(m.get("content", "")) // 4 for m in messages),
            InferenceMetric.MODEL_ID: "qvac-llamacpp",
        })

        # 拼接完整消息列表
        full_messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        full_messages.extend(messages)

        if rag_context:
            full_messages.append({
                "role": "system",
                "content": f"【参考片段 — 回答必须100%来源于此】\n{rag_context}",
            })

        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream(
                    "POST",
                    f"{self._bridge_url}/api/llm/chat",
                    json={
                        "messages": full_messages,
                        "max_tokens": max_tokens,
                        "temperature": temperature,
                    },
                ) as resp:
                    full_text = ""
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        try:
                            chunk = json.loads(line[6:])
                        except json.JSONDecodeError:
                            continue

                        if chunk.get("done"):
                            stats = chunk.get("stats", {})
                            logger.log(LogType.INFERENCE_END, {
                                InferenceMetric.TOKENS_PER_SECOND: stats.get("tokens_per_second", 0),
                                InferenceMetric.TOTAL_DURATION_MS: stats.get("total_duration_ms", 0),
                                InferenceMetric.COMPLETION_TOKENS: stats.get("total_tokens", 0),
                            })
                            yield {"done": True, "full_text": full_text, "stats": stats}
                            return

                        if "error" in chunk:
                            logger.log(LogType.ERROR, {"error": chunk["error"]})
                            yield {"done": True, "error": chunk["error"]}
                            return

                        token = chunk.get("token", "")
                        if token:
                            full_text += token
                            yield {"token": token}

        except Exception as exc:
            logger.log(LogType.ERROR, {"error_class": type(exc).__name__, "message": str(exc)})
            yield {"done": True, "error": str(exc)}


_llm_service: LLMService | None = None


def get_llm_service() -> LLMService:
    global _llm_service
    if _llm_service is None:
        _llm_service = LLMService()
    return _llm_service
