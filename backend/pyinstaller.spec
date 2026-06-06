# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for QVAC Backend (FastAPI + uvicorn)."""

import sys
from pathlib import Path

# 项目根目录 (spec 文件所在目录的父目录)
PROJECT_ROOT = Path(SPECPATH).resolve().parent

# 后端源码路径
BACKEND_SRC = PROJECT_ROOT / "backend"

# 隐式依赖 (PyInstaller 可能检测不到的)
HIDDEN_IMPORTS = [
    "keyring.backends.Windows",
    "keyring.backends.fail",
    "keyring.backend",
    "keyring.credentials",
    "keyring.errors",
    "keyring.util.platform_",
    "cryptography.hazmat.primitives.ciphers.aead",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "fastapi",
    "pydantic",
    "numpy",
    "psutil",
    "httpx",
    "multipart",
    "aiofiles",
]

# 数据文件
DATAS = [
    # 如需打包配置文件或其他数据文件，在此添加
]

# nvidia-ml-py 为可选导入（无 GPU 时可能失败）
HIDDEN_IMPORTS += ["nvidia_ml_py", "pynvml"]

a = Analysis(
    [str(BACKEND_SRC / "main.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=DATAS,
    hiddenimports=HIDDEN_IMPORTS,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter", "matplotlib", "PIL", "PyQt5", "PySide2",
        "notebook", "jupyter", "IPython", "scipy", "pandas",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # 无控制台窗口（后台服务）
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch="x86_64",
    codesign_identity=None,
    entitlements_file=None,
    icon=str(PROJECT_ROOT / "frontend" / "build" / "icon.ico") if (PROJECT_ROOT / "frontend" / "build" / "icon.ico").exists() else None,
)
