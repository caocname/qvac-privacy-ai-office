"""
系统 API — 状态查询、凭据灾备恢复、密钥导出、首次启动引导。
"""
from datetime import datetime, timezone

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.crypto.aes_gcm import (
    derive_key_from_credential,
    inject_key,
    export_recovery_key,
    initialize_master_key,
    generate_mnemonic,
)
from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType
from backend.state_machine import StateCode, get_state_manager

router = APIRouter(prefix="/api/v1/system", tags=["system"])


class RecoverRequest(BaseModel):
    api_version: str = "v1"
    recovery_key: str = Field(..., description=".key 文件内容 (64 hex) 或 12 位中文助记词")


@router.post("/recover")
async def recover(req: RecoverRequest):
    """凭据灾备恢复接口 — 技术需求文档 5.2。

    接收 .key 内容或 12 位助记词，注入 Windows 凭据管理器。
    """
    if not req.recovery_key or len(req.recovery_key.strip()) < 12:
        return JSONResponse(
            status_code=400,
            content={
                "code": StateCode.ERROR.value,
                "status": StateCode.ERROR.name,
                "error_class": "INVALID_RECOVERY_KEY",
                "message": "Recovery key or 12-word mnemonic phrase is required.",
            },
        )

    success = inject_key(req.recovery_key.strip())

    if not success:
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "INJECTION_FAILED",
            "message": "Failed to inject key into Windows Credential Manager. Check keyring permissions.",
        }

    # 验证注入后的密钥是否可读
    key = derive_key_from_credential()
    if not key:
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "VERIFICATION_FAILED",
            "message": "Key injected but verification failed. Try again.",
        }

    get_audit_logger().log(LogType.SECURITY, {
        "event": "credential_recovery_success",
    })

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "message": "Credential recovery successful. Master key restored in Windows Credential Manager.",
    }


@router.get("/credential/status")
async def credential_status():
    """查询凭据状态。"""
    key = derive_key_from_credential()
    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": {
            "credential_present": key is not None,
            "credential_service": "qvac-text",
        },
    }


@router.get("/credential/export")
async def export_key():
    """导出恢复密钥 (.key 文件内容)。

    安全注意: 用户必须在安全位置保存此密钥。
    """
    key = derive_key_from_credential()
    if not key:
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "error_class": "CREDENTIAL_LOST",
            "message": "No master key found. Initialize the system first.",
        }

    recovery_hex = export_recovery_key()
    if not recovery_hex:
        return {
            "code": StateCode.ERROR.value,
            "status": StateCode.ERROR.name,
            "message": "Failed to export recovery key.",
        }

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": {
            "recovery_key_hex": recovery_hex,
            "save_as": "safe_recovery.key",
            "warning": "Store this key in a secure location. It can decrypt all local data.",
        },
    }


@router.get("/setup/status")
async def setup_status():
    """首次启动引导状态检查 — 前端可据此决定是否弹出密钥导出引导。

    返回:
    - needs_setup: True 表示首次启动，需要引导用户导出 .key 恢复文件
    - is_first_run: True 表示刚完成主密钥初始化
    """
    key = derive_key_from_credential()
    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": {
            "credential_present": key is not None,
            "credential_lost": key is None,
            "needs_setup": key is not None,  # 始终建议导出
        },
    }


@router.get("/setup/mnemonic")
async def generate_mnemonic_phrase():
    """生成 12 位中文助记词 (用于灾备恢复的备选方案)。

    安全注意: 助记词可以恢复所有本地加密数据。请引导用户在安全处保管。
    """
    mnemonic = generate_mnemonic()
    key_hex = export_recovery_key()

    get_audit_logger().log(LogType.SECURITY, {"event": "mnemonic_generated"})

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": {
            "mnemonic_12_words": mnemonic,
            "recovery_key_hex": key_hex,
            "save_as": "safe_recovery.key",
            "warning": "请将助记词和密钥保存在安全位置。丢失将导致所有加密数据无法恢复。",
        },
    }


@router.get("/state")
async def get_state():
    """获取当前系统状态快照。"""
    return get_state_manager().snapshot()


@router.get("/hardware")
async def get_hardware():
    """获取实时硬件资源信息 — 直接采样 psutil / pynvml，不依赖审计日志。"""
    metrics: dict = {}

    # GPU 显存
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        info = pynvml.nvmlDeviceGetMemoryInfo(handle)
        metrics["gpu_memory_used_mb"] = round(info.used / (1024 * 1024), 1)
        metrics["gpu_memory_total_mb"] = round(info.total / (1024 * 1024), 1)
    except Exception:
        metrics["gpu_memory_used_mb"] = 0
        metrics["gpu_memory_total_mb"] = 0

    # CPU 利用率
    try:
        import psutil
        metrics["cpu_utilization_percent"] = round(psutil.cpu_percent(interval=0.1), 1)
    except Exception:
        metrics["cpu_utilization_percent"] = 0

    # RAM
    try:
        import psutil
        mem = psutil.virtual_memory()
        metrics["ram_used_mb"] = round(mem.used / (1024 * 1024), 1)
        metrics["ram_total_mb"] = round(mem.total / (1024 * 1024), 1)
    except Exception:
        metrics["ram_used_mb"] = 0
        metrics["ram_total_mb"] = 0

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "data": metrics,
    }
