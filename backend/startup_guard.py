#!/usr/bin/env python3
"""冷启动自检 — CREDENTIAL_LOST 检测 + Temp 残留清扫 + 数据库完整性检查。

对齐赛事规范 §3.4: 三步物理删除流程 (打标 → 异步擦除 → 冷启动自检)
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def run_self_check() -> dict:
    """执行完整的冷启动自检流程。

    Returns:
        {"status": "ok"|"warn"|"error", "items": [...], "errors": [...]}
    """
    results = {"status": "ok", "items": [], "errors": []}

    print("=== QVAC Hackathon 冷启动自检 ===")
    print()

    # Step 1: Windows 凭据管理器检查
    print("[1/6] Windows 凭据管理器检查...")
    from backend.crypto.aes_gcm import derive_key_from_credential, initialize_master_key

    key = derive_key_from_credential()
    if key:
        print("   [OK] 主密钥已就绪 (AES-256-GCM)")
        results["items"].append({"step": "credential", "status": "ok"})
    else:
        # 尝试自动初始化
        print("   [WARN] 主密钥未找到 — 尝试自动初始化...")
        key = initialize_master_key()
        if key:
            print("   [OK] 主密钥已自动生成并注入 Windows 凭据管理器")
            print("   [ACTION] 请通过 GET /api/v1/system/credential/export 导出恢复密钥")
            results["items"].append({"step": "credential", "status": "initialized"})
        else:
            print("   [ERROR] CREDENTIAL_LOST: 无法访问 Windows 凭据管理器")
            print("   [INFO] 请检查 keyring 是否正确安装")
            print("   [INFO] 数据库将以明文模式运行 (安全降级)")
            results["status"] = "warn"
            results["errors"].append("CREDENTIAL_LOST")
            results["items"].append({"step": "credential", "status": "missing"})

    # Step 2: 数据库初始化与完整性检查
    print("[2/6] 数据库初始化与完整性检查...")
    from backend.database.connection import DatabaseManager
    try:
        db = DatabaseManager.get_instance()
        tables = db.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        table_names = [t[0] for t in tables]
        required = ["knowledge_base", "asr_archive", "sessions", "chat_records", "rag_chunks"]
        missing = [t for t in required if t not in table_names]
        if missing:
            print(f"   [ERROR] 缺失表: {missing}")
            results["status"] = "error"
            results["errors"].append(f"missing_tables: {missing}")
        else:
            print(f"   [OK] 所有 {len(required)} 张表已就绪")
            results["items"].append({"step": "database", "status": "ok"})
    except Exception as e:
        print(f"   [ERROR] 数据库初始化失败: {e}")
        results["status"] = "error"
        results["errors"].append(f"database_init_failed: {e}")

    # Step 3: Temp 残留清扫
    print("[3/6] Temp 模式残留清扫...")
    try:
        rows = db.conn.execute(
            "SELECT file_id, file_name, file_path FROM knowledge_base WHERE isolate_mode = 'temp'"
        ).fetchall()
        if rows:
            from concurrent.futures import ThreadPoolExecutor
            executor = ThreadPoolExecutor(max_workers=2)
            cipher = db.cipher
            for fid, fname, fpath in rows:
                db.conn.execute("DELETE FROM rag_chunks WHERE file_id = ?", (fid,))
                db.conn.execute("DELETE FROM knowledge_base WHERE file_id = ?", (fid,))
                try:
                    actual_path = cipher.decrypt(fpath) if cipher else fpath
                except Exception:
                    actual_path = fpath

                def _remove(p):
                    try:
                        os.remove(p)
                    except OSError:
                        pass

                executor.submit(_remove, actual_path)
            db.conn.commit()
            print(f"   [CLEAN] 已清除 {len(rows)} 个 Temp 模式残留文件 (含物理擦除)")
            results["items"].append({"step": "temp_cleanup", "count": len(rows)})
        else:
            print("   [OK] 无 Temp 残留")
            results["items"].append({"step": "temp_cleanup", "count": 0})
    except Exception as e:
        print(f"   [WARN] Temp 清扫异常: {e}")

    # Step 4: 软删除 (is_deleted=1) 物理擦除
    print("[4/6] 软删除记录物理擦除...")
    try:
        deleted = db.conn.execute(
            "SELECT file_id, file_path FROM knowledge_base WHERE is_deleted = 1"
        ).fetchall()
        if deleted:
            from concurrent.futures import ThreadPoolExecutor
            executor = ThreadPoolExecutor(max_workers=2)
            cipher = db.cipher
            for fid, fpath in deleted:
                try:
                    actual_path = cipher.decrypt(fpath) if cipher else fpath
                except Exception:
                    actual_path = fpath

                def _erase(p):
                    try:
                        os.remove(p)
                    except OSError:
                        pass

                executor.submit(_erase, actual_path)
            db.conn.execute("DELETE FROM knowledge_base WHERE is_deleted = 1")
            db.conn.commit()
            print(f"   [CLEAN] 已物理擦除 {len(deleted)} 个标记删除文件")
            results["items"].append({"step": "deleted_cleanup", "count": len(deleted)})
        else:
            print("   [OK] 无待擦除记录")
            results["items"].append({"step": "deleted_cleanup", "count": 0})
    except Exception as e:
        print(f"   [WARN] 软删除擦除异常: {e}")

    # Step 5: FAISS 索引一致性检查
    print("[5/6] FAISS 向量索引一致性检查...")
    try:
        from pathlib import Path
        from backend.config import DATA_DIR

        index_path = DATA_DIR / "faiss_indices" / "default.index"
        meta_path = DATA_DIR / "faiss_indices" / "metadata.pkl"

        if index_path.exists():
            import os as _os
            size_mb = _os.path.getsize(index_path) / (1024 * 1024)
            print(f"   [OK] FAISS 索引已就绪 ({size_mb:.1f} MB)")
            results["items"].append({"step": "faiss_index", "status": "ok", "size_mb": round(size_mb, 1)})
        else:
            print("   [INFO] FAISS 索引尚未构建 (首次启动或知识库为空)")
            results["items"].append({"step": "faiss_index", "status": "empty"})

        if meta_path.exists():
            import pickle
            with open(meta_path, "rb") as f:
                meta = pickle.load(f)
            print(f"   [OK] 元数据: {len(meta)} 条向量记录")
            results["items"].append({"step": "faiss_metadata", "count": len(meta)})
    except Exception as e:
        print(f"   [WARN] FAISS 检查异常: {e}")

    # Step 6: ASR 中断任务恢复
    print("[6/6] ASR 中断任务恢复...")
    try:
        interrupted = db.conn.execute(
            "SELECT task_id FROM asr_archive WHERE transcribed_text LIKE 'INTERRUPTED%'"
        ).fetchall()
        if interrupted:
            print(f"   [INFO] 发现 {len(interrupted)} 个中断的 ASR 任务 (Kill Switch 触发)")
            results["items"].append({"step": "asr_interrupted", "count": len(interrupted)})
        else:
            print("   [OK] 无中断 ASR 任务")
            results["items"].append({"step": "asr_interrupted", "count": 0})
    except Exception:
        results["items"].append({"step": "asr_interrupted", "count": 0})

    print()
    print(f"=== 冷启动自检完成 | 状态: {results['status']} ===")

    if results["errors"]:
        print(f"错误: {', '.join(results['errors'])}")
        print("请运行 POST /api/v1/system/recover 进行灾备恢复。")

    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="QVAC Hackathon 冷启动自检")
    parser.add_argument("--self-check", action="store_true", help="执行标准自检流程")
    parser.add_argument("--json", action="store_true", help="输出 JSON 格式结果")
    args = parser.parse_args()

    if args.self_check or args.json:
        result = run_self_check()
        if args.json:
            import json
            print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        run_self_check()
