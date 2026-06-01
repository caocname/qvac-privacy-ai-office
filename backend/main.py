import atexit
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.logger.audit_logger import get_audit_logger
from backend.logger.auto_logger import AuditLoggingMiddleware, install_global_exception_hook
from backend.logger.log_models import LogType
from backend.logger.resource_sampler import ResourceSampler

_sampler: ResourceSampler | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _sampler
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    logger = get_audit_logger()

    logger.log(LogType.SYSTEM, {"event": "backend_startup"})

    # ---- 凭据管理器自检 ----
    from backend.crypto.aes_gcm import derive_key_from_credential, initialize_master_key

    master_key = derive_key_from_credential()
    if not master_key:
        # 首次启动: 自动生成主密钥并注入 Windows 凭据管理器
        logger.log(LogType.SECURITY, {"event": "credential_not_found_generating"})
        master_key = initialize_master_key()
        if master_key:
            logger.log(LogType.SECURITY, {
                "event": "master_key_initialized",
                "note": "首次启动 — 请通过 GET /api/v1/system/credential/export 导出恢复密钥",
            })
        else:
            logger.log(LogType.ERROR, {
                "event": "credential_init_failed",
                "message": "无法访问 Windows 凭据管理器。请确保 keyring 已正确安装。",
            })

    # 凭据状态记录
    cred_present = master_key is not None
    logger.log(LogType.SYSTEM, {
        "event": "credential_check_complete",
        "credential_present": cred_present,
        "credential_lost": not cred_present,
    })

    from backend.database.connection import DatabaseManager
    DatabaseManager.get_instance()
    logger.log(LogType.SYSTEM, {"event": "database_initialized"})

    from backend.services.kill_switch import get_kill_switch
    ks = get_kill_switch()
    ks.start()

    # 自动发现并注册 Bridge 进程 PID (监听 127.0.0.1:18889 的 node 进程)
    import psutil
    for proc in psutil.process_iter(['pid', 'name']):
        try:
            if proc.info['name'] and 'node' in proc.info['name'].lower():
                for conn in proc.connections(kind='inet'):
                    if conn.laddr and conn.laddr.port == 18889:
                        ks.register_bridge_pid(proc.pid)
                        logger.log(LogType.SYSTEM, {
                            "event": "bridge_pid_registered",
                            "bridge_pid": proc.pid,
                        })
                        break
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    logger.log(LogType.SYSTEM, {"event": "kill_switch_started"})

    _sampler = ResourceSampler(interval_s=1.0)
    _sampler.start()
    logger.log(LogType.SYSTEM, {"event": "resource_sampler_started"})

    yield

    logger.log(LogType.SYSTEM, {"event": "backend_shutdown"})
    if _sampler:
        _sampler.stop()
    from backend.services.kill_switch import get_kill_switch
    get_kill_switch().stop()
    logger.flush()


app = FastAPI(
    title="QVAC Hackathon 离线 AI 办公助手",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(AuditLoggingMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

install_global_exception_hook()

# ---- API 路由注册 ----
from backend.logger.log_router import router as log_router
from backend.api.knowledge import router as knowledge_router
from backend.api.chat import router as chat_router
from backend.api.asr import router as asr_router
from backend.api.tts import router as tts_router
from backend.api.system import router as system_router

app.include_router(log_router)
app.include_router(knowledge_router)
app.include_router(chat_router)
app.include_router(asr_router)
app.include_router(tts_router)
app.include_router(system_router)

atexit.register(lambda: get_audit_logger().shutdown())


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host="127.0.0.1",
        port=18888,
        log_level="info",
    )
