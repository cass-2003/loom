"""Loom 全局可变状态。

所有需要修改这些变量的模块必须通过 `import wb.state` 然后
`wb.state.ROOT = ...` 来修改，不能用 `from wb.state import ROOT`
后直接赋值（会创建局部绑定而非修改模块级变量）。
"""
import sys
import threading
from pathlib import Path

# PyInstaller 打包目录
if getattr(sys, "frozen", False):
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    APP_DIR = Path(sys.executable).resolve().parent
else:
    BUNDLE_DIR = Path(__file__).resolve().parent.parent
    APP_DIR = BUNDLE_DIR
BASE_DIR = BUNDLE_DIR
STATIC_DIR = (BUNDLE_DIR / "static").resolve()
DOCS_DIR = (BUNDLE_DIR / "docs").resolve()

# 工作区状态
ROOT: Path | None = Path("/")
WORKSPACE_ROOTS: list[Path] = []
NO_WORKSPACE = None

# 配置文件读写锁
_CFG_LOCK = threading.RLock()
