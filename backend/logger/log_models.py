from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel


# ============================================================
# 标准化推理性能指标字段名（赛事评审强制要求）
# ============================================================
class InferenceMetric:
    """INFERENCE_START / INFERENCE_END / INFERENCE_SAMPLE 的 metrics 标准字段名。"""
    PROMPT_TOKENS = "prompt_tokens"
    COMPLETION_TOKENS = "completion_tokens"
    TTFT_MS = "ttft_ms"
    TOKENS_PER_SECOND = "tokens_per_second"
    TOTAL_DURATION_MS = "total_duration_ms"
    GPU_MEMORY_MB = "gpu_memory_used_mb"
    CPU_PERCENT = "cpu_utilization_percent"
    RAM_MB = "ram_used_mb"
    STATUS_CODE = "current_status_code"
    MODEL_ID = "model_id"


class SystemResourceMetric:
    """SYSTEM_RESOURCE 定时采样的 metrics 标准字段名。"""
    GPU_MEMORY_MB = "gpu_memory_used_mb"
    GPU_MEMORY_TOTAL_MB = "gpu_memory_total_mb"
    CPU_PERCENT = "cpu_utilization_percent"
    RAM_MB = "ram_used_mb"
    RAM_TOTAL_MB = "ram_total_mb"


class LogType(str, Enum):
    """审计日志事件类型 — 覆盖赛事全部审计埋点要求。"""
    SYSTEM = "SYSTEM"
    MODEL_LOAD = "MODEL_LOAD"
    MODEL_UNLOAD = "MODEL_UNLOAD"
    INFERENCE_START = "INFERENCE_START"
    INFERENCE_END = "INFERENCE_END"
    INFERENCE_SAMPLE = "INFERENCE_SAMPLE"
    SYSTEM_RESOURCE = "SYSTEM_RESOURCE"
    KILL_SWITCH = "KILL_SWITCH"
    KNOWLEDGE_UPLOAD = "KNOWLEDGE_UPLOAD"
    KNOWLEDGE_DELETE = "KNOWLEDGE_DELETE"
    ASR_PROCESSING = "ASR_PROCESSING"
    TTS_GENERATING = "TTS_GENERATING"
    TTS_ABORT = "TTS_ABORT"
    RAG_RETRIEVAL = "RAG_RETRIEVAL"
    ERROR = "ERROR"
    SECURITY = "SECURITY"
    SESSION = "SESSION"
    EXPORT = "EXPORT"
    API_REQUEST = "API_REQUEST"


class LogEntry(BaseModel):
    """单条审计日志记录（内部模型）。"""
    log_id: str
    absolute_datetime: str  # ISO-8601 (UTC)
    relative_timestamp_ms: int  # 自系统初始化以来的单调递增毫秒数
    log_type: LogType
    metrics: dict[str, Any] | None = None
    payload_snapshot: str | None = None


class LogExportItem(BaseModel):
    """导出的单条日志记录（API 返回模型）。"""
    log_id: str
    absolute_datetime: str
    relative_timestamp_ms: int
    log_type: str
    metrics: dict[str, Any] | None = None
    payload_snapshot: str | None = None


class LogExportResponse(BaseModel):
    """日志导出 API 返回结构 — 严格对齐技术需求文档 §6.2。"""
    api_version: str = "v1"
    total_records: int
    page: int
    logs: list[LogExportItem]
