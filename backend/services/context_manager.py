from __future__ import annotations

from dataclasses import dataclass, field

from backend.config import MAX_CONTEXT_TOKENS, CONTEXT_RESERVE_MARGIN, SYSTEM_PROMPT


@dataclass
class ChatMessage:
    message_id: str
    role: str
    content: str
    token_count: int = 0


@dataclass
class ContextAssembly:
    messages: list[ChatMessage] = field(default_factory=list)
    system_prompt_tokens: int = 0
    rag_topk_tokens: int = 0
    total_tokens: int = 0
    memory_truncated: bool = False
    truncated_message_ids: list[str] = field(default_factory=list)


class ContextManager:
    """上下文窗口动态管理器（OOM 防护算法）。

    水位线: 8192 - T_sys - T_rag_topk - 500
    截断策略: 保留 System Prompt + 当前 Query + RAG 片段；裁剪历史头部 1/2。
    严禁使用固定 Token 数做截断判定。
    """

    def __init__(self):
        self._max_tokens = MAX_CONTEXT_TOKENS
        self._reserve = CONTEXT_RESERVE_MARGIN
        self._system_prompt = SYSTEM_PROMPT
        self._system_tokens: int = 0
        self._rag_topk_tokens: int = 0

    def set_system_tokens(self, count: int) -> None:
        self._system_tokens = count

    @property
    def watermark(self) -> int:
        return self._max_tokens - self._system_tokens - self._rag_topk_tokens - self._reserve

    def assemble(
        self,
        history: list[ChatMessage],
        current_query: ChatMessage,
        rag_chunks: list[str],
        rag_topk_tokens: int = 0,
    ) -> ContextAssembly:
        self._rag_topk_tokens = rag_topk_tokens
        limit = self.watermark

        # 锁定不可裁剪项
        locked_tokens = current_query.token_count + rag_topk_tokens
        result = ContextAssembly()

        if locked_tokens >= limit:
            result.system_prompt_tokens = self._system_tokens
            result.rag_topk_tokens = rag_topk_tokens
            result.total_tokens = locked_tokens
            result.messages = [current_query]
            return result

        available = limit - locked_tokens

        # 二分法裁剪历史 — 保留尾部消息
        kept: list[ChatMessage] = []
        accumulated = 0
        truncated_ids: list[str] = []

        for msg in reversed(history):
            if accumulated + msg.token_count <= available:
                kept.insert(0, msg)
                accumulated += msg.token_count
            else:
                truncated_ids.append(msg.message_id)

        kept.append(current_query)

        result.system_prompt_tokens = self._system_tokens
        result.rag_topk_tokens = rag_topk_tokens
        result.messages = kept
        result.total_tokens = self._system_tokens + accumulated + locked_tokens
        result.memory_truncated = len(truncated_ids) > 0
        result.truncated_message_ids = truncated_ids

        return result

    @staticmethod
    def estimate_tokens(text: str) -> int:
        """粗糙 Token 估算（未接入 QVAC Tokenizer 时的 fallback）。

        中文约 1.5 字符/token，英文约 4 字符/token。
        实际部署时应替换为 QVAC SDK Tokenizer 动态计算。
        """
        char_count = len(text)
        chinese_chars = sum(1 for c in text if "一" <= c <= "鿿")
        non_chinese = char_count - chinese_chars
        return chinese_chars // 2 + non_chinese // 4 + 1
