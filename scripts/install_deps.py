"""
QVAC Assistant — 依赖自动安装器 (便携版)
用法: 双击运行，自动完成环境检测和依赖安装。
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

BACKEND_DIR = APP_ROOT / "backend"
DATA_DIR = APP_ROOT / "data"
MODELS_DIR = DATA_DIR / "models"
QVAC_DIR = APP_ROOT / "resources" / "app" / "node_modules" / "@qvac"

REQUIRED_MODELS = [
    {"name": "Llama-3.2-1B-Instruct-Q4_0.gguf", "size_mb": 773, "desc": "LLM 对话模型"},
    {"name": "gte-large_fp16.gguf", "size_mb": 670, "desc": "Embedding 向量模型"},
    {"name": "ggml-base.bin", "size_mb": 148, "desc": "ASR 语音转写模型"},
]

REQUIRED_QVAC_MODULES = [
    "@qvac/sdk",
    "@qvac/llm-llamacpp",
    "@qvac/embed-llamacpp",
    "@qvac/transcription-whispercpp",
    "@qvac/tts-onnx",
    "@qvac/onnx",
    "@qvac/rag",
    "@qvac/decoder-audio",
    "@qvac/error",
    "@qvac/langdetect-text",
    "@qvac/logging",
    "@qvac/registry-client",
    "@qvac/registry-schema",
    "@qvac/infer-base",
    "@qvac/response",
    "@qvac/diagnostics",
]


def print_header(title):
    print(f"\n{'=' * 50}")
    print(f"  {title}")
    print(f"{'=' * 50}")


def check_python():
    print_header("[1/6] Python 环境")
    v = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    print(f"  Python {v}")
    if sys.version_info >= (3, 12):
        print("  [OK]")
        return True
    print("  [FAIL] 需要 Python 3.12+")
    return False


def check_system():
    print_header("[2/6] 系统环境")
    try:
        import psutil
        ram_gb = round(psutil.virtual_memory().total / 1024**3, 1)
        print(f"  内存: {ram_gb} GB")
        if ram_gb < 14:
            print(f"  [WARN] 建议 16GB+，当前 {ram_gb}GB")
        else:
            print("  [OK]")
    except ImportError:
        print("  [WARN] 无法检测内存 (psutil 未安装)")

    # GPU 检测 (可选)
    try:
        import pynvml
        pynvml.nvmlInit()
        count = pynvml.nvmlDeviceGetCount()
        if count > 0:
            h = pynvml.nvmlDeviceGetHandleByIndex(0)
            info = pynvml.nvmlDeviceGetMemoryInfo(h)
            vram_gb = round(info.total / 1024**3, 1)
            name = pynvml.nvmlDeviceGetName(h)
            print(f"  GPU: {name} ({vram_gb} GB VRAM)")
            if vram_gb < 6:
                print(f"  [WARN] 建议 6GB+ VRAM，当前 {vram_gb}GB")
            else:
                print("  [OK]")
        else:
            print("  [WARN] 未检测到 NVIDIA GPU")
        pynvml.nvmlShutdown()
    except Exception:
        print("  [INFO] GPU 检测跳过 (无 NVIDIA 驱动或 pynvml)")

    return True


def find_system_python():
    """找到系统 Python 解释器（PyInstaller 打包后 sys.executable 指向自身，不能用于 pip）"""
    if not getattr(sys, 'frozen', False):
        return sys.executable  # 开发模式直接用当前 Python
    # PyInstaller 模式：搜索系统 Python
    candidates = [
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Python\Python312\python.exe"),
        r"C:\Python312\python.exe",
        r"C:\Program Files\Python312\python.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    # 兜底：PATH 上的 python
    found = shutil.which("python") or shutil.which("python3")
    return found


def install_pip():
    print_header("[3/6] Python 依赖安装")
    req = BACKEND_DIR / "requirements.txt"
    if not req.exists():
        print(f"  [WARN] {req} 不存在，跳过")
        return True

    python_exe = find_system_python()
    if not python_exe:
        print("  [WARN] 未找到系统 Python 解释器")
        print("  后端已编译为 resources/backend/backend.exe，无需额外安装")
        print("  如需直接运行 Python 源码，请手动执行: pip install -r backend/requirements.txt")
        return True

    print(f"  使用: {python_exe}")
    try:
        subprocess.run(
            [python_exe, "-m", "pip", "install", "-r", str(req), "--quiet"],
            check=True,
        )
        print("  [OK] Python 包安装完成")
        return True
    except subprocess.CalledProcessError as e:
        print(f"  [FAIL] pip install 失败: {e}")
        print(f"  可手动执行: pip install -r {req}")
        return False


def check_qvac():
    print_header("[4/6] QVAC SDK 检查")
    sdk_dir = QVAC_DIR / "sdk"
    if sdk_dir.exists() and (sdk_dir / "package.json").exists():
        print(f"  [OK] @qvac/sdk 已就绪: {QVAC_DIR}")
        total = 0
        for mod in REQUIRED_QVAC_MODULES:
            p = QVAC_DIR / mod.replace("@qvac/", "")
            if p.exists():
                total += 1
        print(f"  已安装模块: {total}/{len(REQUIRED_QVAC_MODULES)}")
        return True

    print("  [MISS] @qvac 包未找到!")
    print(f"  请将 @qvac 整个文件夹复制到:")
    print(f"  {QVAC_DIR}")
    print()
    print("  获取方式:")
    print("  1. 从已有的 QVAC SDK 安装中复制 frontend/node_modules/@qvac/")
    print("  2. 在联网环境中执行: cd resources/app && npm install @qvac/sdk")
    return False


def init_dirs():
    print_header("[5/6] 数据目录初始化")
    dirs = [
        DATA_DIR / "uploads",
        DATA_DIR / "faiss_indices",
        DATA_DIR / "logs",
        MODELS_DIR,
    ]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    print(f"  [OK] 数据目录就绪: {DATA_DIR}")


def check_models():
    print_header("[6/6] 模型文件检查")
    missing = []
    for m in REQUIRED_MODELS:
        p = MODELS_DIR / m["name"]
        if p.exists():
            mb = round(p.stat().st_size / 1024 / 1024, 0)
            print(f"  [OK] {m['name']} ({mb} MB) [{m['desc']}]")
        else:
            print(f"  [MISS] {m['name']} (~{m['size_mb']} MB) [{m['desc']}]")
            missing.append(m)
    if missing:
        print(f"\n  ⚠️  缺失 {len(missing)} 个模型文件，请放入:")
        print(f"  {MODELS_DIR}")
        for m in missing:
            print(f"    • {m['name']}")
        return False
    print("  [OK] 全部模型就绪")
    return True


def main():
    print("=" * 50)
    print("  QVAC Assistant — 依赖安装向导")
    print("=" * 50)
    print(f"  应用目录: {APP_ROOT}")
    print(f"  数据目录: {DATA_DIR}")
    print(f"  模型目录: {MODELS_DIR}")
    print(f"  SDK 目录: {QVAC_DIR}")

    results = {}
    results["python"] = check_python()
    results["system"] = check_system()
    results["pip"] = install_pip()
    results["qvac"] = check_qvac()
    init_dirs()
    results["models"] = check_models()

    # 汇总
    print("\n" + "=" * 50)
    print("  安装检查结果汇总")
    print("=" * 50)
    all_ok = True
    for k, v in results.items():
        status = "✅" if v else "❌"
        name = {"python": "Python 环境", "system": "系统环境",
                "pip": "Python 依赖", "qvac": "QVAC SDK",
                "models": "模型文件"}.get(k, k)
        print(f"  {status} {name}")
        if not v:
            all_ok = False

    if all_ok:
        print("\n  🎉 所有检查通过! 可以运行 一键启动.exe 启动应用。")
    else:
        print("\n  ⚠️  部分项目未通过，请根据上方提示处理。")
        print("  处理完成后可重新运行本程序验证。")
    input("\n按 Enter 退出...")


if __name__ == "__main__":
    main()
