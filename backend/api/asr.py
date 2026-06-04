"""
ASR 异步音频转写 API — 异步投递 + 2s 轮询。
通过 Bridge (QVAC SDK whispercpp) 执行本地转写。
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import APIRouter, Query, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from backend.config import UPLOAD_DIR
from backend.database.connection import DatabaseManager
from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType
from backend.state_machine import StateCode, get_state_manager

router = APIRouter(prefix="/api/v1/asr", tags=["asr"])

# 内存 ASR 任务表
_asr_tasks: dict[str, dict] = {}
_asr_executor = ThreadPoolExecutor(max_workers=1)


class ASRSubmitRequest(BaseModel):
    api_version: str = "v1"
    audio_path: str = Field(..., description="音频文件本地路径")
    audio_type: str = Field(default="wav", description="仅支持标准无损 WAV")


def _validate_wav(file_path: str) -> bool:
    """验证 WAV 文件头 (RIFF/WAVE)。"""
    try:
        with open(file_path, "rb") as f:
            header = f.read(44)
            if len(header) < 44:
                return False
            return header[:4] == b"RIFF" and header[8:12] == b"WAVE"
    except Exception:
        return False


def _estimate_wav_duration(file_path: str) -> float:
    """从 WAV 头估算音频时长（秒）。"""
    try:
        import struct
        with open(file_path, "rb") as f:
            header = f.read(44)
            if len(header) < 44:
                return 0.0
            sample_rate = struct.unpack("<I", header[24:28])[0]
            byte_rate = struct.unpack("<I", header[28:32])[0]
            file_size = os.path.getsize(file_path)
            if byte_rate > 0:
                return (file_size - 44) / byte_rate
            return 0.0
    except Exception:
        return 0.0


def _do_transcribe(task_id: str, audio_path: str) -> None:
    """在 ThreadPoolExecutor 中执行 ASR 转写，通过 Bridge HTTP API 调用 QVAC SDK whispercpp。"""
    logger = get_audit_logger()
    task = _asr_tasks.get(task_id)
    if not task:
        return

    audio_duration = _estimate_wav_duration(audio_path)
    task["duration"] = audio_duration
    estimated_time = max(audio_duration * 1.5, 5.0)
    task["remaining_time_s"] = estimated_time

    start_time = time.time()

    def _update_progress():
        nonlocal start_time
        while not task.get("completed"):
            elapsed = time.time() - start_time
            if estimated_time > 0:
                progress = min(elapsed / estimated_time * 100.0, 99.0)
                task["progress_percent"] = round(progress, 1)
                task["remaining_time_s"] = max(estimated_time - elapsed, 0.0)
            time.sleep(2.0)

    progress_thread = threading.Thread(target=_update_progress, daemon=True)
    progress_thread.start()

    transcribed = ""
    try:
        import httpx
        with httpx.Client(timeout=600.0) as client:
            resp = client.post(
                "http://127.0.0.1:18889/api/asr/transcribe",
                json={"audio_path": audio_path, "language": "zh"},
            )
            if resp.status_code == 200:
                data = resp.json()
                transcribed = data.get("text", "")
    except Exception as exc:
        logger.log(LogType.ERROR, {
            "task_id": task_id,
            "error_class": type(exc).__name__,
        }, str(exc))
        transcribed = f"[ASR 失败] Bridge 转写异常: {str(exc)[:200]}"

    if not transcribed:
        transcribed = "[ASR 未就绪] Bridge 未连接或 whisper 模型未加载。启动 Bridge 后首次转写将自动加载模型。"

    task["progress_percent"] = 100.0
    task["remaining_time_s"] = 0.0
    task["completed"] = True
    task["transcribed_text"] = transcribed

    # 写入 asr_archive 表
    archive_id = f"arc-{uuid.uuid4().hex[:12]}"
    task["archive_id"] = archive_id

    db = DatabaseManager.get_instance()
    cipher = db.cipher
    enc_text = cipher.encrypt(transcribed) if cipher else transcribed
    enc_path = cipher.encrypt(audio_path) if cipher else audio_path

    audio_name = Path(audio_path).name
    db.conn.execute(
        "INSERT INTO asr_archive (archive_id, task_id, audio_name, audio_path, duration, transcribed_text) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (archive_id, task_id, audio_name, enc_path, audio_duration, enc_text),
    )
    db.conn.commit()

    logger.log(LogType.ASR_PROCESSING, {
        "task_id": task_id,
        "archive_id": archive_id,
        "event": "task_completed",
        "duration": audio_duration,
    }, f"ASR completed: {transcribed[:100]}...")


@router.post("/submit")
async def submit(req: ASRSubmitRequest):
    """异步 ASR 任务投递接口 — 技术需求文档 4.2.1"""
    # 音频格式校验
    if req.audio_type.lower() != "wav":
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "UNSUPPORTED_AUDIO_FORMAT",
            "message": "Local ASR pipeline only supports standard lossless WAV files.",
        }

    if not os.path.exists(req.audio_path):
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "FILE_NOT_FOUND",
            "message": f"Audio file not found: {req.audio_path}",
        }

    # WAV 文件头校验
    if not _validate_wav(req.audio_path):
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "INVALID_WAV_FORMAT",
            "message": "文件不是有效的 WAV 格式。仅支持标准无损 WAV 音频。",
        }

    # 估算音频时长
    estimated_duration = _estimate_wav_duration(req.audio_path)

    state_mgr = get_state_manager()
    state_mgr.set_worker(StateCode.ASR_PROCESSING, True)

    task_id = f"task-asr-{uuid.uuid4().hex[:12]}"
    _asr_tasks[task_id] = {
        "task_id": task_id,
        "progress_percent": 0.0,
        "remaining_time_s": max(estimated_duration * 1.5, 5.0),
        "completed": False,
        "archive_id": None,
        "transcribed_text": None,
        "duration": estimated_duration,
    }

    # 投递到线程池
    _asr_executor.submit(_do_transcribe, task_id, req.audio_path)

    get_audit_logger().log(LogType.ASR_PROCESSING, {
        "task_id": task_id,
        "audio_type": req.audio_type,
        "event": "task_submitted",
    }, f"ASR task submitted: {req.audio_path}")

    return {
        "code": StateCode.ASR_PROCESSING.value,
        "status": StateCode.ASR_PROCESSING.name,
        "data": {
            "task_id": task_id,
            "estimated_duration_s": estimated_duration,
        },
    }


@router.post("/upload")
async def asr_upload(file: UploadFile = File(...)):
    """ASR 文件上传接口 — 接受 WAV 文件上传，保存后异步转写。

    解决前端无法获取本地文件路径的问题。
    """
    # 格式校验
    ext = (file.filename.rsplit(".", 1)[-1] or "").lower() if file.filename else ""
    if ext != "wav":
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "UNSUPPORTED_AUDIO_FORMAT",
            "message": "仅支持标准 WAV 格式音频文件。",
        }

    # 保存到 ASR 专用上传目录
    asr_upload_dir = UPLOAD_DIR / "asr"
    asr_upload_dir.mkdir(parents=True, exist_ok=True)
    task_id = f"task-asr-{uuid.uuid4().hex[:12]}"
    audio_path = asr_upload_dir / f"{task_id}.wav"

    try:
        content = await file.read()
        audio_path.write_bytes(content)
    except Exception as exc:
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "FILE_SAVE_FAILED",
            "message": f"音频文件保存失败: {str(exc)}",
        }

    # WAV 文件头校验
    if not _validate_wav(str(audio_path)):
        try:
            os.remove(str(audio_path))
        except OSError:
            pass
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "INVALID_WAV_FORMAT",
            "message": "文件不是有效的 WAV 格式。仅支持标准无损 WAV 音频。",
        }

    # 估算时长
    estimated_duration = _estimate_wav_duration(str(audio_path))

    state_mgr = get_state_manager()
    state_mgr.set_worker(StateCode.ASR_PROCESSING, True)

    _asr_tasks[task_id] = {
        "task_id": task_id,
        "progress_percent": 0.0,
        "remaining_time_s": max(estimated_duration * 1.5, 5.0),
        "completed": False,
        "archive_id": None,
        "transcribed_text": None,
        "duration": estimated_duration,
    }

    _asr_executor.submit(_do_transcribe, task_id, str(audio_path))

    get_audit_logger().log(LogType.ASR_PROCESSING, {
        "task_id": task_id,
        "audio_name": file.filename,
        "event": "task_submitted_upload",
    }, f"ASR uploaded: {file.filename}")

    return {
        "code": StateCode.ASR_PROCESSING.value,
        "status": StateCode.ASR_PROCESSING.name,
        "data": {
            "task_id": task_id,
            "estimated_duration_s": estimated_duration,
        },
    }


@router.get("/status")
async def status(task_id: str = Query(...), api_version: str = Query("v1")):
    """ASR 任务状态轮询接口 — 技术需求文档 4.2.2"""
    task = _asr_tasks.get(task_id)

    if not task:
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "TASK_NOT_FOUND",
            "message": f"ASR task {task_id} not found.",
        }

    if task["completed"]:
        get_state_manager().set_worker(StateCode.ASR_PROCESSING, False)
        return {
            "code": StateCode.IDLE.value,
            "status": StateCode.IDLE.name,
            "data": {
                "task_id": task["task_id"],
                "progress_percent": 100.0,
                "archive_id": task["archive_id"],
                "duration": task["duration"],
                "transcribed_text": task["transcribed_text"],
            },
        }

    return {
        "code": StateCode.ASR_PROCESSING.value,
        "status": StateCode.ASR_PROCESSING.name,
        "data": {
            "task_id": task["task_id"],
            "progress_percent": task["progress_percent"],
            "remaining_time_s": task["remaining_time_s"],
        },
    }


@router.get("/list")
async def list_archives():
    """列出所有 ASR 归档记录。"""
    db = DatabaseManager.get_instance()
    cipher = db.cipher
    rows = db.conn.execute(
        "SELECT archive_id, task_id, audio_name, duration, create_time FROM asr_archive ORDER BY create_time DESC"
    ).fetchall()

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": [
            {"archive_id": r[0], "task_id": r[1], "audio_name": r[2], "duration": r[3], "create_time": r[4]}
            for r in rows
        ],
    }


# ---- ASR 转写结果一键导入知识库 ----

class ASRImportKBRequest(BaseModel):
    archive_id: str = Field(..., description="ASR 归档 ID")
    title: str = Field(default="", description="导入知识库的文档标题，留空则使用音频名")
    format: str = Field(default="txt", description="导入格式: txt | md")
    isolate_mode: str = Field(default="global", description="隔离模式: global | session | temp")
    session_id: str | None = Field(default=None)
    folder_id: str | None = Field(default=None)


@router.post("/import-to-kb")
async def import_to_knowledge_base(req: ASRImportKBRequest):
    """将 ASR 转写结果一键导入知识库。

    流程: 读取 ASR 归档 → 格式转换 → 分片 → Embedding → FAISS 索引
    """
    db = DatabaseManager.get_instance()
    cipher = db.cipher

    row = db.conn.execute(
        "SELECT audio_name, transcribed_text FROM asr_archive WHERE archive_id = ?",
        (req.archive_id,),
    ).fetchone()
    if not row:
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "message": "ASR 归档记录不存在",
        }

    audio_name, enc_text = row
    text = cipher.decrypt(enc_text) if cipher else enc_text
    if not text or text.startswith("[ASR"):
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "message": f"转写内容无效或转写失败: {text[:100]}",
        }

    # 格式转换
    title = req.title or Path(audio_name).stem
    fmt = req.format.lower()
    if fmt == "md":
        from backend.api.knowledge import _convert_to_md
        content = _convert_to_md(text, title)
        ext = "md"
    else:
        content = text
        ext = "txt"

    # 分片
    from backend.api.knowledge import _chunk_text
    chunks = _chunk_text(content)
    total_pages = max(1, len(chunks))

    # 写入知识库
    file_id = f"file-{uuid.uuid4().hex[:16]}"
    import_group_id = f"group-{uuid.uuid4().hex[:12]}"
    file_name = f"{title}.{ext}"

    from backend.config import UPLOAD_DIR
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    file_path = UPLOAD_DIR / f"{file_id}.{ext}"
    file_path.write_text(content, encoding="utf-8")

    file_size = len(content.encode("utf-8"))
    encrypted_path = cipher.encrypt(str(file_path)) if cipher else str(file_path)

    db.conn.execute(
        "INSERT INTO knowledge_base (file_id, file_name, file_path, file_size, total_pages, "
        "isolate_mode, session_id, folder_id, version, original_name, import_group_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (file_id, file_name, encrypted_path, file_size, total_pages,
         req.isolate_mode, req.session_id, req.folder_id, 1, file_name, import_group_id),
    )
    db.conn.commit()

    # Embedding + FAISS
    from backend.services.llm_service import get_llm_service
    from backend.services.rag_service import RAGService
    llm = get_llm_service()
    embeddings = await llm.embed(chunks)

    indexed_count = 0
    if embeddings and len(embeddings) == len(chunks):
        import numpy as np
        rag = RAGService()
        indexed_count = rag.index_document(
            file_id=file_id,
            file_name=file_name,
            chunks=chunks,
            embeddings=[np.array(e, dtype=np.float32) for e in embeddings],
        )

    get_audit_logger().log(LogType.KNOWLEDGE_UPLOAD, {
        "file_id": file_id,
        "file_name": file_name,
        "source": "asr_import",
        "archive_id": req.archive_id,
        "format": fmt,
        "indexed_count": indexed_count,
    }, f"ASR import to KB: {audio_name} → {file_name}")

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": {
            "file_id": file_id,
            "file_name": file_name,
            "total_pages": total_pages,
            "chunk_count": len(chunks),
            "indexed_count": indexed_count,
            "isolate_mode": req.isolate_mode,
            "source_archive_id": req.archive_id,
        },
    }


# ---- ASR 结果导出（txt / md / docx） ----

class ASRExportRequest(BaseModel):
    archive_id: str = Field(..., description="ASR 归档 ID")
    format: str = Field(default="txt", description="导出格式: txt | md | docx")


@router.post("/export")
async def export_transcription(req: ASRExportRequest):
    """导出 ASR 转写结果为指定格式。"""
    db = DatabaseManager.get_instance()
    cipher = db.cipher

    row = db.conn.execute(
        "SELECT audio_name, transcribed_text FROM asr_archive WHERE archive_id = ?",
        (req.archive_id,),
    ).fetchone()
    if not row:
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "message": "ASR 归档记录不存在",
        }

    audio_name, enc_text = row
    text = cipher.decrypt(enc_text) if cipher else enc_text
    base_name = Path(audio_name).stem
    fmt = req.format.lower()

    import tempfile

    if fmt == "md":
        from backend.api.knowledge import _convert_to_md
        output = _convert_to_md(text, base_name)
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False, encoding="utf-8")
        tmp.write(output)
        tmp.close()
        return FileResponse(path=tmp.name, filename=f"{base_name}.md", media_type="text/markdown")

    elif fmt == "docx":
        from backend.api.knowledge import _convert_to_docx
        output_bytes = _convert_to_docx(text, base_name)
        tmp = tempfile.NamedTemporaryFile(suffix=".docx", delete=False)
        tmp.write(output_bytes)
        tmp.close()
        return FileResponse(
            path=tmp.name,
            filename=f"{base_name}.docx",
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )

    else:  # txt
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8")
        tmp.write(text)
        tmp.close()
        return FileResponse(path=tmp.name, filename=f"{base_name}.txt", media_type="text/plain")
