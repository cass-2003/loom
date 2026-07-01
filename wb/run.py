"""命令执行辅助。"""
import os
import subprocess
import sys
from pathlib import Path

from wb.constants import EXEC_TIMEOUT, _NO_WINDOW


def _python_interp():
    """跑 .py 用的解释器。打包时 sys.executable 是 Loom.exe，改去 PATH 找真 python。"""
    if not getattr(sys, "frozen", False) and sys.executable:
        return sys.executable
    import shutil
    for name in ("python", "python3", "py"):
        p = shutil.which(name)
        if p:
            return p
    return "python"


RUN_INTERPRETERS = {
    ".py": [_python_interp()],
    ".js": ["node"],
    ".mjs": ["node"],
    ".cjs": ["node"],
    ".ts": ["node"],
    ".sh": ["bash"],
    ".bash": ["bash"],
    ".rb": ["ruby"],
    ".php": ["php"],
    ".pl": ["perl"],
    ".ps1": ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
}


def _kill_proc_tree(p):
    """杀掉进程及其整棵子树。"""
    if sys.platform == "win32":
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                           creationflags=_NO_WINDOW, capture_output=True, timeout=5)
            return
        except Exception:
            pass
    else:
        try:
            import signal
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            return
        except Exception:
            pass
    try:
        p.kill()
    except Exception:
        pass


def run_shell(cmd: str, cwd: Path, timeout: int = EXEC_TIMEOUT):
    """执行 shell 命令，返回 (code, stdout, stderr)。"""
    kw = {}
    if sys.platform != "win32":
        kw["start_new_session"] = True
    try:
        p = subprocess.Popen(
            cmd, cwd=str(cwd), shell=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
            creationflags=_NO_WINDOW, **kw,
        )
    except OSError as e:
        return -1, "", f"执行失败: {e}"
    try:
        out, err = p.communicate(timeout=timeout)
        return p.returncode, out, err
    except subprocess.TimeoutExpired:
        _kill_proc_tree(p)
        try:
            out, err = p.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            out, err = "", ""
        return -1, out or "", ((err or "") + f"\n[执行超时：超过 {timeout} 秒已终止]").strip()


def run_argv(argv, cwd: Path, timeout: int = EXEC_TIMEOUT):
    """以参数数组执行（不过 shell），返回 (code, stdout, stderr)。"""
    try:
        p = subprocess.run(
            argv, cwd=str(cwd), shell=False, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=timeout,
            creationflags=_NO_WINDOW,
        )
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return -1, "", f"未找到解释器: {argv[0]}"
    except subprocess.TimeoutExpired:
        return -1, "", f"[执行超时：超过 {timeout} 秒已终止]"
    except OSError as e:
        return -1, "", f"执行失败: {e}"
