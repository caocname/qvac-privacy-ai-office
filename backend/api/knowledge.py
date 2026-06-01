"""
知识库 API — 文档上传、解析、分片、向量化、多隔离模式。
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, Form
from pydantic import BaseModel, Field

from backend.config import UPLOAD_DIR, RAG_CHUNK_SIZE, RAG_CHUNK_OVERLAP
from backend.database.connection import DatabaseManager
from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType
from backend.services.llm_service import get_llm_service
from backend.services.rag_service import RAGService
from backend.state_machine import StateCode, get_state_manager

router = APIRouter(prefix="/api/v1/knowledge", tags=["knowledge"])


class UploadRequest(BaseModel):
    api_version: str = "v1"
    file_payload_token: str = Field(..., description="安全层映射的 file_id token")
    file_type: str = Field(..., description="文件类型: pdf, docx, txt")
    isolate_mode: str = Field(default="session", description="隔离模式: global | session | temp")
    session_id: str | None = Field(default=None, description="isolate_mode=session 时必填")


def _extract_text_from_txt(file_path: Path) -> str:
    for enc in ["utf-8", "gbk", "gb2312", "latin-1"]:
        try:
            return file_path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return ""


def _extract_text_from_pdf(file_path: Path) -> str:
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(str(file_path))
        text_parts = []
        for page in doc:
            text_parts.append(page.get_text())
        doc.close()
        return "\n".join(text_parts)
    except ImportError:
        pass
    try:
        from pdfminer.high_level import extract_text
        return extract_text(str(file_path))
    except ImportError:
        pass
    return ""


def _extract_text_from_docx(file_path: Path) -> str:
    try:
        from docx import Document
        doc = Document(str(file_path))
        return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    except ImportError:
        pass
    return ""


def _chunk_text(text: str, chunk_size: int = RAG_CHUNK_SIZE, overlap: int = RAG_CHUNK_OVERLAP) -> list[str]:
    """简单分片：按段落优先，超过 chunk_size 的段落按句子切分。"""
    paragraphs = text.split("\n")
    chunks = []
    current = ""
    current_tokens = 0

    for para in paragraphs:
        para_tokens = RAGService._estimate_tokens(para)
        if current_tokens + para_tokens > chunk_size and current:
            chunks.append(current.strip())
            current = para
            current_tokens = para_tokens
        else:
            current = (current + "\n" + para).strip() if current else para
            current_tokens += para_tokens

    if current.strip():
        chunks.append(current.strip())

    # 如果分片太少，按固定大小再切
    if len(chunks) <= 1 and len(text) > 500:
        chunks = []
        for i in range(0, len(text), chunk_size * 2):
            chunks.append(text[i:i + chunk_size * 3])

    return chunks


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    isolate_mode: str = Form(default="session"),
    session_id: str | None = Form(default=None),
):
    """知识库文件上传接口 — 完整管道：文件 → 解析 → 分片 → Embedding → FAISS"""
    state_mgr = get_state_manager()
    logger = get_audit_logger()
    state_mgr.transition(StateCode.FILE_UPLOADING)

    if isolate_mode == "session" and not session_id:
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "MISSING_SESSION_ID",
            "message": "session 隔离模式必须提供 session_id",
        }

    # 文件类型校验
    file_type = file.filename.rsplit(".", 1)[-1].lower() if file.filename else "txt"
    if file_type not in ("pdf", "docx", "txt"):
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "UNSUPPORTED_FILE_TYPE",
            "message": f"不支持的文件类型: {file_type}，仅支持 PDF、DOCX、TXT",
        }

    file_id = f"file-{uuid.uuid4().hex[:16]}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    file_path = UPLOAD_DIR / f"{file_id}.{file_type}"

    # 保存文件
    content = await file.read()
    file_path.write_bytes(content)

    file_size = len(content)

    logger.log(LogType.KNOWLEDGE_UPLOAD, {
        "file_id": file_id,
        "file_name": file.filename,
        "file_type": file_type,
        "file_size": file_size,
        "isolate_mode": isolate_mode,
        "session_id": session_id,
    }, f"Upload: {file.filename} ({file_size} bytes, {isolate_mode})")

    # 文件结构化提取
    state_mgr.transition(StateCode.FILE_PROCESSING)

    if file_type == "txt":
        extracted_text = _extract_text_from_txt(file_path)
    elif file_type == "pdf":
        extracted_text = _extract_text_from_pdf(file_path)
    elif file_type == "docx":
        extracted_text = _extract_text_from_docx(file_path)
    else:
        extracted_text = ""

    if not extracted_text.strip():
        # 清理失败的上传文件
        try:
            os.remove(file_path)
        except OSError:
            pass
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "EXTRACTION_FAILED",
            "message": "文件内容提取失败，文件可能已损坏或为空。",
        }

    # 文本分片
    chunks = _chunk_text(extracted_text)
    total_pages = max(1, len(chunks))

    # 向量化 + FAISS 写入
    state_mgr.set_worker(StateCode.EMBEDDING, True)

    llm = get_llm_service()
    embeddings = await llm.embed(chunks)

    if embeddings and len(embeddings) == len(chunks):
        import numpy as np
        rag = RAGService()
        indexed_count = rag.index_document(
            file_id=file_id,
            file_name=file.filename,
            chunks=chunks,
            embeddings=[np.array(e, dtype=np.float32) for e in embeddings],
        )
    else:
        indexed_count = 0

    state_mgr.set_worker(StateCode.EMBEDDING, False)

    # 写入 knowledge_base 表
    db = DatabaseManager.get_instance()
    cipher = db.cipher
    encrypted_path = cipher.encrypt(str(file_path)) if cipher else str(file_path)

    db.conn.execute(
        "INSERT INTO knowledge_base (file_id, file_name, file_path, file_size, total_pages, isolate_mode, session_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (file_id, file.filename, encrypted_path, file_size, total_pages, isolate_mode, session_id),
    )
    db.conn.commit()

    state_mgr.transition(StateCode.IDLE)

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": {
            "file_id": file_id,
            "file_name": file.filename,
            "total_pages": total_pages,
            "chunk_count": len(chunks),
            "indexed_count": indexed_count,
            "isolate_mode": isolate_mode,
        },
    }


@router.get("/list")
async def list_files(session_id: str | None = None):
    """列出知识库文件。"""
    db = DatabaseManager.get_instance()
    if session_id:
        rows = db.conn.execute(
            "SELECT file_id, file_name, file_size, total_pages, isolate_mode, session_id, is_deleted, create_time "
            "FROM knowledge_base WHERE (isolate_mode = 'global' OR session_id = ?) AND is_deleted = 0 "
            "ORDER BY create_time DESC",
            (session_id,),
        ).fetchall()
    else:
        rows = db.conn.execute(
            "SELECT file_id, file_name, file_size, total_pages, isolate_mode, session_id, is_deleted, create_time "
            "FROM knowledge_base WHERE is_deleted = 0 ORDER BY create_time DESC"
        ).fetchall()

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": [
            {
                "file_id": r[0], "file_name": r[1], "file_size": r[2],
                "total_pages": r[3], "isolate_mode": r[4], "session_id": r[5],
                "is_deleted": r[6], "create_time": r[7],
            }
            for r in rows
        ],
    }


@router.delete("/delete")
async def delete_file(file_id: str):
    """三步物理删除：is_deleted=1 → 异步 os.remove → 冷启动清扫"""
    db = DatabaseManager.get_instance()
    row = db.conn.execute(
        "SELECT file_path FROM knowledge_base WHERE file_id = ? AND is_deleted = 0",
        (file_id,),
    ).fetchone()
    if not row:
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "message": "文件不存在或已删除",
        }

    # Step 1: 原子打标
    db.conn.execute("UPDATE knowledge_base SET is_deleted = 1 WHERE file_id = ?", (file_id,))
    db.conn.commit()

    # Step 2: 异步物理擦除 (ThreadPoolExecutor)
    from concurrent.futures import ThreadPoolExecutor
    executor = ThreadPoolExecutor(max_workers=1)

    cipher = db.cipher
    encrypted_path = row[0]
    try:
        actual_path = cipher.decrypt(encrypted_path) if cipher else encrypted_path
    except Exception:
        actual_path = encrypted_path

    def _physical_delete():
        try:
            os.remove(actual_path)
        except OSError:
            pass
        # 清除 rag_chunks
        try:
            db.conn.execute("DELETE FROM rag_chunks WHERE file_id = ?", (file_id,))
            db.conn.commit()
        except Exception:
            pass

    executor.submit(_physical_delete)

    get_audit_logger().log(LogType.KNOWLEDGE_DELETE, {
        "file_id": file_id,
        "event": "logical_delete_committed",
    })

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "message": "文件已标记删除，后台异步擦除中。",
    }
