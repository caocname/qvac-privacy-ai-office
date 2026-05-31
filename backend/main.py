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

    from backend.database.connection import DatabaseManager
    DatabaseManager.get_instance()
    logger.log(LogType.SYSTEM, {"event": "database_initialized"})

    from backend.services.kill_switch import get_kill_switch
    ks = get_kill_switch()
    ks.start()
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
    version="0.1.0",
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
from backend.api.asr import router as asr_router
from backend.api.tts import router as tts_router
from backend.api.system import router as system_router

app.include_router(log_router)
app.include_router(knowledge_router)
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
