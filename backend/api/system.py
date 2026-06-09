"""
系统 API — 状态查询、凭据灾备恢复、密钥导出、首次启动引导、全量数据清理。
"""
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.config import DATA_DIR, DATABASE_PATH, UPLOAD_DIR, FAISS_INDEX_DIR, AUDIT_LOG_PATH
from backend.crypto.aes_gcm import (
    derive_key_from_credential,
    inject_key,
    export_recovery_key,
    initialize_master_key,
    generate_mnemonic,
    _get_keyring,
)
from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType
from backend.state_machine import StateCode, get_state_manager

_clear_all_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="clear-all")

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


@router.post("/credential/init")
async def credential_init():
    """手动触发主密钥初始化。

    若 keyring 可用且凭据已存在则返回已有密钥信息；
    若 keyring 可用但凭据不存在则自动生成并返回恢复密钥；
    若 keyring 不可用则返回错误。
    """
    keyring = _get_keyring()
    if not keyring:
        return JSONResponse(
            status_code=500,
            content={
                "code": StateCode.ERROR.value,
                "status": StateCode.ERROR.name,
                "error_class": "KEYRING_UNAVAILABLE",
                "message": "Windows 凭据管理器不可用。请安装 keyring 包并确保系统支持。",
            },
        )

    existing = derive_key_from_credential()
    if existing:
        recovery_hex = export_recovery_key()
        return {
            "code": StateCode.IDLE.value,
            "status": StateCode.IDLE.name,
            "message": "主密钥已就绪。",
            "data": {
                "recovery_key_hex": recovery_hex,
                "save_as": "safe_recovery.key",
                "warning": "请将恢复密钥保存在安全位置。丢失将导致所有加密数据无法恢复。",
                "already_existed": True,
            },
        }

    master_key = initialize_master_key()
    if not master_key:
        return JSONResponse(
            status_code=500,
            content={
                "code": StateCode.ERROR.value,
                "status": StateCode.ERROR.name,
                "error_class": "INIT_FAILED",
                "message": "主密钥初始化失败。请检查系统权限。",
            },
        )

    recovery_hex = export_recovery_key()
    get_audit_logger().log(LogType.SECURITY, {"event": "master_key_initialized_manual"})

    return {
        "code": StateCode.IDLE.value,
        "status": StateCode.IDLE.name,
        "message": "主密钥已生成并注入 Windows 凭据管理器。请立即导出恢复密钥。",
        "data": {
            "recovery_key_hex": recovery_hex,
            "save_as": "safe_recovery.key",
            "warning": "请将恢复密钥保存在安全位置。丢失将导致所有加密数据无法恢复。",
            "already_existed": False,
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


@router.post("/clear-all")
async def clear_all():
    """清空所有用户数据 — 知识库、会话、ASR 归档、审计日志、上传文件、FAISS 索引。

    高危操作，前端必须使用 3 秒倒计时二次确认（R-09 规则）。
    文件物理删除在独立线程池中异步执行（R-05 规则）。
    """
    from backend.database.connection import DatabaseManager

    db = DatabaseManager.get_instance()
    stats: dict[str, int] = {}
    errors: list[str] = []

    # 1. 清空数据库表（保留表结构）— 先删子表再删父表，避免外键约束冲突
    tables = ["rag_chunks", "chat_records", "knowledge_base",
              "knowledge_folders", "asr_archive", "sessions"]
    for table in tables:
        try:
            cur = db.conn.execute(f"DELETE FROM {table}")
            stats[f"db_{table}"] = cur.rowcount
        except Exception as e:
            stats[f"db_{table}"] = -1
            errors.append(f"{table}: {e}")
    db.conn.commit()

    # 2. 清空审计日志 — 通过 AuditLogger 同一连接执行，避免 WAL 锁冲突
    try:
        logger = get_audit_logger()
        cleared = logger.clear_all()
        stats["audit_logs"] = cleared
    except Exception as e:
        stats["audit_logs"] = -1
        errors.append(f"audit_logs: {e}")

    # 3. 异步删除上传文件
    def _delete_uploads():
        count = 0
        if UPLOAD_DIR.exists():
            for f in UPLOAD_DIR.iterdir():
                try:
                    f.unlink()
                    count += 1
                except Exception:
                    pass
        return count

    # 4. 异步清空 FAISS 索引
    def _clear_faiss():
        count = 0
        if FAISS_INDEX_DIR.exists():
            for f in FAISS_INDEX_DIR.iterdir():
                try:
                    if f.is_file():
                        f.unlink()
                    else:
                        shutil.rmtree(f, ignore_errors=True)
                    count += 1
                except Exception:
                    pass
        return count

    future_uploads = _clear_all_executor.submit(_delete_uploads)
    future_faiss = _clear_all_executor.submit(_clear_faiss)

    stats["uploads_deleted"] = future_uploads.result()
    stats["faiss_files_deleted"] = future_faiss.result()

    # 5. 记录审计日志（写入完成后立即刷盘的新条目）
    get_audit_logger().log(LogType.SECURITY, {
        "event": "clear_all_data",
        "stats": stats,
    })

    success = all(v >= 0 for v in stats.values())

    return {
        "code": StateCode.IDLE.value if success else StateCode.ERROR.value,
        "status": StateCode.IDLE.name if success else StateCode.ERROR.name,
        "message": "所有用户数据已清空。" if success else f"部分清空失败: {'; '.join(errors)}",
        "data": {"stats": stats, "errors": errors} if errors else {"stats": stats},
    }
