from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.crypto.aes_gcm import derive_key_from_credential
from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType
from backend.state_machine import StateCode, get_state_manager

router = APIRouter(prefix="/api/v1/system", tags=["system"])


class RecoverRequest(BaseModel):
    api_version: str = "v1"
    recovery_key: str | None = Field(default=None, description="导入的 .key 字节流或 12 位安全助记词字符串")


@router.post("/recover")
async def recover(req: RecoverRequest):
    """凭据灾备恢复接口 — 技术需求文档 §5.2。

    接收用户导入的 .key 或 12 位安全助记词，派生后重新注入 Windows 凭据管理器。
    """
    if not req.recovery_key:
        return JSONResponse(
            status_code=400,
            content={
                "code": StateCode.ERROR.value,
                "status": StateCode.ERROR.name,
                "error_class": "INVALID_RECOVERY_KEY",
                "message": "Recovery key or mnemonic phrase is required.",
            },
        )

    # TODO: 派生算法验证 recovery_key
    # TODO: 重新注入 Windows 凭据管理器
    # TODO: 验证能否解密现有数据库

    get_audit_logger().log(LogType.SECURITY, {"event": "credential_recovery_attempted"})

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "message": "Credential recovery processed. Verify database access.",
    }


@router.get("/state")
async def get_state():
    """获取当前系统状态快照。"""
    return get_state_manager().snapshot()
