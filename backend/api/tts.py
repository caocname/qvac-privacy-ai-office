"""
TTS 流式语音朗读 API — Chunked Transfer + 强行销毁控制。
"""
from __future__ import annotations

import asyncio
import json
import uuid

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


# TTS 缓冲区引用 (供 Kill Switch 清空)
tts_buffer: list[bytes] = []
_tts_abort_flag = False


async def _generate_tts_sdk(text: str, voice: str, speed: float):
    """通过 QVAC SDK 直接生成 TTS 音频 (Bridge 不可用时的降级方案)。"""
    import asyncio
    try:
        from qvac_sdk import TTSEngine
        tts = TTSEngine(voice=voice, speed=speed)
        audio_bytes = tts.synthesize(text)
        chunk_size = 4096
        for i in range(0, len(audio_bytes), chunk_size):
            if _tts_abort_flag:
                break
            yield audio_bytes[i:i + chunk_size]
            await asyncio.sleep(0)
    except ImportError:
        pass
    except Exception:
        pass


@router.post("/stream")
async def stream(req: TTSStreamRequest):
    """TTS 流式朗读接口 — 技术需求文档 4.3。

    后端通过 Chunked Transfer Encoding 持续向前端推送音频字节流。
    后端主轨保持 100 IDLE (TTS_PLAYING 为纯前端态)。
    """
    global _tts_abort_flag
    _tts_abort_flag = False

    state_mgr = get_state_manager()
    state_mgr.set_worker(StateCode.TTS_GENERATING, True)

    tts_buffer.clear()

    get_audit_logger().log(LogType.TTS_GENERATING, {
        "voice_model": req.voice_model,
        "speed": req.speed,
        "text_length": len(req.text),
    }, f"TTS streaming: {req.text[:80]}...")

    async def generate_audio():
        bridge_streamed = False
        try:
            # 方案 1: 通过 Bridge 调用 QVAC SDK TTS
            import httpx
            async with httpx.AsyncClient(timeout=10.0) as client:
                try:
                    resp = await client.post(
                        "http://127.0.0.1:18889/api/tts/stream",
                        json={"text": req.text, "voice": req.voice_model, "speed": req.speed},
                    )
                    if resp.status_code == 200:
                        async for chunk in resp.aiter_bytes():
                            if _tts_abort_flag:
                                break
                            bridge_streamed = True
                            yield chunk
                            await asyncio.sleep(0)
                except Exception:
                    pass

            # 方案 2: Bridge 不可用 — 尝试 QVAC SDK 直接调用
            if not bridge_streamed and not _tts_abort_flag:
                try:
                    from backend.api.tts import _generate_tts_sdk
                    async for chunk in _generate_tts_sdk(req.text, req.voice_model, req.speed):
                        if _tts_abort_flag:
                            break
                        bridge_streamed = True
                        yield chunk
                except Exception:
                    pass

            # 方案 3: 降级 — 返回 WAV 格式静音占位符
            if not bridge_streamed and not _tts_abort_flag:
                # 生成 16kHz 16bit mono WAV 封装的静音 (1秒)
                import struct
                sample_rate = 16000
                num_channels = 1
                bits_per_sample = 16
                num_samples = sample_rate  # 1 second
                data_size = num_samples * num_channels * (bits_per_sample // 8)
                wav_header = struct.pack(
                    "<4sI4s4sIHHIIHH4sI",
                    b"RIFF", 36 + data_size,
                    b"WAVE",
                    b"fmt ", 16, 1, num_channels, sample_rate,
                    sample_rate * num_channels * (bits_per_sample // 8),
                    num_channels * (bits_per_sample // 8),
                    bits_per_sample,
                    b"data", data_size,
                )
                yield wav_header + (b"\x00" * data_size)

        except Exception as exc:
            get_audit_logger().log(LogType.ERROR, {
                "error_class": type(exc).__name__,
            }, str(exc))
        finally:
            state_mgr.set_worker(StateCode.TTS_GENERATING, False)
            if not _tts_abort_flag:
                get_audit_logger().log(LogType.TTS_GENERATING, {"event": "stream_completed"})

    return StreamingResponse(
        generate_audio(),
        media_type="audio/wav",
        headers={
            "X-Audio-Model": req.voice_model,
            "X-Audio-Speed": str(req.speed),
        },
    )


@router.post("/abort")
async def abort(req: TTSAbortRequest):
    """TTS 强行销毁控制接口 — 技术需求文档 4.3.1。

    后端主轨在 TTS 播放期间保持 100 IDLE，确保随时响应此接口。
    点击即静音，0 延迟清除缓冲。
    """
    global _tts_abort_flag
    _tts_abort_flag = True
    tts_buffer.clear()
    get_state_manager().set_worker(StateCode.TTS_GENERATING, False)

    get_audit_logger().log(LogType.TTS_ABORT, {
        "action": req.action,
        "buffer_cleared": True,
    }, "TTS audio output handle destroyed.")

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "message": "Audio output handle reset and pipeline destroyed successfully.",
    }
