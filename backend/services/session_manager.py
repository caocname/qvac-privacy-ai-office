import uuid
from datetime import datetime, timezone

from backend.database.connection import DatabaseManager
from backend.state_machine import StateCode


class SessionManager:
    """会话生命周期管理器。"""

    @staticmethod
    def create(title: str = "新会话") -> dict:
        db = DatabaseManager.get_instance()
        session_id = f"sess-{uuid.uuid4().hex[:16]}"
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        db.conn.execute(
            "INSERT INTO sessions (session_id, title, status, create_time, update_time) VALUES (?, ?, ?, ?, ?)",
            (session_id, title, str(StateCode.IDLE.value), now, now),
        )
        db.conn.commit()
        return {"session_id": session_id, "title": title, "status": StateCode.IDLE.value, "create_time": now}

    @staticmethod
    def list_sessions() -> list[dict]:
        db = DatabaseManager.get_instance()
        rows = db.conn.execute(
            "SELECT session_id, title, status, create_time, update_time FROM sessions ORDER BY update_time DESC"
        ).fetchall()
        return [
            {"session_id": r[0], "title": r[1], "status": r[2], "create_time": r[3], "update_time": r[4]}
            for r in rows
        ]

    @staticmethod
    def get(session_id: str) -> dict | None:
        db = DatabaseManager.get_instance()
        row = db.conn.execute(
            "SELECT session_id, title, status, create_time, update_time FROM sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if not row:
            return None
        return {"session_id": row[0], "title": row[1], "status": row[2], "create_time": row[3], "update_time": row[4]}

    @staticmethod
    def get_history(session_id: str) -> list[dict]:
        db = DatabaseManager.get_instance()
        rows = db.conn.execute(
            "SELECT message_id, role, content, token_count, is_truncated, create_time "
            "FROM chat_records WHERE session_id = ? ORDER BY create_time ASC",
            (session_id,),
        ).fetchall()
        return [
            {"message_id": r[0], "role": r[1], "content": r[2], "token_count": r[3], "is_truncated": bool(r[4]), "create_time": r[5]}
            for r in rows
        ]

    @staticmethod
    def append_message(session_id: str, role: str, content: str, token_count: int = 0) -> str:
        db = DatabaseManager.get_instance()
        message_id = f"msg-{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        db.conn.execute(
            "INSERT INTO chat_records (message_id, session_id, role, content, token_count, create_time) VALUES (?, ?, ?, ?, ?, ?)",
            (message_id, session_id, role, content, token_count, now),
        )
        db.conn.execute(
            "UPDATE sessions SET update_time = ? WHERE session_id = ?", (now, session_id)
        )
        db.conn.commit()
        return message_id
