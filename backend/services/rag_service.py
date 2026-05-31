from __future__ import annotations

import numpy as np

from backend.config import RAG_TOPK, RAG_SIMILARITY_THRESHOLD
from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-10))


class RAGService:
    """RAG 检索增强生成服务骨 — FAISS 向量检索 + 相似度过滤。

    TopK=5, 余弦相似度阈值 0.65, 低于阈值返回 code:145。
    """

    def __init__(self):
        self._chunk_size = 512
        self._chunk_overlap = 128
        self._topk = RAG_TOPK
        self._threshold = RAG_SIMILARITY_THRESHOLD

    def retrieve(self, query_embedding: np.ndarray, topk: int | None = None) -> dict:
        """执行 RAG 检索（骨架 — 待接入 FAISS 索引和 QVAC Embedding）。

        返回:
          {"code": 100, "chunks": [...], "similarities": [...]}
          或
          {"code": 145, "message": "...", "chunks": [], "max_similarity": ...}
        """
        k = topk or self._topk
        logger = get_audit_logger()

        # TODO: 接入 QVAC Embedding 生成 query_embedding
        # TODO: 搜索 FAISS 索引获取 TopK 结果

        logger.log(LogType.RAG_RETRIEVAL, {
            "topk": k,
            "threshold": self._threshold,
            "status": "stub — FAISS index not connected",
        }, "RAG retrieval invoked (stub)")

        return {
            "code": 145,
            "chunks": [],
            "similarities": [],
            "max_similarity": 0.0,
            "message": "FAISS 向量索引尚未接入，RAG 检索返回空结果。",
        }

    def index_document(self, file_id: str, chunks: list[str], embeddings: list[np.ndarray]) -> None:
        """将文档分词并写入 FAISS 索引。

        TODO: 接入 QVAC Embedding + FAISS IndexFlatIP / IVFFlat
        """
        pass
