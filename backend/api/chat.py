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
    context_document_ids: list[str] = Field(default_factory=list, description="要加载全文到上下文的知识库文档 ID 列表")


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

    # 1.5 加载上下文文档全文（注入到 LLM 上下文中，类似 text1 附件机制）
    context_docs_text: str = ""
    # Llama tokenizer 中文 ~2-3 tokens/char, 2000 chars × 2.5 ≈ 5000 tokens
    # + system prompt (~500) + history (~500) ≈ 6000, 留 2000 余量在 8192 内
    MAX_DOC_CONTEXT_CHARS = 2000
    if req.context_document_ids:
        from backend.database.connection import DatabaseManager
        db = DatabaseManager.get_instance()
        doc_texts: list[str] = []
        for file_id in req.context_document_ids:
            file_row = db.conn.execute(
                "SELECT file_name FROM knowledge_base WHERE file_id = ? AND is_deleted = 0",
                (file_id,),
            ).fetchone()
            if not file_row:
                continue
            chunks = db.conn.execute(
                "SELECT content FROM rag_chunks WHERE file_id = ? ORDER BY chunk_index",
                (file_id,),
            ).fetchall()
            if chunks:
                doc_full = "\n".join(c[0] for c in chunks)
                doc_texts.append(f"【已加载文档: {file_row[0]}】\n\n{doc_full}")
        if doc_texts:
            combined = "\n\n---\n\n".join(doc_texts)
            if len(combined) > MAX_DOC_CONTEXT_CHARS:
                combined = combined[:MAX_DOC_CONTEXT_CHARS] + "\n\n[... 文档过长已截断 ...]"
            context_docs_text = combined
            logger.log(LogType.SYSTEM, {
                "session_id": req.session_id,
                "event": "context_docs_loaded",
                "doc_count": len(doc_texts),
                "total_chars": len(combined),
            })

    # 2. RAG 检索
    rag_chunks: list[str] = []
    rag_metas: list[str] = []
    rag_fallback_msg: str | None = None
    if req.enable_rag:
        state_mgr.transition(StateCode.RETRIEVING)
        rag_service = RAGService()

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
            else:
                rag_fallback_msg = result.get("message", "未在本地知识库中检索到匹配内容，请尝试更换关键词。")

        if not rag_chunks:
            logger.log(LogType.RAG_RETRIEVAL, {
                "session_id": req.session_id,
                "result": "no_match",
                "code": 145,
            })
            if rag_fallback_msg is None:
                rag_fallback_msg = "Embedding 模型未就绪，请等待 Bridge 模型加载完成后重试。"

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

    # 构建增强上下文：全量文档 + RAG 片段
    enhanced_context_parts: list[str] = []
    if context_docs_text:
        enhanced_context_parts.append(f"【已加载文档全文 — 回答必须基于此内容】\n{context_docs_text}")

    rag_context = "\n\n".join(
        f"{rag_chunks[i]}\n{rag_metas[i]}" for i in range(len(rag_chunks))
    ) if rag_chunks else ""
    if rag_context:
        enhanced_context_parts.append(f"【RAG 参考片段】\n{rag_context}")

    enhanced_context = "\n\n---\n\n".join(enhanced_context_parts) if enhanced_context_parts else ""

    # 5. 流式推理
    async def event_stream():
        state_mgr.transition(StateCode.LLM_GENERATING)
        llm_svc = get_llm_service()
        full_response = ""

        try:
            async for chunk in llm_svc.chat_stream(
                messages=llm_messages,
                rag_context=enhanced_context,
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
