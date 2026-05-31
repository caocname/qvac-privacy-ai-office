import uuid

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType
from backend.state_machine import StateCode, get_state_manager

router = APIRouter(prefix="/api/v1/asr", tags=["asr"])


class ASRSubmitRequest(BaseModel):
    api_version: str = "v1"
    audio_path: str = Field(..., description="音频文件本地路径")
    audio_type: str = Field(default="wav", description="仅支持标准无损 WAV")


# 内存中的 ASR 任务表（后续迁移至 SQLite asr_archive）
_asr_tasks: dict[str, dict] = {}


@router.post("/submit")
async def submit(req: ASRSubmitRequest):
    """异步 ASR 任务投递接口 — 技术需求文档 §4.2.1"""
    if req.audio_type.lower() != "wav":
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "UNSUPPORTED_AUDIO_FORMAT",
            "message": "Local ASR pipeline only supports standard lossless WAV files. MP3 or compressed formats are rejected.",
        }

    state_mgr = get_state_manager()
    state_mgr.set_worker(StateCode.ASR_PROCESSING, True)

    task_id = f"task-asr-{uuid.uuid4().hex[:12]}"
    _asr_tasks[task_id] = {
        "task_id": task_id,
        "progress_percent": 0.0,
        "remaining_time_s": 120.0,
        "completed": False,
        "archive_id": None,
        "transcribed_text": None,
        "duration": None,
    }

    get_audit_logger().log(
        LogType.ASR_PROCESSING,
        {"task_id": task_id, "audio_type": req.audio_type, "event": "task_submitted"},
        f"ASR task submitted for: {req.audio_path}",
    )

    # TODO: 将 ASR 任务投递到 ThreadPoolExecutor 独立执行
    # TODO: 调用 QVAC SDK whispercpp 进行转写
    # TODO: 完成后写入 asr_archive 表并更新 _asr_tasks

    return {
        "code": StateCode.ASR_PROCESSING.value,
        "status": StateCode.ASR_PROCESSING.name,
        "data": {
            "task_id": task_id,
            "estimated_duration_s": 120.0,
        },
    }


@router.get("/status")
async def status(task_id: str = Query(...), api_version: str = Query("v1")):
    """ASR 任务状态轮询接口 — 技术需求文档 §4.2.2"""
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
