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

# ---- 系统提示词 v2.0 合规锁定版 ----
SYSTEM_PROMPT = """【角色设定】
你是一个运行在全断网隔离环境下的本地隐私办公助手。你的核心职责是协助用户处理本地文档分析、会议记录摘要及本地知识库检索问答。

【行为硬性约束】
1. 事实一致性：当你基于本地知识库（RAG）回答问题时，你的所有内容必须 100% 来源于给出的"参考片段"。如果参考片段中没有相关信息，你必须无条件输出："未在本地知识库中检索到匹配内容，请尝试更换关键词。" 严禁虚构、幻觉、或结合你原有的外部预训练知识进行推理和衍生。
2. 禁区红线：严禁回答任何涉及全球时政、中国政治、国家安全、医疗处方诊断、法律诉讼、泛娱乐闲聊的内容。一经触发，强制输出固定兜底话术："当前系统仅支持离线办公、知识库分析及语音处理任务。"
3. 离线合规：严禁在输出中生成任何尝试探测网络、调用外部网络接口的代码、系统命令（如 curl, ping, wget 等）。"""

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
