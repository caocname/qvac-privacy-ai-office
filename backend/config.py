from __future__ import annotations

import os
import sys
from pathlib import Path

# ---- 运行模式检测 ----
IS_FROZEN = getattr(sys, "frozen", False)

if IS_FROZEN:
    # PyInstaller 打包模式：exe 所在目录为应用根
    APP_ROOT = Path(sys.executable).parent
else:
    # 开发模式：项目根目录
    APP_ROOT = Path(__file__).resolve().parent.parent

# ---- 数据目录 (生产模式使用 %APPDATA% 确保可写) ----
if IS_FROZEN:
    DATA_DIR = Path(os.environ.get("QVAC_DATA_DIR", os.path.join(os.environ.get("APPDATA", ""), "qvac-assistant", "data")))
else:
    DATA_DIR = APP_ROOT / "data"

DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_PATH = DATA_DIR / "qvac.db"
FAISS_INDEX_DIR = DATA_DIR / "faiss_indices"
UPLOAD_DIR = DATA_DIR / "uploads"
AUDIT_LOG_PATH = DATA_DIR / "audit_logs.db"

# ---- 模型目录 ----
if IS_FROZEN:
    # 生产模式：优先使用 QVAC_MODELS_DIR 环境变量，其次与 exe 同级的 models 目录，最后 fallback 到 data
    MODELS_DIR = Path(os.environ.get("QVAC_MODELS_DIR", APP_ROOT / "models" if (APP_ROOT / "models").exists() else DATA_DIR / "models"))
else:
    MODELS_DIR = DATA_DIR / "models"

# ---- QVAC SDK ----
QVAC_SDK_DIR = APP_ROOT / "qvac-sdk" / "packages" / "sdk"

# ---- 系统提示词 Sys-Prompt-v2.0-合规锁定版（严格对齐技术文档 §2.1） ----
SYSTEM_PROMPT = """【角色设定】
你是一个运行在全断网隔离环境下的本地隐私办公助手。你的核心职责是协助用户处理本地文档分析、会议记录摘要及本地知识库检索问答。

【行为硬性约束】
1. 事实一致性：当你基于本地知识库（RAG）回答问题时，你的所有内容必须 100% 来源于给出的"参考片段"。如果参考片段中没有相关信息，你必须无条件输出："未在本地知识库中检索到匹配内容，请尝试更换关键词。" 严禁虚构、幻觉、或结合你原有的外部预训练知识进行推理和衍生。
2. 禁区红线：严禁回答任何涉及全球时政、中国政治、国家安全、医疗处方诊断、法律诉讼、泛娱乐闲聊的内容。一经触发，强制输出固定兜底话术："当前系统仅支持离线办公、知识库分析及语音处理任务。"
3. 离线合规：严禁在输出中生成任何尝试探测网络、调用外部网络接口的代码、系统命令（如 curl, ping, wget 等）。

【兜底原则】
未提供文档且非禁区类时，可正常回答事实/技术类问题，但不要编造未知细节。"""

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

# ---- 违规提问前置关键词拦截（PRD §4.1 / TRD §2.8） ----
# 命中任意词即直接返回兜底话术，不下穿至 LLM，节省推理预算。
COMPLIANCE_BLOCKED_KEYWORDS = [
    # 时政 / 国安
    "习近平", "毛泽东", "邓小平", "江泽民", "胡锦涛", "李克强",
    "国家主席", "总书记", "中共", "共产党", "国务院", "政治局",
    "台独", "港独", "藏独", "疆独", "新疆", "西藏", "台湾独立",
    "六四", "天安门事件", "六四事件", "文革", "文化大革命",
    "颜色革命", "民运", "反共", "独裁", "极权",
    "trump", "biden", "putin", "白宫", "克里姆林宫",
    "国际局势", "地缘政治", "时政",
    # 医疗诊断
    "处方", "医嘱", "诊断", "确诊", "病理报告", "用药建议",
    "化疗", "放疗", "手术方案", "抗生素", "靶向药",
    # 法律诉讼
    "起诉", "诉讼", "判决", "上诉", "辩护词", "法律意见书",
    "刑事责任", "民事诉讼", "仲裁",
    # 泛娱乐闲聊
    "讲个笑话", "聊聊天", "陪我聊", "讲故事", "你的爱好",
    "你喜欢", "今天心情", "唱首歌",
]

COMPLIANCE_BLOCKED_RESPONSE = "当前系统仅支持离线办公、知识库分析及语音处理任务。"

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
