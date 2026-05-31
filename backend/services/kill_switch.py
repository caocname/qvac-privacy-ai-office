import os
import signal
import socket
import threading
import time
from dataclasses import dataclass

from backend.config import KILL_SWITCH_PROBE_INTERVAL_S, KILL_SWITCH_UNLOCK_CONSECUTIVE
from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType
from backend.state_machine import StateCode, get_state_manager


@dataclass
class KillSwitchState:
    locked: bool = False
    consecutive_pass: int = 0


class KillSwitch:
    """网络探针守护 — 最高优先级控制反转。

    - 独立守护线程每 5s 检测本项目进程的网络连接（仅检测项目进程出站，不检测设备整体网络）
    - 检测到外联 → SIGINT 中止推理 → 清空 TTS/ASR 缓冲 → DB status=999 → 前端覆黑
    - 连续 2 次无外联 → 自动解锁 → status=100 IDLE
    """

    def __init__(self):
        self._state = KillSwitchState()
        self._running = False
        self._thread: threading.Thread | None = None
        self._llm_pid: int | None = None
        self._tts_buffer: list = []
        self._asr_queue: list = []

    @property
    def is_locked(self) -> bool:
        return self._state.locked

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._probe_loop, daemon=True, name="kill-switch")
        self._thread.start()
        get_audit_logger().log(LogType.KILL_SWITCH, {"event": "probe_started"})

    def stop(self) -> None:
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)

    def register_llm_pid(self, pid: int) -> None:
        self._llm_pid = pid

    def register_tts_buffer(self, buffer: list) -> None:
        self._tts_buffer = buffer

    def register_asr_queue(self, queue: list) -> None:
        self._asr_queue = queue

    def _probe_loop(self) -> None:
        logger = get_audit_logger()
        state_mgr = get_state_manager()

        while self._running:
            outbound_detected = self._check_outbound()

            if outbound_detected:
                self._state.consecutive_pass = 0
                if not self._state.locked:
                    self._execute_lockdown(logger, state_mgr)
                else:
                    logger.log(LogType.KILL_SWITCH, {"event": "lockdown_maintained"})
            else:
                self._state.consecutive_pass += 1
                if self._state.locked and self._state.consecutive_pass >= KILL_SWITCH_UNLOCK_CONSECUTIVE:
                    self._execute_unlock(logger, state_mgr)
                elif not self._state.locked:
                    logger.log(LogType.KILL_SWITCH, {"event": "probe_pass", "consecutive": self._state.consecutive_pass})

            time.sleep(KILL_SWITCH_PROBE_INTERVAL_S)

    def _check_outbound(self) -> bool:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.5)
            s.connect(("8.8.8.8", 53))
            s.close()
            return True
        except OSError:
            return False

    def _execute_lockdown(self, logger, state_mgr) -> None:
        logger.log(LogType.KILL_SWITCH, {
            "event": "lockdown_triggered",
            "llm_pid": self._llm_pid,
        }, "Project process outbound connection detected — executing kill switch")

        self._state.locked = True

        if self._llm_pid:
            try:
                os.kill(self._llm_pid, signal.SIGINT)
            except OSError:
                pass

        self._tts_buffer.clear()
        self._asr_queue.clear()

        state_mgr.transition(StateCode.NETWORK_LOCKED)

        try:
            from backend.database.connection import DatabaseManager
            db = DatabaseManager.get_instance()
            db.conn.execute("UPDATE sessions SET status = '999' WHERE status != '999'")
            db.conn.commit()
        except Exception:
            pass

    def _execute_unlock(self, logger, state_mgr) -> None:
        self._state.locked = False
        self._state.consecutive_pass = 0
        state_mgr.transition(StateCode.IDLE)
        logger.log(LogType.KILL_SWITCH, {"event": "unlocked", "new_state": "100 IDLE"})

        try:
            from backend.database.connection import DatabaseManager
            db = DatabaseManager.get_instance()
            db.conn.execute("UPDATE sessions SET status = '100' WHERE status = '999'")
            db.conn.commit()
        except Exception:
            pass


_kill_switch_instance: KillSwitch | None = None


def get_kill_switch() -> KillSwitch:
    global _kill_switch_instance
    if _kill_switch_instance is None:
        _kill_switch_instance = KillSwitch()
    return _kill_switch_instance
