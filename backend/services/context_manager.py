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
        # 启动时立即用经验公式给 System Prompt 估算一个 token 数；
        # 后续如有 Bridge 可用，async 路径会用 SDK Tokenizer 覆盖更新。
        self._system_tokens: int = ContextManager.estimate_tokens(SYSTEM_PROMPT)
        self._rag_topk_tokens: int = 0

    async def refresh_system_tokens(self) -> int:
        """通过 QVAC SDK Tokenizer 精确计算 System Prompt 的 token 数。

        建议在 chat.send 入口调用一次（每会话首问）。失败回退至构造时的近似值。
        """
        try:
            self._system_tokens = await ContextManager.estimate_tokens_async(self._system_prompt)
        except Exception:
            pass
        return self._system_tokens

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
        """Token 估算 — 同步路径只能用近似公式，异步精确路径见 estimate_tokens_async。

        Llama 3.x BPE 词表特性：
          - 中文（CJK 统一表意）≈ 1.55 字符/token
          - ASCII（英文/数字/符号）≈ 3.7 字符/token
          - 其他 Unicode（emoji/标点）≈ 2 字符/token
        """
        if not text:
            return 0
        cn = 0
        ascii_chars = 0
        other = 0
        for ch in text:
            cp = ord(ch)
            if 0x4E00 <= cp <= 0x9FFF:
                cn += 1
            elif 0x20 <= cp <= 0x7E:
                ascii_chars += 1
            else:
                other += 1
        # ceil(cn / 1.55) + ceil(ascii / 3.7) + ceil(other / 2.0) + 1
        return (
            -(-cn * 100 // 155)
            + -(-ascii_chars * 10 // 37)
            + -(-other // 2)
            + 1
        )

    @staticmethod
    async def estimate_tokens_async(text: str) -> int:
        """精确 Token 计数 — 通过 Bridge 调用 QVAC SDK BPE Tokenizer。

        失败时回退到经验公式。严格对齐技术文档 §2.2「实时调用 QVAC SDK 的
        Tokenizer 接口动态计算」要求。
        """
        if not text:
            return 0
        try:
            import httpx
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    "http://127.0.0.1:18889/api/llm/tokenize",
                    json={"texts": [text]},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    counts = data.get("counts") or []
                    if counts and isinstance(counts[0], (int, float)) and counts[0] > 0:
                        return int(counts[0])
        except Exception:
            pass
        return ContextManager.estimate_tokens(text)

    @staticmethod
    async def estimate_tokens_batch_async(texts: list[str]) -> list[int]:
        """批量精确 Token 计数 — 单次 Bridge 调用。"""
        if not texts:
            return []
        try:
            import httpx
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    "http://127.0.0.1:18889/api/llm/tokenize",
                    json={"texts": texts},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    counts = data.get("counts") or []
                    if len(counts) == len(texts) and all(isinstance(c, (int, float)) and c > 0 for c in counts):
                        return [int(c) for c in counts]
        except Exception:
            pass
        return [ContextManager.estimate_tokens(t) for t in texts]
