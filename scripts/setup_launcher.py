"""
QVAC Assistant — 系统环境一键安装
替代 setup.ps1，支持 PyInstaller 编译为独立 .exe
在新电脑上首次运行，自动检测环境并安装所有依赖。
"""
import os
import sys
import subprocess
import shutil
from pathlib import Path

if getattr(sys, 'frozen', False):
    APP_ROOT = Path(os.path.dirname(sys.executable))
else:
    APP_ROOT = Path(os.path.dirname(os.path.abspath(__file__))).parent


def _find_project_root():
    """向上查找项目根目录"""
    for p in [APP_ROOT] + list(APP_ROOT.parents):
        if (p / "backend" / "main.py").exists() and (p / "frontend" / "package.json").exists():
            return p
    return APP_ROOT


PROJECT_ROOT = _find_project_root()
DATA_DIR = PROJECT_ROOT / "data"
MODELS_DIR = DATA_DIR / "models"

PYTHON_CANDIDATES = [
    os.path.expandvars(r"$LOCALAPPDATA\Programs\Python\Python312\python.exe"),
    r"C:\Python312\python.exe",
    r"C:\Program Files\Python312\python.exe",
]

REQUIRED_MODELS = [
    ("Llama-3.2-1B-Instruct-Q4_0.gguf", 773, "LLM 对话模型"),
    ("gte-large_fp16.gguf", 670, "Embedding 向量模型"),
    ("ggml-base.bin", 148, "ASR 语音转写模型"),
]


def banner(title):
    print(f"\n{'=' * 50}\n  {title}\n{'=' * 50}\n")


def ask_continue(prompt="是否继续？(y/n): "):
    try:
        resp = input(prompt).strip().lower()
        return resp == "y"
    except (EOFError, KeyboardInterrupt):
        return False


# ── 环境检测 ──────────────────────────────────────────

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


