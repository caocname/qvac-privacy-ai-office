"""
对话 API — 多轮会话 + RAG 增强 + 流式 LLM 推理。
"""
from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType
from backend.services.context_manager import ChatMessage, ContextManager
from backend.services.llm_service import get_llm_service
from backend.services.rag_service import RAGService
from backend.services.session_manager import SessionManager
from backend.state_machine import StateCode, get_state_manager

router = APIRouter(prefix="/api/v1/chat", tags=["chat"])


class ChatRequest(BaseModel):
    api_version: str = "v1"
    session_id: str = Field(..., description="会话 ID")
    message: str = Field(..., min_length=1, max_length=8192)
    enable_rag: bool = Field(default=True, description="是否启用 RAG 检索增强")
    isolate_mode: str = Field(default="session", description="对话隔离模式: global | session | temp")


class ChatCreateSession(BaseModel):
    api_version: str = "v1"
    title: str = Field(default="新会话")


@router.post("/session")
async def create_session(req: ChatCreateSession):
    """创建新会话。"""
    result = SessionManager.create(title=req.title)
    get_audit_logger().log(LogType.SESSION, {
        "event": "session_created",
        "session_id": result["session_id"],
    })
    return {"code": StateCode.IDLE.value, "status": StateCode.IDLE.name, "data": result}


@router.get("/sessions")
async def list_sessions():
    """列出所有会话。"""
    sessions = SessionManager.list_sessions()
    return {"code": StateCode.IDLE.value, "status": StateCode.IDLE.name, "data": sessions}


@router.get("/history")
async def get_history(session_id: str = Query(...)):
    """获取会话历史消息。"""
    history = SessionManager.get_history(session_id)
    return {"code": StateCode.IDLE.value, "status": StateCode.IDLE.name, "data": history}


@router.post("/session/close")
async def close_session(session_id: str = Query(...)):
    """关闭会话 — 清空 Temp 文档 + 永久删除会话记录。

    PRD §3.4: Temp 模态会话切换时必须物理强制销毁向量索引、分片缓存及上下文。
    """
    from backend.services.rag_service import RAGService

    purged = RAGService.purge_temp_for_session(session_id)
    SessionManager.delete(session_id)

    get_audit_logger().log(LogType.SESSION, {
        "event": "session_closed",
        "session_id": session_id,
        "temp_docs_purged": purged,
    })

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": {
            "session_id": session_id,
            "temp_documents_purged": purged,
            "message": f"会话已永久删除，清理了 {purged} 个临时文档。",
        },
    }


@router.post("/session/rename")
async def rename_session(session_id: str = Query(...), title: str = Query(..., min_length=1, max_length=256)):
    """重命名会话标题。"""
    SessionManager.rename(session_id, title)

    get_audit_logger().log(LogType.SESSION, {
        "event": "session_renamed",
        "session_id": session_id,
        "title": title,
    })

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": {
            "session_id": session_id,
            "title": title,
        },
    }


@router.post("/session/switch")
async def switch_session(
    from_session_id: str = Query(...),
    to_session_id: str = Query(...),
):
    """切换会话 — 销毁源会话 Temp 文档缓存。"""
    from backend.services.rag_service import RAGService

    purged = RAGService.purge_temp_for_session(from_session_id)

    get_audit_logger().log(LogType.SESSION, {
        "event": "session_switched",
        "from_session": from_session_id,
        "to_session": to_session_id,
        "temp_docs_purged": purged,
    })

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": {
            "from_session": from_session_id,
            "to_session": to_session_id,
            "temp_documents_purged": purged,
        },
    }


