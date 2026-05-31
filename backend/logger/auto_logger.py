import sys
import threading
import time
import traceback

from fastapi import FastAPI, Request
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response

from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType


class AuditLoggingMiddleware(BaseHTTPMiddleware):
    """自动记录所有 HTTP 请求的中间件。

    捕获：method、path、status_code、duration_ms、client_ip。
    非阻塞投递到 AuditLogger，不影响请求响应链路。
    """

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        logger = get_audit_logger()
        start_ns = time.monotonic_ns()

        try:
            response = await call_next(request)
        except Exception:
            duration_ms = (time.monotonic_ns() - start_ns) // 1_000_000
            logger.log(
                LogType.API_REQUEST,
                {
                    "method": request.method,
                    "path": request.url.path,
                    "status_code": 500,
                    "duration_ms": duration_ms,
                    "client_ip": _get_client_ip(request),
                },
                f"{request.method} {request.url.path} -> 500 ({duration_ms}ms)",
            )
            raise

        duration_ms = (time.monotonic_ns() - start_ns) // 1_000_000
        logger.log(
            LogType.API_REQUEST,
            {
                "method": request.method,
                "path": request.url.path,
                "query_string": str(request.query_params) if request.query_params else None,
                "status_code": response.status_code,
                "duration_ms": duration_ms,
                "client_ip": _get_client_ip(request),
            },
            f"{request.method} {request.url.path} -> {response.status_code} ({duration_ms}ms)",
        )
        return response


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    client = request.client
    return client.host if client else "unknown"


def install_global_exception_hook() -> None:
    """安装全局未处理异常捕获钩子。

    捕获主线程和其他线程中未处理的异常，自动写入 ERROR 日志。
    """
    logger = get_audit_logger()

    def _exception_hook(exc_type, exc_value, exc_tb):
        tb_lines = traceback.format_exception(exc_type, exc_value, exc_tb)
        logger.log(
            LogType.ERROR,
            {
                "error_class": exc_type.__name__ if exc_type else "Unknown",
                "thread": threading.current_thread().name,
            },
            "".join(tb_lines)[:2000],
        )
        sys.__excepthook__(exc_type, exc_value, exc_tb)

    def _thread_exception_hook(args: threading.ExceptHookArgs):
        tb_lines = traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback)
        logger.log(
            LogType.ERROR,
            {
                "error_class": args.exc_type.__name__ if args.exc_type else "Unknown",
                "thread": args.thread.name if args.thread else "unknown",
            },
            "".join(tb_lines)[:2000],
        )
        if sys.__excepthook__ is not _exception_hook:
            sys.__excepthook__(args.exc_type, args.exc_value, args.exc_traceback)

    sys.excepthook = _exception_hook
    threading.excepthook = _thread_exception_hook
