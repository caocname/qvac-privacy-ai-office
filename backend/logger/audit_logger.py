import queue
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from backend.crypto.aes_gcm import AESCipher, derive_key_from_credential
from backend.logger.log_db import LogDatabase
from backend.logger.log_models import LogEntry, LogExportItem, LogType

BATCH_SIZE = 50
FLUSH_INTERVAL_S = 0.5
QUEUE_MAX_SIZE = 10000
SHUTDOWN_TIMEOUT_S = 5.0


class AuditLogger:
    """非阻塞高性能审计日志引擎。

    设计要点：
    - 调用方通过 log() 将日志条目推入 queue.Queue，立即返回（非阻塞）。
    - 后台守护线程批量消费队列，写入 SQLite，与推理主线程完全解耦。
    - 相对时间戳基于 time.monotonic_ns()，保证单调递增，不受系统时钟调整影响。
    - 时间轴对齐误差 ≤ 500ms（单调时钟 + 队列批处理延迟上限）。
    """

    def __init__(self, db_path_override: str | None = None):
        self._init_time_ns = time.monotonic_ns()

        cipher: AESCipher | None = None
        key = derive_key_from_credential()
        if key:
            cipher = AESCipher(key)
        self._cipher = cipher

        self._db = LogDatabase(cipher)
        self._db.open()
        self._queue: queue.Queue[LogEntry | object] = queue.Queue(
            maxsize=QUEUE_MAX_SIZE
        )
        self._running = True
        self._worker = threading.Thread(target=self._consume_loop, daemon=True)
        self._worker.start()

    # ---- 公开 API ----

    def log(
        self,
        log_type: LogType,
        metrics: dict[str, Any] | None = None,
        payload_snapshot: str | None = None,
    ) -> str:
        """非阻塞投递一条审计日志。

        返回生成的 log_id，调用方可据此追踪。
        """
        now = datetime.now(timezone.utc)
        entry = LogEntry(
            log_id=self._generate_log_id(),
            absolute_datetime=now.strftime("%Y-%m-%dT%H:%M:%S.") +
                f"{now.microsecond // 1000:03d}Z",
            relative_timestamp_ms=self._relative_ms(),
            log_type=log_type,
            metrics=metrics,
            payload_snapshot=payload_snapshot,
        )
        try:
            self._queue.put_nowait(entry)
        except queue.Full:
            self._drain_one()
            try:
                self._queue.put_nowait(entry)
            except queue.Full:
                pass
        return entry.log_id

    def export(
        self, page: int = 1, page_size: int = 20
    ) -> tuple[list[LogExportItem], int]:
        """分页查询日志（供 API 路由调用）。"""
        self.flush()
        return self._db.query(page, page_size)

    def flush(self) -> None:
        """强制刷盘：等待队列中所有已投递日志写入 SQLite。"""
        done = threading.Event()
        try:
            self._queue.put_nowait(done)
            done.wait(timeout=SHUTDOWN_TIMEOUT_S)
        except queue.Full:
            pass

    def shutdown(self) -> None:
        """优雅关闭：刷盘后停止后台线程并关闭数据库。"""
        self._running = False
        self.flush()
        if self._worker.is_alive():
            self._worker.join(timeout=SHUTDOWN_TIMEOUT_S)
        self._db.close()

    # ---- 内部方法 ----

    def _relative_ms(self) -> int:
        return (time.monotonic_ns() - self._init_time_ns) // 1_000_000

    @staticmethod
    def _generate_log_id() -> str:
        return f"log-{uuid.uuid4().hex[:12]}"

    def _drain_one(self) -> None:
        try:
            self._queue.get_nowait()
        except queue.Empty:
            pass

    def _consume_loop(self) -> None:
        """后台线程：批量消费队列，写入 SQLite。"""
        batch: list[LogEntry] = []
        last_flush = time.monotonic()

        while self._running:
            try:
                item = self._queue.get(timeout=FLUSH_INTERVAL_S)
            except queue.Empty:
                self._write_batch(batch)
                batch.clear()
                last_flush = time.monotonic()
                continue

            if isinstance(item, threading.Event):
                self._write_batch(batch)
                batch.clear()
                last_flush = time.monotonic()
                item.set()
                continue

            batch.append(item)

            if len(batch) >= BATCH_SIZE or (
                time.monotonic() - last_flush >= FLUSH_INTERVAL_S
            ):
                self._write_batch(batch)
                batch.clear()
                last_flush = time.monotonic()

        self._write_batch(batch)

    def _write_batch(self, batch: list[LogEntry]) -> None:
        if not batch:
            return
        self._db.insert_batch(batch)


# ---- 全局单例 ----

_logger_instance: AuditLogger | None = None
_instance_lock = threading.Lock()


def get_audit_logger() -> AuditLogger:
    global _logger_instance
    if _logger_instance is None:
        with _instance_lock:
            if _logger_instance is None:
                _logger_instance = AuditLogger()
    return _logger_instance
