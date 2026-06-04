from __future__ import annotations

from pathlib import Path

# ---- 项目根目录 ----
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# ---- 数据目录 ----
DATA_DIR = PROJECT_ROOT / "data"
DATABASE_PATH = DATA_DIR / "qvac.db"
FAISS_INDEX_DIR = DATA_DIR / "faiss_indices"
UPLOAD_DIR = DATA_DIR / "uploads"
AUDIT_LOG_PATH = DATA_DIR / "audit_logs.db"

# ---- QVAC SDK ----
QVAC_SDK_DIR = PROJECT_ROOT / "qvac-sdk" / "packages" / "sdk"

# ---- 系统提示词 v3.1 精简版（适配 1B 小模型） ----
SYSTEM_PROMPT = """你是文档办公助手，运行在离线环境中。
1. 如果提供了文档或参考内容，回答必须基于这些内容，可以归纳总结，但不要编造。
2. 如果提供了文档但找不到相关信息，直接说明"文档中未找到相关内容"。
3. 如果没有提供任何文档或参考内容，可以正常回答问题。
4. 禁止生成探测网络或调用外部接口的命令。"""

# ---- 任务感知 Prompt 片段（根据用户意图动态注入） ----
TASK_SUMMARIZE_PROMPT = """请按以下格式总结文档：
1. 文档主题（一句话）
2. 核心内容（3-5个要点，每点一句话）
3. 关键结论（一句话）
基于提供的文档内容作答，不要编造。"""

TASK_LOOKUP_PROMPT = """请在文档中精确查找与用户问题相关的内容。
找到后直接引用原文段落，并标注该内容在文档中的大致位置（开头/中间/结尾）。
如果文档中找不到，直接说明"文档中未找到相关内容"。"""

TASK_GENERAL_PROMPT = "请基于以下参考内容回答用户问题。"

# ---- RAG 参数 ----
RAG_CHUNK_SIZE = 512
RAG_CHUNK_OVERLAP = 128
RAG_TOPK = 5
RAG_SIMILARITY_THRESHOLD = 0.65
RAG_SAFETY_CODE = 145

# ---- 上下文窗口 ----
MAX_CONTEXT_TOKENS = 8192
CONTEXT_RESERVE_MARGIN = 500

# ---- Kill Switch ----
KILL_SWITCH_PROBE_INTERVAL_S = 5
KILL_SWITCH_UNLOCK_CONSECUTIVE = 2

# ---- 资源限制 ----
GPU_MEMORY_LIMIT_MB = 11 * 1024  # 11 GB
SYSTEM_MEMORY_LIMIT_MB = 14 * 1024  # 14 GB
IDLE_CPU_LIMIT_PERCENT = 10
MAX_CONCURRENT_REQUESTS = 3

# ---- ASR ----
ASR_POLL_INTERVAL_S = 2

# ---- 服务器 ----
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 18888