@router.post("/send")
async def send_message(req: ChatRequest):
    """发送消息 — 流式 SSE 响应。

    流程:
    1. 保存用户消息到 chat_records
    2. RAG 检索（若 enable_rag=True）
    3. 上下文窗口截断（OOM 防护）
    4. 调用 Bridge LLM 流式推理
    5. SSE 逐 token 推送至前端
    """
    state_mgr = get_state_manager()
    logger = get_audit_logger()
    context_mgr = ContextManager()

    # 1. 保存用户消息
    user_msg_id = SessionManager.append_message(req.session_id, "user", req.message)

    # 2. RAG 检索
    rag_chunks: list[str] = []
    rag_metas: list[str] = []
    if req.enable_rag:
        state_mgr.transition(StateCode.RETRIEVING)
        rag_service = RAGService()

        # 尝试获取 query embedding 并检索
        llm = get_llm_service()
        embeddings = await llm.embed([req.message])
        if embeddings:
            import numpy as np
            result = rag_service.retrieve(
                np.array(embeddings[0]),
                isolate_mode=req.isolate_mode,
                session_id=req.session_id,
            )
            if result["code"] != 145:
                rag_chunks = [c["content"] for c in result.get("chunks", [])]
                rag_metas = [
                    f"[来源: {c.get('file_name', '未知')} #Chunk-{c.get('chunk_index', '?')}]"
                    for c in result.get("chunks", [])
                ]

        if not rag_chunks:
            logger.log(LogType.RAG_RETRIEVAL, {
                "session_id": req.session_id,
                "result": "no_match",
                "code": 145,
            })
    # 3. 构建上下文窗口
    history = SessionManager.get_history(req.session_id)
    history_messages = [
        ChatMessage(
            message_id=h["message_id"],
            role=h["role"],
            content=h["content"],
            token_count=ContextManager.estimate_tokens(h["content"]),
        )
        for h in history[:-1]  # 排除刚保存的用户消息
    ]

    current_msg = ChatMessage(
        message_id=user_msg_id,
        role="user",
        content=req.message,
        token_count=ContextManager.estimate_tokens(req.message),
    )

    rag_topk_tokens = sum(ContextManager.estimate_tokens(c) for c in rag_chunks)

    assembly = context_mgr.assemble(history_messages, current_msg, rag_chunks, rag_topk_tokens)

    # 4. 准备发给 LLM 的消息列表
    llm_messages = []
    for m in assembly.messages:
        llm_messages.append({"role": m.role, "content": m.content})

    rag_context = "\n\n".join(
        f"{rag_chunks[i]}\n{rag_metas[i]}" for i in range(len(rag_chunks))
    ) if rag_chunks else ""

    # 5. 流式推理
    state_mgr.transition(StateCode.LLM_GENERATING)

    async def event_stream():
        llm_svc = get_llm_service()
        full_response = ""

        try:
            async for chunk in llm_svc.chat_stream(
                messages=llm_messages,
                rag_context=rag_context,
                max_tokens=2048,
                temperature=0.7,
            ):
                if chunk.get("done"):
                    if "error" in chunk:
                        err_payload = json.dumps({"done": True, "error": chunk["error"]})
                        yield f"data: {err_payload}\n\n"
                    else:
                        full_response = chunk.get("full_text") or full_response
                        stats = chunk.get("stats", {})
                        # 保存助手回复
                        assistant_msg_id = SessionManager.append_message(
                            req.session_id, "assistant", full_response,
                            token_count=ContextManager.estimate_tokens(full_response),
                        )
                        done_payload = json.dumps({
                            "done": True,
                            "message_id": assistant_msg_id,
                            "full_text": full_response,
                            "memory_truncated": assembly.memory_truncated,
                            "truncated_message_ids": assembly.truncated_message_ids,
                            "stats": stats,
                            "_debug": chunk.get("_debug"),
                        })
                        yield f"data: {done_payload}\n\n"
                        logger.log(LogType.INFERENCE_SAMPLE, {
                            "session_id": req.session_id,
                            "message_id": assistant_msg_id,
                            "tokens_per_second": stats.get("tokens_per_second", 0),
                        }, full_response[:200])
                    break
                else:
                    token_payload = json.dumps({"token": chunk["token"]})
                    yield f"data: {token_payload}\n\n"

        except Exception as exc:
            logger.log(LogType.ERROR, {
                "session_id": req.session_id,
                "error_class": type(exc).__name__,
            }, str(exc))
            err_payload = json.dumps({"done": True, "error": str(exc)})
            yield f"data: {err_payload}\n\n"
        finally:
            state_mgr.transition(StateCode.IDLE)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
