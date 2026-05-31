from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType
from backend.state_machine import StateCode, get_state_manager

router = APIRouter(prefix="/api/v1/tts", tags=["tts"])


class TTSStreamRequest(BaseModel):
    api_version: str = "v1"
    text: str = Field(..., description="待朗读的文本")
    voice_model: str = Field(default="male_professional")
    speed: float = Field(default=1.1, ge=0.5, le=3.0)


class TTSAbortRequest(BaseModel):
    api_version: str = "v1"
    action: str = Field(default="destroy_handler")


# TTS 缓冲区引用（供 Kill Switch 清空）
tts_buffer: list[bytes] = []


@router.post("/stream")
async def stream(req: TTSStreamRequest):
    """TTS 流式朗读接口 — 技术需求文档 §4.3。

    后端通过 Chunked Transfer Encoding 持续向前端推送音频字节流。
    """
    state_mgr = get_state_manager()
    state_mgr.set_worker(StateCode.TTS_GENERATING, True)

    get_audit_logger().log(
        LogType.TTS_GENERATING,
        {"voice_model": req.voice_model, "speed": req.speed, "text_length": len(req.text)},
        f"TTS streaming: {req.text[:80]}...",
    )

    async def generate_audio():
        # TODO: 接入 QVAC SDK TTS-onnx 引擎，生成真实音频流
        # 当前骨架返回空流
        tts_buffer.clear()
        yield b""
        state_mgr.set_worker(StateCode.TTS_GENERATING, False)

    return StreamingResponse(
        generate_audio(),
        media_type="application/octet-stream",
        headers={"X-Audio-Model": req.voice_model},
    )


@router.post("/abort")
async def abort(req: TTSAbortRequest):
    """TTS 强行销毁控制接口 — 技术需求文档 §4.3.1。

    后端主轨在 TTS 播放期间保持 100 IDLE，确保随时响应此接口。
    """
    tts_buffer.clear()
    get_state_manager().set_worker(StateCode.TTS_GENERATING, False)

    get_audit_logger().log(LogType.TTS_ABORT, {"action": req.action}, "TTS audio output handle destroyed.")

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "message": "Audio output handle reset and pipeline destroyed successfully.",
    }
