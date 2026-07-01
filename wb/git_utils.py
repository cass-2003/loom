"""Git 辅助函数。"""
import subprocess
from pathlib import Path

from wb.constants import _NO_WINDOW


def run_git(args, cwd):
    """运行 git, 返回 (returncode, stdout, stderr)。"""
    try:
        p = subprocess.run(
            ["git", "-c", "core.quotepath=false"] + args,
            cwd=str(cwd), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=30,
            creationflags=_NO_WINDOW,
        )
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return -1, "", "未找到 git 命令"
    except subprocess.TimeoutExpired:
        return -1, "", "git 执行超时"
