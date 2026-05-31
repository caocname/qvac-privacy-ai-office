import threading
import time

from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType, SystemResourceMetric

DEFAULT_INTERVAL_S = 1.0


class ResourceSampler:
    """后台系统资源定时采样器。

    以固定间隔采集 GPU 显存、CPU 利用率、RAM 使用量，
    通过非阻塞 AuditLogger 写入 SYSTEM_RESOURCE 日志。
    赛事要求：资源时序日志需与演示视频画面时间一一对应。
    """

    def __init__(self, interval_s: float = DEFAULT_INTERVAL_S):
        self._interval = interval_s
        self._running = False
        self._thread: threading.Thread | None = None
        self._gpu_available = _check_gpu()

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._sample_loop, daemon=True, name="resource-sampler")
        self._thread.start()
        get_audit_logger().log(
            LogType.SYSTEM,
            {"event": "resource_sampler_started", "interval_s": self._interval, "gpu_available": self._gpu_available},
        )

    def stop(self) -> None:
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)

    def _sample_loop(self) -> None:
        logger = get_audit_logger()
        while self._running:
            metrics = _collect_metrics(self._gpu_available)
            logger.log(LogType.SYSTEM_RESOURCE, metrics)
            time.sleep(self._interval)


def _check_gpu() -> bool:
    try:
        import pynvml
        pynvml.nvmlInit()
        pynvml.nvmlDeviceGetCount()
        return True
    except Exception:
        return False


def _collect_metrics(gpu_available: bool) -> dict:
    metrics: dict = {}

    if gpu_available:
        try:
            import pynvml
            handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            info = pynvml.nvmlDeviceGetMemoryInfo(handle)
            metrics[SystemResourceMetric.GPU_MEMORY_MB] = round(info.used / (1024 * 1024), 1)
            metrics[SystemResourceMetric.GPU_MEMORY_TOTAL_MB] = round(info.total / (1024 * 1024), 1)
        except Exception:
            pass

    try:
        import psutil
        metrics[SystemResourceMetric.CPU_PERCENT] = round(psutil.cpu_percent(interval=0.1), 1)
        mem = psutil.virtual_memory()
        metrics[SystemResourceMetric.RAM_MB] = round(mem.used / (1024 * 1024), 1)
        metrics[SystemResourceMetric.RAM_TOTAL_MB] = round(mem.total / (1024 * 1024), 1)
    except Exception:
        pass

    return metrics
