import os
import hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class AESCipher:
    """AES-256-GCM 加密/解密器，用于 SQLite 敏感字段的列级加密。"""

    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError("AES-256-GCM requires a 32-byte key")
        self._aesgcm = AESGCM(key)

    def encrypt(self, plaintext: str) -> str:
        nonce = os.urandom(12)
        ciphertext = self._aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
        return (nonce + ciphertext).hex()

    def decrypt(self, encrypted_hex: str) -> str:
        data = bytes.fromhex(encrypted_hex)
        nonce = data[:12]
        ciphertext = data[12:]
        plaintext = self._aesgcm.decrypt(nonce, ciphertext, None)
        return plaintext.decode("utf-8")


def derive_key_from_credential() -> bytes | None:
    """从 Windows 凭据管理器读取主密钥。

    返回 32 字节密钥，若凭据缺失则返回 None。
    """
    try:
        import keyring

        stored = keyring.get_password("qvac-text", "db-master-key")
        if not stored:
            return None
        return hashlib.sha256(stored.encode("utf-8")).digest()
    except Exception:
        return None
