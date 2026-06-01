"""
系统 API — 状态查询、凭据灾备恢复、密钥导出。
"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.crypto.aes_gcm import (
    derive_key_from_credential,
    inject_key,
    export_recovery_key,
    initialize_master_key,
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


@router.get("/state")
async def get_state():
    """获取当前系统状态快照。"""
    return get_state_manager().snapshot()
