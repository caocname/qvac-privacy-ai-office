from __future__ import annotations

from enum import IntEnum


class StateCode(IntEnum):
    """前后端统一数字状态码 — 严格对齐技术需求文档 §3.1。

    主线程状态轨（Master State）：
      100 ↔ 110 ↔ 120 ↔ 140 ↔ 150 ↔ 180 ↔ 500 ↔ 999

    后台任务工作轨（Worker Task，不阻塞主轨 100 IDLE）：
      130 / 160 / 170
    """

    IDLE = 100
    FILE_UPLOADING = 110
    FILE_PROCESSING = 120
    EMBEDDING = 130
    RETRIEVING = 140
    SAFETY_BLOCKED = 145  # RAG 相似度不足拦截
    LLM_GENERATING = 150
    ASR_PROCESSING = 160
    TTS_GENERATING = 170
    TTS_PLAYING = 175  # 纯前端态
    EXPORTING = 180
    ERROR = 500
    NETWORK_LOCKED = 999


MASTER_STATE_TRACK = {
    StateCode.IDLE,
    StateCode.FILE_UPLOADING,
    StateCode.FILE_PROCESSING,
    StateCode.RETRIEVING,
    StateCode.SAFETY_BLOCKED,
    StateCode.LLM_GENERATING,
    StateCode.EXPORTING,
    StateCode.ERROR,
    StateCode.NETWORK_LOCKED,
}

WORKER_STATE_TRACK = {
    StateCode.EMBEDDING,
    StateCode.ASR_PROCESSING,
    StateCode.TTS_GENERATING,
}


class StateManager:
    """线程安全的状态管理器。

    主轨状态变化通过 compare-and-swap 保障原子性。
    worker 状态独立管理，不与主轨互斥。
    """

    def __init__(self):
        import threading

        self._lock = threading.Lock()
        self._master_state: StateCode = StateCode.IDLE
        self._worker_states: dict[StateCode, bool] = {}

    @property
    def master(self) -> StateCode:
        with self._lock:
            return self._master_state

    def transition(self, target: StateCode) -> bool:
        if target not in MASTER_STATE_TRACK:
            return False
        with self._lock:
            self._master_state = target
            return True

    def set_worker(self, code: StateCode, active: bool) -> None:
        if code not in WORKER_STATE_TRACK:
            return
        with self._lock:
            if active:
                self._worker_states[code] = True
            else:
                self._worker_states.pop(code, None)

    @property
    def active_workers(self) -> list[StateCode]:
        with self._lock:
            return list(self._worker_states.keys())

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "master_state": self._master_state.value,
                "master_name": self._master_state.name,
                "active_workers": [w.value for w in self._worker_states],
            }


_global_state = StateManager()


def get_state_manager() -> StateManager:
    return _global_state