def get_python_version(python_path):
    try:
        result = subprocess.run(
            [python_path, "--version"], capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip() + result.stderr.strip()
    except Exception:
        return None


def get_node_version():
    for name in ["node", "node.exe"]:
        try:
            result = subprocess.run(
                [name, "--version"], capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                v = result.stdout.strip().lstrip("v")
                return v
        except Exception:
            pass
    return None


def find_npm_cmd():
    for name in ["npm.cmd", "npm"]:
        try:
            result = subprocess.run(
                f"where {name}", capture_output=True, text=True, shell=True, timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip().splitlines()[0]
        except Exception:
            pass
    return None


# ── 安装步骤 ──────────────────────────────────────────

def step1_check_node(skip=False):
    if skip:
        return True
    print("[1/6] 检查 Node.js v22...")
    v = get_node_version()
    if v:
        major = int(v.split(".")[0])
        if major >= 22:
            print(f"  [OK] Node.js v{v} 已安装")
            return True
        else:
            print(f"  [WARN] Node.js 版本过低: v{v} (需要 >= 22)")
    else:
        print("  [ACTION] Node.js v22+ 未安装。")
    print("  下载地址: https://nodejs.org/dist/v22.18.0/node-v22.18.0-x64.msi")
    print("  或使用 winget: winget install OpenJS.NodeJS.LTS --version 22.18.0")
    return ask_continue()


def step2_check_python(skip=False):
    if skip:
        return None
    print("[2/6] 检查 Python 3.12...")
    python_path = find_python()
    if python_path:
        ver = get_python_version(python_path)
        if ver and "3.12" in ver:
            print(f"  [OK] Python {ver} ({python_path})")
            return python_path
        else:
            print(f"  [WARN] Python 版本不符合要求: {ver or '未知'} (需要 >= 3.12)")
    else:
        print("  [ACTION] Python 3.12 未安装。")
    print("  下载地址: https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe")
    print("  或使用 winget: winget install Python.Python.3.12")
    if ask_continue():
        return find_python()
    return None


def step3_npm_install(skip=False):
    if skip:
        return True
    print("[3/6] 安装前端 npm 依赖 (包含 Electron + QVAC SDK 原生模块)...")
    print("  这可能需要 5-10 分钟，请耐心等待...")
    frontend_dir = PROJECT_ROOT / "frontend"
    node_modules = frontend_dir / "node_modules"
    qvac_sdk = frontend_dir / "node_modules" / "@qvac" / "sdk"

    if qvac_sdk.exists():
        if not ask_continue("  前端依赖已存在，是否重新安装？(y/n): "):
            print("  [SKIP] 跳过前端依赖安装")
            return True
        print("  清理旧依赖...")
        shutil.rmtree(node_modules, ignore_errors=True)

    npm = find_npm_cmd()
    if not npm:
        print("  [ERROR] 找不到 npm，请先安装 Node.js v22")
        return False

    try:
        subprocess.run(
            [npm, "install", "--no-audit", "--no-fund"],
            cwd=str(frontend_dir),
            check=True,
        )
        print("  [OK] 前端依赖已安装")
        return True
    except subprocess.CalledProcessError as e:
        print(f"  [ERROR] npm install 失败: {e}")
        print("  请确认网络连接正常，或手动运行: cd frontend && npm install")
        return False


def step4_pip_install(python_path, skip=False):
    if skip:
        return True
    print("[4/6] 安装 Python 后端依赖...")
    if not python_path:
        python_path = find_python()
    if not python_path:
        print("  [ERROR] 找不到 Python 3.12")
        return False

    pip_exe = Path(python_path).parent / "Scripts" / "pip.exe"
    if not pip_exe.exists():
        pip_exe = Path(python_path).parent / "Scripts" / "pip3.exe"
    if not pip_exe.exists():
        print("  [ERROR] 找不到 pip。请先安装 Python 3.12 并确保 pip 可用")
        return False

    requirements = PROJECT_ROOT / "backend" / "requirements.txt"
    if not requirements.exists():
        print("  [ERROR] 找不到 requirements.txt")
        return False

    try:
        subprocess.run(
            [str(pip_exe), "install", "-r", str(requirements), "--quiet"],
            check=True,
        )
        print("  [OK] Python 依赖已安装")
        return True
    except subprocess.CalledProcessError as e:
        print(f"  [ERROR] pip install 失败: {e}")
        print(f"  请手动运行: {pip_exe} install -r {requirements}")
        return False


def step5_create_dirs():
    print("[5/6] 初始化数据目录...")
    dirs = [
        DATA_DIR / "uploads",
        DATA_DIR / "faiss_indices",
        DATA_DIR / "logs",
        DATA_DIR / "models",
    ]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    print("  [OK] 数据目录已创建")


def step6_verify_models():
    print("[6/6] 验证模型文件...")
    missing = []
    for name, size_mb, desc in REQUIRED_MODELS:
        model_path = MODELS_DIR / name
        if model_path.exists():
            actual_mb = round(model_path.stat().st_size / (1024 * 1024), 0)
            print(f"  [OK] {name} ({actual_mb} MB)")
        else:
            print(f"  [MISSING] {name} — {desc}")
            missing.append((name, size_mb, desc))

    if missing:
        print(f"\n  {'─' * 45}")
        print("  以下模型文件缺失:")
        for name, size_mb, desc in missing:
            print(f"    - {name} ({desc}, 约 {size_mb}MB)")
        print(f"\n  请将模型文件放入: {MODELS_DIR}")
        print(f"  或设置环境变量 QVAC_MODELS_DIR 指向模型目录")
        print(f"  {'─' * 45}")

    return len(missing) == 0


# ── 主流程 ────────────────────────────────────────────

def main():
    skip_node = "--skip-node" in sys.argv
    skip_python = "--skip-python" in sys.argv
    skip_npm = "--skip-npm" in sys.argv
    skip_pip = "--skip-pip" in sys.argv

    models_dir = None
    for arg in sys.argv:
        if arg.startswith("--models="):
            models_dir = arg.split("=", 1)[1]
            break

    global MODELS_DIR
    if models_dir:
        MODELS_DIR = Path(models_dir)
    elif os.environ.get("QVAC_MODELS_DIR"):
        MODELS_DIR = Path(os.environ["QVAC_MODELS_DIR"])

    banner("QVAC Assistant — 环境安装向导")
    print(f"  项目目录: {PROJECT_ROOT}")
    print(f"  模型目录: {MODELS_DIR}")

    # 1. Node.js
    if not step1_check_node(skip_node):
        print("\n已取消。请安装 Node.js v22 后重试。")
        input("\n按 Enter 退出...")
        sys.exit(1)

    # 2. Python
    python_path = step2_check_python(skip_python)
    if not python_path:
        print("\n已取消。请安装 Python 3.12 后重试。")
        input("\n按 Enter 退出...")
        sys.exit(1)

    # 3. npm install
    if not step3_npm_install(skip_npm):
        print("\nnpm 安装失败。请检查网络后重试。")
        input("\n按 Enter 退出...")
        sys.exit(1)

    # 4. pip install
    if not step4_pip_install(python_path, skip_pip):
        print("\npip 安装失败。")
        input("\n按 Enter 退出...")
        sys.exit(1)

    # 5. 数据目录
    step5_create_dirs()

    # 6. 模型验证
    all_models_ok = step6_verify_models()

    # 完成
    banner("环境安装完成!")
    if not all_models_ok:
        print("  !! 模型文件缺失，请按上述提示补充 !!\n")
    print("  启动应用:")
    print("    开发模式一键启动: QVAC开发启动器.exe")
    print("    或命令行: .\\scripts\\dev.ps1")
    print("=" * 50)

    input("\n按 Enter 退出...")


if __name__ == "__main__":
    main()
