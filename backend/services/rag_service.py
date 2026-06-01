"""
RAG 检索增强生成服务 — FAISS 向量检索 + QVAC Embedding。
"""
from __future__ import annotations

import os
import pickle
import uuid
from pathlib import Path

import numpy as np

from backend.config import (
    DATA_DIR,
    RAG_TOPK,
    RAG_SIMILARITY_THRESHOLD,
    RAG_SAFETY_CODE,
    RAG_CHUNK_SIZE,
    RAG_CHUNK_OVERLAP,
)
from backend.database.connection import DatabaseManager
from backend.logger.audit_logger import get_audit_logger
from backend.logger.log_models import LogType

FAISS_INDEX_PATH = DATA_DIR / "faiss_indices" / "default.index"
FAISS_META_PATH = DATA_DIR / "faiss_indices" / "metadata.pkl"


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-10))


class RAGService:
    """RAG 检索服务 — FAISS IndexFlatIP + Cosine 相似度过滤。"""

    def __init__(self):
        self._topk = RAG_TOPK
        self._threshold = RAG_SIMILARITY_THRESHOLD
        self._index = None
        self._metadata: dict[int, dict] = {}
        self._dim = 0

    def _ensure_loaded(self) -> bool:
        """懒加载 FAISS 索引。"""
        if self._index is not None:
            return True
        try:
            import faiss
            if FAISS_INDEX_PATH.exists():
                self._index = faiss.read_index(str(FAISS_INDEX_PATH))
                self._dim = self._index.d
                if FAISS_META_PATH.exists():
                    with open(FAISS_META_PATH, "rb") as f:
                        self._metadata = pickle.load(f)
                return True
        except Exception:
            pass
        return False

    def _create_index(self, dim: int) -> None:
        try:
            import faiss
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            FAISS_INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
            self._dim = dim
            self._index = faiss.IndexFlatIP(dim)
            self._metadata = {}
        except ImportError:
            pass

    def retrieve(
        self,
        query_embedding: np.ndarray,
        topk: int | None = None,
        isolate_mode: str = "global",
        session_id: str | None = None,
    ) -> dict:
        """执行 RAG 检索。

        Args:
            query_embedding: 查询向量
            topk: 检索 TopK
            isolate_mode: 隔离模式 (global/session/temp)
            session_id: 会话 ID

        Returns:
            {"code": 100, "chunks": [...], "similarities": [...]}
            或 {"code": 145, "chunks": [], "max_similarity": ...}
        """
        k = topk or self._topk
        logger = get_audit_logger()

        if not self._ensure_loaded():
            logger.log(LogType.RAG_RETRIEVAL, {
                "topk": k, "threshold": self._threshold,
                "status": "FAISS index not available",
            })
            return {
                "code": 145,
                "chunks": [],
                "similarities": [],
                "max_similarity": 0.0,
                "message": "FAISS 向量索引尚未构建，请先上传文档。",
            }

        # 确保向量维度匹配
        query = np.asarray(query_embedding, dtype=np.float32)
        if query.ndim == 1:
            query = query.reshape(1, -1)
        if query.shape[1] != self._dim:
            return {
                "code": 145,
                "chunks": [],
                "similarities": [],
                "max_similarity": 0.0,
                "message": "向量维度不匹配，请重新构建知识库索引。",
            }

        # FAISS 检索 (2*k 以允许后续隔离过滤)
        distances, indices = self._index.search(query, k * 2)
        distances = distances[0]
        indices = indices[0]

        # 隔离模式过滤 + Cosine 相似度阈值过滤
        results = []
        db = DatabaseManager.get_instance()
        for dist, idx in zip(distances, indices):
            if idx == -1:
                continue
            meta = self._metadata.get(int(idx), {})
            file_id = meta.get("file_id", "")
            chunk_content = meta.get("content", "")

            # 获取隔离信息
            if isolate_mode != "global":
                row = db.conn.execute(
                    "SELECT isolate_mode, session_id FROM knowledge_base WHERE file_id = ?",
                    (file_id,),
                ).fetchone()
                if not row:
                    continue
                file_isolate, file_sess = row
                # session 模式: 仅同一 session_id 可见
                if file_isolate == "session" and file_sess != session_id:
                    continue
                # temp 模式: 仅同一 session_id 可见
                if file_isolate == "temp" and file_sess != session_id:
                    continue

            similarity = float(dist)
            if similarity < self._threshold:
                continue

            results.append({
                "content": chunk_content,
                "similarity": similarity,
                "file_id": file_id,
                "file_name": meta.get("file_name", "未知"),
                "chunk_index": meta.get("chunk_index", 0),
                "chunk_id": meta.get("chunk_id", ""),
            })

        # 返回 TopK
        results = results[:k]

        logger.log(LogType.RAG_RETRIEVAL, {
            "topk": k,
            "threshold": self._threshold,
            "isolate_mode": isolate_mode,
            "session_id": session_id,
            "hit_count": len(results),
        })

        if not results:
            return {
                "code": 145,
                "chunks": [],
                "similarities": [],
                "max_similarity": 0.0,
                "message": "未检索到相关内容，请尝试更换关键词。",
            }

        return {
            "code": 100,
            "chunks": results,
            "similarities": [r["similarity"] for r in results],
            "max_similarity": max(r["similarity"] for r in results),
        }

    def index_document(
        self,
        file_id: str,
        file_name: str,
        chunks: list[str],
        embeddings: list[np.ndarray],
    ) -> int:
        """将文档分片写入 FAISS 索引 + 元数据。

        Returns:
            写入的向量数量
        """
        if not chunks or not embeddings:
            return 0

        emb_array = np.array(embeddings, dtype=np.float32)
        if emb_array.ndim == 1:
            emb_array = emb_array.reshape(1, -1)

        # 归一化 (用于 IP 等价 Cosine)
        import faiss
        faiss.normalize_L2(emb_array)

        # 首次时创建索引
        if self._index is None:
            self._create_index(emb_array.shape[1])
            if self._index is None:
                return 0

        # 确保维度匹配
        if emb_array.shape[1] != self._dim:
            return 0

        # 记录当前索引大小
        start_idx = self._index.ntotal

        # 写入 FAISS
        self._index.add(emb_array)

        # 写入元数据 + rag_chunks 表
        db = DatabaseManager.get_instance()
        for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
            chunk_id = f"chunk-{uuid.uuid4().hex[:12]}"
            faiss_id = start_idx + i

            self._metadata[faiss_id] = {
                "chunk_id": chunk_id,
                "file_id": file_id,
                "file_name": file_name,
                "chunk_index": i,
                "content": chunk_text,
            }

            # 写入数据库
            db.conn.execute(
                "INSERT INTO rag_chunks (chunk_id, file_id, chunk_index, content, token_count, faiss_vector_id) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (chunk_id, file_id, i, chunk_text, RAGService._estimate_tokens(chunk_text), faiss_id),
            )

        db.conn.commit()

        # 持久化 FAISS 索引和元数据
        self._save()

        return len(chunks)

    def _save(self) -> None:
        if self._index is None:
            return
        try:
            import faiss
            FAISS_INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
            faiss.write_index(self._index, str(FAISS_INDEX_PATH))
            with open(FAISS_META_PATH, "wb") as f:
                pickle.dump(self._metadata, f)
        except Exception:
            pass

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        char_count = len(text)
        chinese_chars = sum(1 for c in text if "一" <= c <= "鿿")
        non_chinese = char_count - chinese_chars
        return chinese_chars // 2 + non_chinese // 4 + 1
