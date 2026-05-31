import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

from backend.crypto.aes_gcm import AESCipher
from backend.logger.log_models import LogEntry, LogExportItem


DB_DIR = Path(__file__).resolve().parent.parent.parent / "data"
DB_PATH = DB_DIR / "audit_logs.db"

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id VARCHAR(64) PRIMARY KEY,
    absolute_datetime DATETIME NOT NULL,
    relative_timestamp_ms INTEGER NOT NULL,
    log_type VARCHAR(32) NOT NULL,
    metrics TEXT,
    payload_snapshot_enc TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
"""

CREATE_INDEXES_SQL = [
    "CREATE INDEX IF NOT EXISTS idx_audit_datetime ON audit_logs(absolute_datetime);",
    "CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_logs(log_type);",
    "CREATE INDEX IF NOT EXISTS idx_audit_relative ON audit_logs(relative_timestamp_ms);",
]


class LogDatabase:
    """SQLite 日志持久化层。

    在独立线程中运行，通过 connection-per-thread 保证线程安全。
    仅 log_db 线程持有数据库连接，所有写入和查询均在其上下文中执行。
    """

    def __init__(self, cipher: AESCipher | None = None):
        DB_DIR.mkdir(parents=True, exist_ok=True)
        self._cipher = cipher
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.Lock()

    def open(self) -> None:
        self._conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA synchronous=NORMAL;")
        self._conn.execute(CREATE_TABLE_SQL)
        for idx_sql in CREATE_INDEXES_SQL:
            self._conn.execute(idx_sql)
        self._conn.commit()

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    def insert(self, entry: LogEntry) -> None:
        if not self._conn:
            return
        with self._lock:
            payload = entry.payload_snapshot
            encrypted = (
                self._cipher.encrypt(payload)
                if self._cipher and payload
                else payload
            )
            self._conn.execute(
                "INSERT OR REPLACE INTO audit_logs "
                "(log_id, absolute_datetime, relative_timestamp_ms, log_type, metrics, payload_snapshot_enc) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    entry.log_id,
                    entry.absolute_datetime,
                    entry.relative_timestamp_ms,
                    entry.log_type.value,
                    json.dumps(entry.metrics, ensure_ascii=False) if entry.metrics else None,
                    encrypted,
                ),
            )
            self._conn.commit()

    def insert_batch(self, entries: list[LogEntry]) -> None:
        if not self._conn:
            return
        with self._lock:
            rows: list[tuple[Any, ...]] = []
            for e in entries:
                payload = e.payload_snapshot
                encrypted = (
                    self._cipher.encrypt(payload)
                    if self._cipher and payload
                    else payload
                )
                rows.append(
                    (
                        e.log_id,
                        e.absolute_datetime,
                        e.relative_timestamp_ms,
                        e.log_type.value,
                        json.dumps(e.metrics, ensure_ascii=False) if e.metrics else None,
                        encrypted,
                    )
                )
            self._conn.executemany(
                "INSERT OR REPLACE INTO audit_logs "
                "(log_id, absolute_datetime, relative_timestamp_ms, log_type, metrics, payload_snapshot_enc) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                rows,
            )
            self._conn.commit()

    def query(self, page: int, page_size: int) -> tuple[list[LogExportItem], int]:
        if not self._conn:
            return [], 0
        with self._lock:
            total = self._conn.execute(
                "SELECT COUNT(*) FROM audit_logs"
            ).fetchone()[0]
            offset = (page - 1) * page_size
            rows = self._conn.execute(
                "SELECT log_id, absolute_datetime, relative_timestamp_ms, "
                "log_type, metrics, payload_snapshot_enc "
                "FROM audit_logs ORDER BY relative_timestamp_ms DESC "
                "LIMIT ? OFFSET ?",
                (page_size, offset),
            ).fetchall()

        items: list[LogExportItem] = []
        for row in rows:
            log_id, abs_dt, rel_ms, log_type, metrics_json, enc_payload = row
            payload: str | None = None
            if enc_payload:
                if self._cipher:
                    try:
                        payload = self._cipher.decrypt(enc_payload)
                    except Exception:
                        payload = enc_payload
                else:
                    payload = enc_payload
            metrics: dict[str, Any] | None = None
            if metrics_json:
                try:
                    metrics = json.loads(metrics_json)
                except json.JSONDecodeError:
                    pass
            items.append(
                LogExportItem(
                    log_id=log_id,
                    absolute_datetime=abs_dt,
                    relative_timestamp_ms=rel_ms,
                    log_type=log_type,
                    metrics=metrics,
                    payload_snapshot=payload,
                )
            )
        return items, total
