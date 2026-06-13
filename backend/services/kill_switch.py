"""
Kill Switch 网络探针守护 — 最高优先级控制反转。

仅检测本项目进程 (Python 后端 + Node.js Bridge) 的 TCP 连接，
不检测设备整体网络状态。127.0.0.0/8 回环地址自动过滤。
"""
import os
import signal
import socket
import threading
import time
from dataclasses import dataclass

import psutil

from backend.config import KILL_SWITCH_PROBE_INTERVAL_S, KILL_SWITCH_UNLOCK_CONSECUTIVE
from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType
from backend.state_machine import StateCode, get_state_manager

# 合法的非外联远程地址前缀 (回环 + 绑定地址)
_SAFE_REMOTE_PREFIXES = ("127.", "0.0.0.0", "::1", "0:0:0:0")


@dataclass
class KillSwitchState:
    locked: bool = False
    consecutive_pass: int = 0


class KillSwitch:
    """网络探针守护 — 最高优先级控制反转。

    - 独立守护线程每 5s 枚举本项目进程的 TCP 连接 (仅检测项目进程出站，不检测设备整体网络)
    - 检测到外联 → SIGINT 中止推理 → 清空 TTS/ASR 缓冲 → DB status=999 → 前端覆黑
    - 连续 2 次无外联 → 自动解锁 → status=100 IDLE
    """

    def __init__(self):
        self._state = KillSwitchState()
        self._running = False
        self._thread: threading.Thread | None = None
        self._llm_pid: int | None = None
        self._bridge_pid: int | None = None
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

    def register_bridge_pid(self, pid: int) -> None:
        self._bridge_pid = pid

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
                    logger.log(LogType.KILL_SWITCH, {
                        "event": "probe_pass",
                        "consecutive": self._state.consecutive_pass,
                    })

            time.sleep(KILL_SWITCH_PROBE_INTERVAL_S)

    def _discover_bridge_pid(self) -> int | None:
        """自动发现 Bridge Node.js 进程 PID (监听 127.0.0.1:18889)。"""
        try:
            for proc in psutil.process_iter(['pid', 'name']):
                try:
                    if proc.info['name'] and 'node' in proc.info['name'].lower():
                        for conn in proc.connections(kind='inet'):
                            if conn.laddr and conn.laddr.port == 18889:
                                return proc.pid
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
        except Exception:
            pass
        return None

    def _check_outbound(self) -> bool:
        """检查本项目进程是否存在非回环 TCP 连接。

        仅枚举 Python 后端 + Node.js Bridge 进程的 TCP 连接表。
        回环地址 (127.0.0.0/8) 和绑定地址 (0.0.0.0) 自动过滤。
        设备自身的 WiFi/以太网连接状态不影响判定。
        """
        pids_to_check: set[int] = {os.getpid()}

        if self._bridge_pid:
            pids_to_check.add(self._bridge_pid)
        else:
            bridge_pid = self._discover_bridge_pid()
            if bridge_pid:
                self._bridge_pid = bridge_pid
                pids_to_check.add(bridge_pid)

        for pid in list(pids_to_check):
            try:
                proc = psutil.Process(pid)
                for conn in proc.connections(kind='inet'):
                    if conn.family != socket.AF_INET:
                        continue

                    if not conn.raddr:
                        continue

                    remote_ip = conn.raddr.ip if hasattr(conn.raddr, 'ip') else conn.raddr[0]
                    if not remote_ip:
                        continue

                    if any(remote_ip.startswith(prefix) for prefix in _SAFE_REMOTE_PREFIXES):
                        continue

                    get_audit_logger().log(LogType.KILL_SWITCH, {
                        "event": "outbound_detected",
                        "pid": pid,
                        "remote_ip": remote_ip,
                        "remote_port": conn.raddr.port if hasattr(conn.raddr, 'port') else conn.raddr[1],
                        "status": conn.status,
                    })

                    return True

            except psutil.NoSuchProcess:
                if pid == self._bridge_pid:
                    self._bridge_pid = None
                continue
            except psutil.AccessDenied:
                continue
            except Exception:
                continue

        return False

    def _execute_lockdown(self, logger, state_mgr) -> None:
        logger.log(LogType.KILL_SWITCH, {
            "event": "lockdown_triggered",
            "llm_pid": self._llm_pid,
        }, "Project process non-loopback connection detected — executing kill switch")

        self._state.locked = True

        if self._llm_pid:
            try:
                os.kill(self._llm_pid, signal.SIGINT)
            except OSError:
                pass

        self._tts_buffer.clear()
        self._asr_queue.clear()

        # 强切所有运行中的 ASR 异步任务，写入 INTERRUPTED_BY_COMPLIANCE_LOCK
        # — 严格对齐技术文档 §3.2 伪代码 step5
        try:
            from backend.api.asr import mark_all_running_as_interrupted
            interrupted_count = mark_all_running_as_interrupted()
            if interrupted_count:
                logger.log(LogType.KILL_SWITCH, {
                    "event": "asr_tasks_interrupted",
                    "count": interrupted_count,
                })
        except Exception as exc:
            logger.log(LogType.ERROR, {
                "event": "asr_interrupt_mark_failed",
                "error_class": type(exc).__name__,
            }, str(exc))

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
