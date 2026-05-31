from fastapi import APIRouter
from pydantic import BaseModel, Field

from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType
from backend.state_machine import StateCode, get_state_manager

router = APIRouter(prefix="/api/v1/knowledge", tags=["knowledge"])


class UploadRequest(BaseModel):
    api_version: str = "v1"
    file_payload_token: str = Field(..., description="安全层映射的 file_id token")
    file_type: str = Field(..., description="文件类型: pdf, docx, txt, etc.")
    isolate_mode: str = Field(default="session", description="隔离模式: global | session | temp")
    session_id: str | None = Field(default=None, description="isolate_mode=session 时必填")


@router.post("/upload")
async def upload(req: UploadRequest):
    """知识库文件上传接口 — 技术需求文档 §4.1"""
    state_mgr = get_state_manager()
    state_mgr.transition(StateCode.FILE_UPLOADING)

    get_audit_logger().log(
        LogType.KNOWLEDGE_UPLOAD,
        {"file_type": req.file_type, "isolate_mode": req.isolate_mode, "session_id": req.session_id},
        f"Uploading file: {req.file_payload_token}",
    )

    # TODO: 解析 file_payload_token → 物理路径
    # TODO: 文件结构化提取（PDF → text）
    # TODO: Tokenize + 分片 (chunk_size=512, overlap=128)
    # TODO: QVAC Embedding → FAISS 写入
    # TODO: knowledge_base 表写入

    state_mgr.transition(StateCode.FILE_PROCESSING)

    return {
        "code": StateCode.FILE_UPLOADING.value,
        "status": StateCode.FILE_UPLOADING.name,
        "data": {
            "file_id": "file-uuid-stub",
            "file_name": "stub.pdf",
            "total_pages": 0,
        },
    }
