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
        self._run_migrations()

    def _run_migrations(self) -> None:
        """增量迁移 — 为旧数据库添加新列（忽略已存在的列）。"""
        migrations = [
            "ALTER TABLE knowledge_base ADD COLUMN folder_id VARCHAR(64)",
            "ALTER TABLE knowledge_base ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE knowledge_base ADD COLUMN original_name VARCHAR(256) NOT NULL DEFAULT ''",
            "ALTER TABLE knowledge_base ADD COLUMN import_group_id VARCHAR(64) NOT NULL DEFAULT ''",
        ]
        for sql in migrations:
            try:
                self._conn.execute(sql)
            except sqlite3.OperationalError:
                pass  # 列已存在，跳过

        self._repair_legacy_records()

    def _repair_legacy_records(self) -> None:
        """回填旧记录并合并同名文件到同一版本分组。"""
        import uuid

        # 1. 回填 original_name（为空的记录用 file_name 填充）
        self._conn.execute(
            "UPDATE knowledge_base SET original_name = file_name "
            "WHERE original_name = '' AND is_deleted = 0"
        )

        # 2. 按 LOWER(original_name) 分组合并 import_group_id
        #    找出所有不同的 original_name（大小写不敏感）
        names = self._conn.execute(
            "SELECT DISTINCT LOWER(original_name) FROM knowledge_base WHERE is_deleted = 0"
        ).fetchall()

        for (name_key,) in names:
            # 该同名组下所有文件
            recs = self._conn.execute(
                "SELECT file_id, import_group_id, create_time FROM knowledge_base "
                "WHERE LOWER(original_name) = ? AND is_deleted = 0 "
                "ORDER BY create_time ASC",
                (name_key,),
            ).fetchall()

            if len(recs) <= 1:
                continue

            # 优先使用已有的有效 import_group_id（非空）
            existing_groups = [r[1] for r in recs if r[1]]
            group_id = existing_groups[0] if existing_groups else f"group-{uuid.uuid4().hex[:12]}"

            # 统一 group_id，按 create_time 分配版本号
            for idx, rec in enumerate(recs):
                file_id, current_group, _ = rec
                version = idx + 1
                if current_group != group_id:
                    self._conn.execute(
                        "UPDATE knowledge_base SET import_group_id = ?, version = ? "
                        "WHERE file_id = ?",
                        (group_id, version, file_id),
                    )
                elif current_group == group_id:
                    # 同组但版本号可能不对，更新版本号
                    self._conn.execute(
                        "UPDATE knowledge_base SET version = ? WHERE file_id = ?",
                        (version, file_id),
                    )

        self._conn.commit()

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
    folder_id VARCHAR(64),
    version INTEGER NOT NULL DEFAULT 1,
    original_name VARCHAR(256) NOT NULL DEFAULT '',
    import_group_id VARCHAR(64) NOT NULL DEFAULT '',
    is_deleted INTEGER NOT NULL DEFAULT 0,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS knowledge_folders (
    folder_id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(256) NOT NULL,
    parent_id VARCHAR(64),
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP
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
