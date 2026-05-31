from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from backend.config import DATA_DIR, DATABASE_PATH
from backend.crypto.aes_gcm import AESCipher, derive_key_from_credential


class DatabaseManager:
    """SQLite 数据库管理器 — 线程安全，全局单例。

    初始化时自动创建所有表结构（对齐技术需求文档 §5.1）。
    """

    _instance: DatabaseManager | None = None
    _lock = threading.Lock()

    def __init__(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        key = derive_key_from_credential()
        self._cipher = AESCipher(key) if key else None
        self._conn = sqlite3.connect(str(DATABASE_PATH), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA synchronous=NORMAL;")
        self._conn.execute("PRAGMA foreign_keys=ON;")
        self._init_schema()

    @classmethod
    def get_instance(cls) -> DatabaseManager:
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @property
    def cipher(self) -> AESCipher | None:
        return self._cipher

    @property
    def conn(self) -> sqlite3.Connection:
        return self._conn

    def _init_schema(self) -> None:
        self._conn.executescript(SCHEMA_SQL)

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS knowledge_base (
    file_id VARCHAR(64) PRIMARY KEY,
    file_name VARCHAR(256) NOT NULL,
    file_path VARCHAR(512) NOT NULL,
    file_size INTEGER NOT NULL,
    total_pages INTEGER NOT NULL,
    isolate_mode VARCHAR(16) NOT NULL CHECK(isolate_mode IN ('global', 'session', 'temp')),
    session_id VARCHAR(64),
    is_deleted INTEGER NOT NULL DEFAULT 0,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS asr_archive (
    archive_id VARCHAR(64) PRIMARY KEY,
    task_id VARCHAR(64) NOT NULL,
    audio_name VARCHAR(256) NOT NULL,
    audio_path VARCHAR(512) NOT NULL,
    duration FLOAT NOT NULL,
    transcribed_text TEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(256) DEFAULT '新会话',
    status VARCHAR(4) NOT NULL DEFAULT '100',
    current_state_code INTEGER NOT NULL DEFAULT 100,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_records (
    message_id VARCHAR(64) PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL,
    role VARCHAR(16) NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    token_count INTEGER DEFAULT 0,
    is_truncated INTEGER NOT NULL DEFAULT 0,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE TABLE IF NOT EXISTS rag_chunks (
    chunk_id VARCHAR(64) PRIMARY KEY,
    file_id VARCHAR(64) NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    faiss_vector_id INTEGER,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (file_id) REFERENCES knowledge_base(file_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_session ON knowledge_base(session_id);
CREATE INDEX IF NOT EXISTS idx_kb_isolate ON knowledge_base(isolate_mode);
CREATE INDEX IF NOT EXISTS idx_asr_task ON asr_archive(task_id);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_records(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_time ON chat_records(create_time);
CREATE INDEX IF NOT EXISTS idx_rag_file ON rag_chunks(file_id);
"""
