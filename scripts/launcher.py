"""
QVAC Assistant 一键启动器
用法: 双击运行，自动启动后端 + 前端，等待模型加载完成后即可使用。
"""
import os
import sys
import subprocess
import time
import json
import urllib.request
import urllib.error
from pathlib import Path

if getattr(sys, 'frozen', False):
    APP_ROOT = Path(os.path.dirname(sys.executable))
else:
    APP_ROOT = Path(os.path.dirname(os.path.abspath(__file__))).parent

BACKEND_EXE = APP_ROOT / "resources" / "backend" / "backend.exe"
FRONTEND_EXE = APP_ROOT / "QVAC Assistant.exe"
DATA_DIR = APP_ROOT / "data"
MODELS_DIR = DATA_DIR / "models"
BACKEND_URL = "http://127.0.0.1:18888"


def print_header(text):
    print(f"\n{'─' * 40}\n  {text}\n{'─' * 40}")


def check_prerequisites():
    """启动前检查关键文件是否存在"""
    errors = []

    if not FRONTEND_EXE.exists():
        errors.append(f"前端程序不存在: {FRONTEND_EXE}")
    if not BACKEND_EXE.exists():
        errors.append(f"后端程序不存在: {BACKEND_EXE}")

    models = [
        "Llama-3.2-1B-Instruct-Q4_0.gguf",
        "gte-large_fp16.gguf",
        "ggml-base.bin",
    ]
    missing = [m for m in models if not (MODELS_DIR / m).exists()]
    if missing:
        print("\n[WARN] 模型文件缺失:")
        for m in missing:
            print(f"       - {m}")
        print(f"       请放入: {MODELS_DIR}")

    qvac_dir = APP_ROOT / "resources" / "app" / "node_modules" / "@qvac" / "sdk"
    if not qvac_dir.exists():
        errors.append(
            "@qvac/sdk 未找到。请将 @qvac 文件夹复制到:\n"
            f"  {APP_ROOT / 'resources' / 'app' / 'node_modules' / '@qvac'}"
        )

    if errors:
        print("\n[ERROR] 以下问题导致无法启动:")
        for e in errors:
            print(f"  - {e}")
        return False
    return True


def http_get_json(url, timeout=3):
    """HTTP GET 并解析 JSON 响应"""
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def wait_for_backend(timeout=30):
    """轮询等待 Python 后端 HTTP 服务就绪"""
    print("  等待后端服务启动...", end="", flush=True)
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = http_get_json(f"{BACKEND_URL}/health", timeout=2)
        if data and data.get("status") == "ok":
            print(" OK")
            return True
        time.sleep(1)
        print(".", end="", flush=True)
    print(" 超时")
    return False


def wait_for_models(timeout=120):
    """轮询等待 Bridge 模型加载完成 (LLM + Embedding)"""
    print("  等待 AI 模型加载 (首次约需 30-60 秒)...")
    deadline = time.time() + timeout
    last_state = None
    dots = 0
    while time.time() < deadline:
        data = http_get_json(f"{BACKEND_URL}/health", timeout=2)
        if not data:
            time.sleep(2)
            continue

        models = data.get("models", {})
        llm_ok = models.get("llm_loaded", False)
        embed_ok = models.get("embed_loaded", False)

        state = (llm_ok, embed_ok)
        if state != last_state:
            print(f"    LLM: {'已加载' if llm_ok else '加载中...':6s}  |  Embedding: {'已加载' if embed_ok else '加载中...'}")
            last_state = state

        if llm_ok and embed_ok:
            print("  [OK] 全部 AI 模型就绪，可以开始使用！")
            return True

        # 进度点（每 2s 一个）
        dots += 1
        if dots % 5 == 0:
            elapsed = int(time.time() - (deadline - timeout))
            print(f"    已等待 {elapsed}s / {timeout}s ...")

        time.sleep(2)

    print("  [WARN] 模型加载超时，部分功能可能不可用")
    return False


def kill_port_process(port):
    """终止占用指定端口的进程，避免端口冲突"""
    try:
        result = subprocess.run(
            f'netstat -ano | findstr :{port} | findstr LISTENING',
            capture_output=True, text=True, shell=True, timeout=5
        )
        if result.stdout.strip():
            for line in result.stdout.strip().splitlines():
                parts = line.split()
                if len(parts) >= 5:
                    pid = parts[-1]
                    try:
                        subprocess.run(
                            f'taskkill /pid {pid} /f /t 2>nul',
                            shell=True, capture_output=True
                        )
                        print(f"  清理旧进程 PID:{pid} (端口 {port})")
                    except Exception:
                        pass
    except Exception:
        pass


def main():
    print("=" * 50)
    print("  QVAC Assistant — 一键启动")
    print("=" * 50)
    print(f"  目录: {APP_ROOT}")

    if not check_prerequisites():
        input("\n按 Enter 退出...")
        sys.exit(1)

    # 清理可能残留的旧进程（端口冲突会导致启动失败）
    print("\n  检查端口占用...")
    kill_port_process(18888)
    kill_port_process(18889)

    for d in [DATA_DIR / "uploads", DATA_DIR / "faiss_indices", DATA_DIR / "logs"]:
        d.mkdir(parents=True, exist_ok=True)

    backend_proc = None
    frontend_proc = None

    try:
        # 1. 启动后端
        print_header("启动后端服务 (127.0.0.1:18888)")
        env = os.environ.copy()
        env["QVAC_DATA_DIR"] = str(DATA_DIR)
        env["QVAC_MODELS_DIR"] = str(MODELS_DIR)

        backend_proc = subprocess.Popen(
            [str(BACKEND_EXE)],
            cwd=str(BACKEND_EXE.parent),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print(f"  后端 PID: {backend_proc.pid}")

        if not wait_for_backend():
            print("\n  后端启动超时！请检查:")
            print(f"    - {DATA_DIR / 'logs'} 下的日志文件")
            print(f"    - {MODELS_DIR} 下是否有 3 个模型文件")
            print(f"    - {APP_ROOT / 'resources' / 'app' / 'node_modules' / '@qvac'} 是否完整")
            backend_proc.terminate()
            input("\n按 Enter 退出...")
            sys.exit(1)

        # 2. 启动前端 (Electron)
        print_header("启动前端应用")
        frontend_proc = subprocess.Popen(
            [str(FRONTEND_EXE)],
            cwd=str(APP_ROOT),
        )
        print(f"  前端 PID: {frontend_proc.pid}")

        # 3. 等待模型加载完成
        print_header("等待 AI 模型就绪")
        if not wait_for_models(timeout=120):
            print("  您仍可使用应用，但 AI 对话和翻译可能需要稍等片刻。")

        print("\n" + "=" * 50)
        print("  QVAC Assistant 已就绪！关闭主窗口即退出。")
        print("=" * 50 + "\n")

        # 4. 等待前端退出
        frontend_proc.wait()
        print("\n  前端已关闭，正在停止后端...")

    except KeyboardInterrupt:
        print("\n  正在退出...")
    finally:
        if frontend_proc and frontend_proc.poll() is None:
            frontend_proc.terminate()
            try:
                frontend_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                frontend_proc.kill()

        if backend_proc and backend_proc.poll() is None:
            backend_proc.terminate()
            try:
                backend_proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                backend_proc.kill()

    print("  QVAC Assistant 已完全退出。")


if __name__ == "__main__":
    main()
