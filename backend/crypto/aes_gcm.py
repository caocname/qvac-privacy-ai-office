"""
AES-256-GCM 加解密 + Windows 凭据管理器密钥托管 + 灾备恢复。

主密钥生命周期:
1. 首次运行: 生成 32-byte 随机主密钥 → 注入 Windows Credential Manager
2. 正常运行: 从 Credential Manager 读取 → SHA-256 派生 32-byte → 用于 AES-256-GCM
3. 密钥丢失: 弹出灾备恢复 → 导入 .key 文件或 12 位助记词 → 重新注入凭据管理器
"""
from __future__ import annotations

import hashlib
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

CRED_SERVICE = "qvac-text"
CRED_ACCOUNT = "db-master-key"


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
        try:
            data = bytes.fromhex(encrypted_hex)
            nonce = data[:12]
            ciphertext = data[12:]
            plaintext = self._aesgcm.decrypt(nonce, ciphertext, None)
            return plaintext.decode("utf-8")
        except Exception:
            raise ValueError("Decryption failed — invalid key or corrupted data")


def _get_keyring():
    try:
        import keyring
        return keyring
    except ImportError:
        return None


def derive_key_from_credential() -> bytes | None:
    """从 Windows 凭据管理器读取主密钥，派生 32 字节 AES 密钥。

    返回 None 表示凭据丢失，需触发灾备恢复流程。
    """
    keyring = _get_keyring()
    if not keyring:
        return None
    try:
        stored = keyring.get_password(CRED_SERVICE, CRED_ACCOUNT)
        if not stored:
            return None
        return hashlib.sha256(stored.encode("utf-8")).digest()
    except Exception:
        return None


def initialize_master_key() -> bytes | None:
    """首次启动时生成本地主密钥并注入 Windows 凭据管理器。

    返回原始主密钥的 hex 表示（用于导出 .key 恢复文件）。
    若凭据已存在则返回 None。
    """
    keyring = _get_keyring()
    if not keyring:
        return None

    existing = derive_key_from_credential()
    if existing:
        return None

    # 生成 32 字节随机主密钥
    master_key = secrets.token_hex(32)
    try:
        keyring.set_password(CRED_SERVICE, CRED_ACCOUNT, master_key)
        return bytes.fromhex(master_key)
    except Exception:
        return None


def inject_key(key_material: str) -> bool:
    """将恢复密钥注入 Windows 凭据管理器。

    Args:
        key_material: 64 字符 hex 密钥 或 12 位助记词
    """
    keyring = _get_keyring()
    if not keyring:
        return False

    # 如果是 12 位助记词，通过 SHA-256 派生为 hex 密钥
    if len(key_material) <= 64 and " " in key_material:
        derived = hashlib.sha256(key_material.encode("utf-8")).hexdigest()
    else:
        derived = key_material.strip()

    if len(derived) != 64:
        return False

    try:
        keyring.set_password(CRED_SERVICE, CRED_ACCOUNT, derived)
        return True
    except Exception:
        return False


def export_recovery_key() -> str | None:
    """导出恢复密钥（64 字符 hex），供用户保存为 .key 文件。"""
    key = derive_key_from_credential()
    if not key:
        return None
    # 返回派生的 32-byte 密钥的 hex 表示
    return key.hex()


def generate_mnemonic() -> str:
    """生成 12 位中文助记词（用于灾备恢复的备选方案）。"""
    wordlist = [
        "山水", "日月", "风雷", "天地", "江河", "湖海",
        "松柏", "梅竹", "龙虎", "凤凰", "麒麟", "白鹤",
        "星辰", "云雾", "霜雪", "雷电", "金石", "玉石",
        "琴棋", "书画", "诗酒", "花茶", "笔墨", "纸砚",
    ]
    indices = [secrets.randbelow(len(wordlist)) for _ in range(12)]
    return " ".join(wordlist[i] for i in indices)
