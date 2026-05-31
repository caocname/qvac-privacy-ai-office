#!/usr/bin/env python3
"""冷启动自检 — Temp 残留清扫 + 凭据校验 + 数据库完整性检查。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def run_self_check() -> bool:
    print("=== QVAC Hackathon 冷启动自检 ===")
    print()

    # 1. 凭据校验
    print("1. Windows 凭据管理器检查...")
    from backend.crypto.aes_gcm import derive_key_from_credential

    key = derive_key_from_credential()
    if key:
        print("   [OK] 主密钥已就绪")
    else:
        print("   [WARN] 主密钥未找到 — 数据库将以明文模式运行")
        print("   [INFO] 运行 /api/v1/system/recover 导入灾备 .key 文件")

    # 2. 数据库初始化
    print("2. 数据库初始化...")
    from backend.database.connection import DatabaseManager

    db = DatabaseManager.get_instance()
    print("   [OK] SQLite 表结构已就绪")

    # 3. Temp 残留清扫
    print("3. Temp 模式残留清扫...")
    rows = db.conn.execute(
        "SELECT file_id, file_name FROM knowledge_base WHERE isolate_mode = 'temp'"
    ).fetchall()
    if rows:
        for fid, fname in rows:
            db.conn.execute("DELETE FROM rag_chunks WHERE file_id = ?", (fid,))
            db.conn.execute("DELETE FROM knowledge_base WHERE file_id = ?", (fid,))
        db.conn.commit()
        print(f"   [CLEAN] 已清除 {len(rows)} 个 Temp 模式残留文件")
    else:
        print("   [OK] 无 Temp 残留")

    # 4. 软删除物理擦除
    print("4. 软删除物理擦除...")
    deleted = db.conn.execute(
        "SELECT file_id, file_path FROM knowledge_base WHERE is_deleted = 1"
    ).fetchall()
    if deleted:
        import os

        for fid, fpath in deleted:
            try:
                os.remove(fpath)
            except OSError:
                pass
        db.conn.execute("DELETE FROM knowledge_base WHERE is_deleted = 1")
        db.conn.commit()
        print(f"   [CLEAN] 已物理擦除 {len(deleted)} 个标记删除文件")
    else:
        print("   [OK] 无待擦除文件")

    print()
    print("=== 冷启动自检完成 ===")
    return True


if __name__ == "__main__":
    run_self_check()
