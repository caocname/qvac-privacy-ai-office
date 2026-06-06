"""
QVAC Assistant — 开发模式一键启动器
替代 dev.ps1，支持 PyInstaller 编译为独立 .exe
用法: dev_launcher.exe [-Dev]
"""
import os
import sys
import subprocess
import time
import json
import urllib.request
import signal
from pathlib import Path

def _find_project_root():
    """向上查找项目根目录（包含 backend/main.py 和 frontend/package.json）"""
    if getattr(sys, 'frozen', False):
        start = Path(os.path.dirname(sys.executable))
    else:
        start = Path(os.path.dirname(os.path.abspath(__file__))).parent
    for p in [start] + list(start.parents):
        if (p / "backend" / "main.py").exists() and (p / "frontend" / "package.json").exists():
            return p
    return start

APP_ROOT = _find_project_root()

BACKEND_PORT = 18888
FRONTEND_PORT = 18889
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}"

PYTHON_CANDIDATES = [
    os.path.expandvars(r"$LOCALAPPDATA\Programs\Python\Python312\python.exe"),
    r"C:\Python312\python.exe",
    r"C:\Program Files\Python312\python.exe",
]


def find_python():
    for cand in PYTHON_CANDIDATES:
        if os.path.isfile(cand):
            return cand
    try:
        result = subprocess.run(
            "where python", capture_output=True, text=True, shell=True, timeout=5
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().splitlines()[0]
    except Exception:
        pass
    return None


def find_npx():
    """查找 npx.cmd（Windows 下 .cmd/.bat 才能被 subprocess 直接执行）"""
    for name in ["npx.cmd", "npx"]:
        try:
            result = subprocess.run(
                f"where {name}", capture_output=True, text=True, shell=True, timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip().splitlines()[0]
        except Exception:
            pass
    return None


def kill_port(port):
    try:
        result = subprocess.run(
            f'netstat -ano | findstr :{port}', capture_output=True, text=True, shell=True, timeout=5
        )
        if result.stdout.strip():
            for line in result.stdout.strip().splitlines():
                if "LISTENING" not in line:
                    continue
                parts = line.split()
                if len(parts) >= 5:
                    pid = parts[-1]
                    try:
                        subprocess.run(
                            f'taskkill /pid {pid} /f /t 2>nul',
                            shell=True, capture_output=True, timeout=5
                        )
                        print(f"  [清理] 端口 {port} 旧进程 PID:{pid}")
                    except Exception:
                        pass
    except Exception:
        pass


def http_get_json(url, timeout=3):
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def wait_for_backend(timeout=30):
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


def main():
    dev_mode = "-Dev" in sys.argv or "--dev" in sys.argv

    print("=" * 50)
    print("  QVAC Assistant — 开发模式一键启动")
    print("=" * 50)
    print(f"  项目目录: {APP_ROOT}")
    print(f"  开发模式: {'开启' if dev_mode else '关闭'}")
    print()

    python_path = find_python()
    if not python_path:
        print("[ERROR] 未找到 Python 3.12。请先运行 setup.ps1")
        input("按 Enter 退出...")
        sys.exit(1)
    print(f"  Python: {python_path}")

    npx_path = find_npx()
    if not npx_path:
        print("[ERROR] 未找到 npx。请安装 Node.js v22")
        input("按 Enter 退出...")
        sys.exit(1)
    print(f"  npx: {npx_path}")

    if not (APP_ROOT / "frontend" / "node_modules").exists():
        print("[ERROR] 前端依赖未安装，请先运行: cd frontend && npm install")
        input("按 Enter 退出...")
        sys.exit(1)

    print("\n[pre] 清理残留进程...")
    kill_port(BACKEND_PORT)
    kill_port(FRONTEND_PORT)
    time.sleep(1)

    backend_proc = None
    frontend_proc = None

    try:
        print(f"\n[1/2] 启动 Backend (127.0.0.1:{BACKEND_PORT})...")
        backend_proc = subprocess.Popen(
            [python_path, "-m", "uvicorn", "backend.main:app",
             "--host", "127.0.0.1", "--port", str(BACKEND_PORT),
             "--log-level", "warning"],
            cwd=str(APP_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print(f"  Backend PID: {backend_proc.pid}")

        if not wait_for_backend():
            print("\n[ERROR] 后端启动超时！")
            backend_proc.terminate()
            input("按 Enter 退出...")
            sys.exit(1)

        print(f"\n[2/2] 启动 Electron 前端 (内嵌 Bridge :{FRONTEND_PORT})...")
        frontend_dir = APP_ROOT / "frontend"
        if dev_mode:
            args = [npx_path, "electron", ".", "--dev"]
        else:
            args = [npx_path, "electron", "."]

        frontend_proc = subprocess.Popen(
            args,
            cwd=str(frontend_dir),
        )
        print(f"  前端 PID: {frontend_proc.pid}")

        print("\n" + "=" * 50)
        print("  QVAC Assistant 已启动！关闭前端窗口即退出。")
        print("=" * 50 + "\n")

        frontend_proc.wait()

    except KeyboardInterrupt:
        print("\n  正在退出...")
    finally:
        print("\n=== 正在关闭后台服务 ===")
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
        print("=== 已停止 ===")


if __name__ == "__main__":
    main()
