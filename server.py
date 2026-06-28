#!/usr/bin/env python3
"""Workbench - 本地工作台后端 (纯标准库)

用法:
    python server.py [工作根目录] [--port 8765]

不传根目录时默认当前盘符根 (脚本所在盘)。浏览器打开 http://localhost:<port>
"""
import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

# 打包(PyInstaller)后：静态资源被解压到 sys._MEIPASS；exe 自身目录用作默认工作根。
# 直接运行脚本时：两者都是脚本所在目录。
if getattr(sys, "frozen", False):
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    APP_DIR = Path(sys.executable).resolve().parent
else:
    BUNDLE_DIR = Path(__file__).resolve().parent
    APP_DIR = BUNDLE_DIR
BASE_DIR = BUNDLE_DIR
# 必须 resolve()：打包后 _MEIPASS 在 Temp 下可能是 8.3 短名(ADMINI~1)，
# 而 _serve_static 里 fp 是 resolve() 后的长名，不一致会导致包含性校验误判 403。
STATIC_DIR = (BUNDLE_DIR / "static").resolve()
DOCS_DIR = (BUNDLE_DIR / "docs").resolve()
ROADMAP_FILE = "轻量生态化路线.md"

# 这些扩展名按文本编辑处理。注：扩展名不在表里的文件，_api_file 还会做内容嗅探
# （无 NUL 字节且能 UTF-8 解码即当可编辑文本），所以杂项/无扩展名文本也能打开。
TEXT_EXTS = {
    ".md", ".markdown", ".txt", ".json", ".js", ".ts", ".jsx", ".tsx",
    ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".css",
    ".scss", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini",
    ".cfg", ".conf", ".sh", ".bash", ".ps1", ".bat", ".sql", ".csv",
    ".log", ".env", ".gitignore", ".dockerfile", ".vue", ".svelte",
    ".spec", ".properties", ".editorconfig", ".gitattributes", ".dockerignore",
    ".rb", ".php", ".lua", ".kt", ".kts", ".swift", ".dart", ".r", ".pl",
    ".tex", ".rst", ".diff", ".patch", ".tsv", ".proto", ".graphql", ".gql",
    ".tf", ".gradle", ".cmake", ".mk", ".lock", ".cs", ".scala", ".clj",
}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"}
MAX_TEXT_BYTES = 5 * 1024 * 1024  # 5MB 以上不当文本读
PROJECT_STATE_FILES = {
    "requirements": "REQUIREMENTS.md",
    "progress": "PROGRESS.md",
    "log": "LOG.md",
    "memory": "MEMORY.md",
}

ROOT = Path("/")  # 运行时覆盖
WORKSPACE_ROOTS = []  # 当前工作区包含的根目录（主根在第 0 项）
# 空工作区标记：启动时若没有合法的 lastRoot，ROOT 保持为哨兵目录，
# 前端通过 /api/config 的 hasWorkspace=false 渲染欢迎页而非文件树。
NO_WORKSPACE = None
# 配置文件读写锁（多线程 HTTP server 下，set-root 与读 config 可能并发）
_CFG_LOCK = threading.Lock()


def _config_dir() -> Path:
    """全局配置目录：打包版用 %APPDATA%/Workbench，脚本版用 ~/.workbench。
    跨会话持久化「最近工作区列表 / 上次活动根」，与 exe 升级解耦、多用户隔离。"""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return Path(base) / "Workbench"
    return Path.home() / ".workbench"


def _config_path() -> Path:
    return _config_dir() / "config.json"


def _notes_global_path() -> Path:
    """全局便签存储：与工作区无关，切换目录也保持同一份 Todo/便签。"""
    return _config_dir() / "notes.json"


def load_config() -> dict:
    """读取全局配置。损坏/缺失返回空骨架，绝不抛异常（启动路径依赖它）。"""
    empty = {"lastRoot": None, "recent": [], "currentWorkspace": None, "recentWorkspaces": []}
    fp = _config_path()
    if not fp.is_file():
        return empty
    try:
        # 兼容外部工具/PowerShell 可能写出的 UTF-8 BOM 配置文件，避免最近列表/上次工作区失忆。
        data = json.loads(fp.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict):
            return empty
        if not isinstance(data.get("recent"), list):
            data["recent"] = []
        if not isinstance(data.get("lastRoot"), str):
            data["lastRoot"] = None
        if data.get("currentWorkspace") is not None and not isinstance(data.get("currentWorkspace"), dict):
            data["currentWorkspace"] = None
        if not isinstance(data.get("recentWorkspaces"), list):
            data["recentWorkspaces"] = []
        _upgrade_workspace_config(data)
        return data
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return empty


def save_config(cfg: dict):
    """原子写全局配置。调用方持 _CFG_LOCK。"""
    fp = _config_path()
    try:
        fp.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(fp, json.dumps(cfg, ensure_ascii=False, indent=2).encode("utf-8"))
    except OSError:
        pass  # 配置写失败不应让 set-root 整体失败（内存 ROOT 已切好）


def _touch_recent(cfg: dict, root: Path):
    """把 root 登记为最近活动工作区：置 lastRoot + 插入/上提 recent 项。最多保留 10 项。"""
    root_str = str(root)
    cfg["lastRoot"] = root_str
    name = root.name or root_str
    # 去重：已存在则上提到列表首位
    cfg["recent"] = [r for r in cfg.get("recent", []) if r.get("path") != root_str]
    cfg["recent"].insert(0, {"path": root_str, "name": name, "lastUsed": _now_iso()})
    cfg["recent"] = cfg["recent"][:10]


def _norm_root_str(raw) -> str | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        p = Path(raw).resolve()
    except (OSError, ValueError):
        return None
    if not p.is_dir():
        return None
    return str(p)


def _workspace_label(roots: list[str]) -> str:
    if not roots:
        return "空工作区"
    first = Path(roots[0]).name or roots[0]
    return first if len(roots) == 1 else f"{first} +{len(roots) - 1}"


def _workspace_id(roots: list[str]) -> str | None:
    roots = [r for r in roots if isinstance(r, str) and r]
    if not roots:
        return None
    joined = "\n".join(roots).encode("utf-8")
    return "ws:" + hashlib.sha1(joined).hexdigest()[:16]


def _workspace_payload(roots: list[str], *, last_used=None) -> dict | None:
    roots = [r for r in roots if isinstance(r, str) and r]
    if not roots:
        return None
    return {
        "id": _workspace_id(roots),
        "name": _workspace_label(roots),
        "path": roots[0],
        "roots": roots,
        "lastUsed": last_used or _now_iso(),
    }


def _upgrade_workspace_config(cfg: dict):
    """把旧版单根 recent/lastRoot 配置升级为多根工作区配置（兼容读取，不强制立即重写）。"""
    cur = cfg.get("currentWorkspace")
    if isinstance(cur, dict):
      roots = [_norm_root_str(r) for r in cur.get("roots", [])]
      roots = [r for r in roots if r]
      cfg["currentWorkspace"] = _workspace_payload(roots, last_used=cur.get("lastUsed")) if roots else None
    else:
      last = _norm_root_str(cfg.get("lastRoot"))
      cfg["currentWorkspace"] = _workspace_payload([last], last_used=_now_iso()) if last else None

    upgraded = []
    seen = set()
    src = cfg.get("recentWorkspaces") if cfg.get("recentWorkspaces") else cfg.get("recent", [])
    for item in src:
        if isinstance(item, dict) and isinstance(item.get("roots"), list):
            roots = [_norm_root_str(r) for r in item.get("roots", [])]
            roots = [r for r in roots if r]
            payload = _workspace_payload(roots, last_used=item.get("lastUsed"))
        else:
            path = _norm_root_str(item.get("path") if isinstance(item, dict) else item)
            payload = _workspace_payload([path], last_used=(item.get("lastUsed") if isinstance(item, dict) else None)) if path else None
        if not payload or payload["id"] in seen:
            continue
        seen.add(payload["id"])
        upgraded.append(payload)
    cfg["recentWorkspaces"] = upgraded[:10]


def _touch_recent_workspace(cfg: dict, roots: list[Path]):
    root_strs = [str(r) for r in roots]
    payload = _workspace_payload(root_strs)
    if not payload:
        cfg["currentWorkspace"] = None
        cfg["lastRoot"] = None
        return
    cfg["currentWorkspace"] = payload
    cfg["lastRoot"] = root_strs[0]
    cfg["recent"] = [{"path": root_strs[0], "name": payload["name"], "lastUsed": payload["lastUsed"]}]
    recent = [w for w in cfg.get("recentWorkspaces", []) if w.get("id") != payload["id"]]
    recent.insert(0, payload)
    cfg["recentWorkspaces"] = recent[:10]


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def current_workspace_roots() -> list[Path]:
    if WORKSPACE_ROOTS:
        return WORKSPACE_ROOTS[:]
    return [ROOT] if ROOT is not None else []


def has_workspace() -> bool:
    return len(current_workspace_roots()) > 0


def set_workspace_roots(roots: list[Path]):
    global ROOT, WORKSPACE_ROOTS
    uniq = []
    seen = set()
    for root in roots or []:
        if root is None:
            continue
        try:
            rp = Path(root).resolve()
        except (OSError, ValueError):
            continue
        if not rp.is_dir():
            continue
        key = str(rp)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(rp)
    WORKSPACE_ROOTS = uniq
    ROOT = uniq[0] if uniq else None


def _split_workspace_path(rel: str) -> tuple[int, str]:
    rel = unquote(rel or "").lstrip("/\\")
    m = re.match(r"^@(\d+)(?:/(.*))?$", rel)
    if not m:
        return 0, rel
    return int(m.group(1)), (m.group(2) or "")


def _workspace_root_for_path(p: Path) -> tuple[int, Path] | tuple[None, None]:
    try:
        rp = p.resolve()
    except (OSError, ValueError):
        return None, None
    best = None
    for idx, root in enumerate(current_workspace_roots()):
        if rp == root or root in rp.parents:
            score = len(str(root))
            if best is None or score > best[0]:
                best = (score, idx, root)
    if best is None:
        return None, None
    return best[1], best[2]


def workspace_relpath(p: Path) -> str:
    idx, root = _workspace_root_for_path(p)
    if root is None:
        raise ValueError("path outside workspace")
    rel = str(p.resolve().relative_to(root)).replace("\\", "/")
    if idx == 0:
        return rel
    return f"@{idx}" + (f"/{rel}" if rel else "")


def resolve_workspace_detail(rel: str) -> tuple[Path, Path, int, str]:
    """把工作区路径解析为 (根目录, 绝对路径, 根索引, 根内相对路径)。"""
    roots = current_workspace_roots()
    if not roots:
        raise PermissionError("no workspace")
    idx, inner = _split_workspace_path(rel)
    if idx < 0 or idx >= len(roots):
        raise PermissionError("invalid workspace root")
    root = roots[idx]
    target = (root / inner).resolve()
    if target != root and root not in target.parents:
        raise PermissionError("path escapes root")
    return root, target, idx, inner


def safe_resolve(rel: str) -> Path:
    """把相对路径解析到 ROOT 内, 阻止越界 (.. 穿越)。
    空工作区(ROOT is None)时直接拒——前端应通过 /api/config 感知 hasWorkspace=false
    并渲染欢迎页，不应调任何文件 API；这里挡住防越权/防 None 拼接报错。"""
    _, target, _, _ = resolve_workspace_detail(rel)
    return target


# ---------- git 辅助 ----------
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


# ---------- 终端 / 运行 辅助 ----------
EXEC_TIMEOUT = 120  # 命令执行超时（秒）
# Windows 下隐藏子进程控制台窗口（桌面/windowed 模式运行命令时不弹黑框）
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

def _python_interp():
    """跑 .py 用的解释器。打包(frozen)时 sys.executable 是 Workbench.exe，
    拿它跑脚本只会再开一个 Workbench；此时改去 PATH 找真 python。"""
    if not getattr(sys, "frozen", False) and sys.executable:
        return sys.executable
    import shutil
    for name in ("python", "python3", "py"):
        p = shutil.which(name)
        if p:
            return p
    return "python"


# 按扩展名选解释器（运行当前文件）。值是参数列表前缀，文件路径追加在后。
RUN_INTERPRETERS = {
    ".py": [_python_interp()],
    ".js": ["node"],
    ".mjs": ["node"],
    ".cjs": ["node"],
    ".ts": ["node"],  # 需 ts-node/bun 之类；退化为 node 由用户自负
    ".sh": ["bash"],
    ".bash": ["bash"],
    ".rb": ["ruby"],
    ".php": ["php"],
    ".pl": ["perl"],
    ".ps1": ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
}


def resolve_cwd(rel: str) -> Path:
    """把可选 cwd 解析到 ROOT 内的目录。空/非目录 → ROOT。越界抛 PermissionError。"""
    rel = (rel or "").strip()
    if not rel:
        return ROOT
    d = safe_resolve(rel)
    if not d.is_dir():
        d = d.parent
    # safe_resolve 已确保在 ROOT 内
    return d


def atomic_write_bytes(fp: Path, data: bytes):
    """原子写：写同目录临时文件并 fsync，再 os.replace 覆盖目标。
    规避 'wb' 在 open() 时就把原文件截断为 0——写入中途(磁盘满/断电/被杀)旧数据已毁。"""
    import tempfile
    fp.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(fp.parent), prefix=".wb-tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, str(fp))   # 同卷原子替换
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def within_root_real(p) -> bool:
    """p 的真实路径(解析符号链接/Windows junction 后)是否仍在任一工作区根内。"""
    try:
        rp = os.path.realpath(str(p))
        for root in current_workspace_roots():
            rr = os.path.realpath(str(root))
            if rp == rr or rp.startswith(rr + os.sep):
                return True
        return False
    except OSError:
        return False


def _kill_proc_tree(p):
    """杀掉进程及其整棵子树。Windows 用 taskkill /T(按 PID 树)；POSIX 用进程组 killpg。"""
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
    """执行 shell 命令，返回 (code, stdout, stderr)。
    超时时杀「整棵进程树」(含孙进程)——否则 shell=True 只杀顶层 shell，孙进程被孤儿化，
    且持有 stdout 的孙进程会让 communicate() 在超时后继续阻塞。"""
    kw = {}
    if sys.platform != "win32":
        kw["start_new_session"] = True   # 自成进程组，便于 killpg 杀整组
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
            out, err = p.communicate(timeout=5)   # 树已杀，管道应很快关闭
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


# ====================================================================
# ConPTY 真伪终端会话管理（Windows 伪控制台，纯 ctypes/stdlib）
# 给每个会话起一个持久 shell：真实 prompt/回显/颜色/交互都有。
# 目标 Windows 11（ConPTY 自 1809 起即有）；CreatePseudoConsole 不存在时
# 回退到“持久 subprocess + 管道”模式（无真 PTY，但可用）。
# ====================================================================
_IS_WIN = sys.platform == "win32"

# 本机常见 shell 路径（按文件存在性探测；不存在的也列出供前端置灰）
SHELL_DEFS = [
    ("powershell", "PowerShell",
     r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
    ("cmd", "CMD", r"C:\Windows\System32\cmd.exe"),
    ("gitbash", "Git Bash", r"C:\Program Files\Git\bin\bash.exe"),
    ("wsl", "WSL", r"C:\Windows\System32\wsl.exe"),
]


def _shell_path(shell_id: str):
    for sid, _name, path in SHELL_DEFS:
        if sid == shell_id:
            return path
    return None


def detect_shells():
    """返回 shells 列表（含 exists 文件存在性）。"""
    out = []
    for sid, name, path in SHELL_DEFS:
        out.append({"id": sid, "name": name,
                    "exists": bool(path) and os.path.isfile(path)})
    return out


def _shell_cmdline(shell_id: str):
    """shell id → 命令行字符串（CreateProcessW 的 lpCommandLine）。"""
    path = _shell_path(shell_id)
    if not path:
        return None
    if shell_id == "powershell":
        return f'"{path}" -NoLogo'
    if shell_id == "cmd":
        # /Q 关闭命令回显（pipe 模式由后端负责回显，避免 cmd 自身再回显造成双显）。
        return f'"{path}" /Q'
    if shell_id == "gitbash":
        # 去掉 -i：pipe 模式下无 PTY，-i 会刷 "cannot set terminal process group /
        # no job control" 告警。--noprofile 不必，保留 -l 走登录环境即可正常交互。
        return f'"{path}" -l'
    if shell_id == "wsl":
        return f'"{path}"'
    return f'"{path}"'


def _shell_argv_pty(shell_id: str):
    """shell id → 真 PTY（pywinpty）的 argv 列表。
    pywinpty 收 list 形式（自行处理含空格路径的引号；传带引号的整串会被当成文件名 → 404）。
    真 PTY 自带行规程：cmd 不需 /Q；bash 用交互登录 shell（-i -l，有真 tty 故作业控制正常）。"""
    path = _shell_path(shell_id)
    if not path:
        return None
    if shell_id == "powershell":
        return [path, "-NoLogo"]
    if shell_id == "cmd":
        return [path]
    if shell_id == "gitbash":
        return [path, "-i", "-l"]
    if shell_id == "wsl":
        return [path]
    return [path]


# pipe 模式下"由谁回显"策略：
#   - cmd  ：以 /Q 关掉自身回显 → 后端回显（敲字即时可见）。
#   - bash ：无 PTY 自身不回显 → 后端回显。
#   - powershell：管道模式 PS 会把读到的 stdin 整行回显 → 后端不回显（否则双份）。
#   - wsl  ：底层多为 bash，无 PTY 不回显 → 后端回显。
_SHELL_BACKEND_ECHO = {
    "cmd": True,
    "gitbash": True,
    "wsl": True,
    "powershell": False,
}


def _oem_codepage_name():
    """返回控制台 OEM 码页对应的 Python 编码名（cmd 原生码页，用于收发转码）。
    取不到或不被 Python 识别时回退到 'mbcs'（Windows ANSI 码页，标准库内置）。"""
    if not _IS_WIN:
        return "utf-8"
    try:
        import ctypes
        cp = ctypes.windll.kernel32.GetOEMCP()
        name = "cp%d" % cp
        import codecs
        codecs.lookup(name)  # 验证 Python 能识别
        return name
    except Exception:
        return "mbcs"  # 'mbcs' = 当前 Windows ANSI 码页，永远可用


# 每个 shell 在 pipe 模式下的"原生编码"：
#   - cmd  ：跑在原生 OEM 码页（如简体中文 936=GBK）。不改 chcp（chcp 65001 在管道
#            stdin 上会触发 cmd 的多字节读取错乱→"More?" 续行假象），改由后端在收/发
#            两侧做 OEM↔UTF-8 转码，对前端始终是干净 UTF-8。
#   - powershell：init 里把控制台编码设成 UTF-8，原生即 UTF-8。
#   - gitbash/wsl：原生 UTF-8。
_OEM_ENC = _oem_codepage_name()
_SHELL_TERM_ENC = {
    "cmd": _OEM_ENC,
    "powershell": "utf-8",
    "gitbash": "utf-8",
    "wsl": "utf-8",
}


def _shell_init_lines(shell_id: str):
    """会话起始注入的初始化命令（每行末尾自动补 \\n）。
    统一编码、清屏隐藏初始化噪音。"""
    if shell_id == "cmd":
        # 不切 chcp（见 _SHELL_TERM_ENC 说明）；仅 cls 清掉启动横幅噪音。
        return ["cls"]
    if shell_id == "powershell":
        # 输入/输出都设 UTF-8，避免中文乱码；Clear-Host 清屏。
        return [
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
            "[Console]::InputEncoding=[Text.Encoding]::UTF8;"
            "$OutputEncoding=[Text.Encoding]::UTF8",
            "Clear-Host",
        ]
    if shell_id in ("gitbash", "wsl"):
        # bash 默认 UTF-8；clear 清掉登录横幅噪音。
        return ["clear"]
    return []


if _IS_WIN:
    import ctypes
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)

    # ---- 常量 ----
    _STARTF_USESTDHANDLES = 0x00000100
    _EXTENDED_STARTUPINFO_PRESENT = 0x00080000
    _CREATE_NO_WINDOW_FLAG = 0x08000000
    _CREATE_UNICODE_ENVIRONMENT = 0x00000400
    _PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
    _HANDLE_FLAG_INHERIT = 0x00000001
    _STILL_ACTIVE = 259
    _INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value

    HPCON = wintypes.HANDLE

    class _COORD(ctypes.Structure):
        _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]

    class _SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("nLength", wintypes.DWORD),
                    ("lpSecurityDescriptor", wintypes.LPVOID),
                    ("bInheritHandle", wintypes.BOOL)]

    class _STARTUPINFOW(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("lpReserved", wintypes.LPWSTR),
            ("lpDesktop", wintypes.LPWSTR),
            ("lpTitle", wintypes.LPWSTR),
            ("dwX", wintypes.DWORD),
            ("dwY", wintypes.DWORD),
            ("dwXSize", wintypes.DWORD),
            ("dwYSize", wintypes.DWORD),
            ("dwXCountChars", wintypes.DWORD),
            ("dwYCountChars", wintypes.DWORD),
            ("dwFillAttribute", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("wShowWindow", wintypes.WORD),
            ("cbReserved2", wintypes.WORD),
            ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
            ("hStdInput", wintypes.HANDLE),
            ("hStdOutput", wintypes.HANDLE),
            ("hStdError", wintypes.HANDLE),
        ]

    class _STARTUPINFOEXW(ctypes.Structure):
        _fields_ = [("StartupInfo", _STARTUPINFOW),
                    ("lpAttributeList", ctypes.c_void_p)]

    class _PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [("hProcess", wintypes.HANDLE),
                    ("hThread", wintypes.HANDLE),
                    ("dwProcessId", wintypes.DWORD),
                    ("dwThreadId", wintypes.DWORD)]

    # ---- 函数签名 ----
    _k32.CreatePipe.argtypes = [
        ctypes.POINTER(wintypes.HANDLE), ctypes.POINTER(wintypes.HANDLE),
        ctypes.POINTER(_SECURITY_ATTRIBUTES), wintypes.DWORD]
    _k32.CreatePipe.restype = wintypes.BOOL

    _CreatePseudoConsole = getattr(_k32, "CreatePseudoConsole", None)
    _ResizePseudoConsole = getattr(_k32, "ResizePseudoConsole", None)
    _ClosePseudoConsole = getattr(_k32, "ClosePseudoConsole", None)
    _HAS_CONPTY = all((_CreatePseudoConsole, _ResizePseudoConsole,
                       _ClosePseudoConsole))
    if _HAS_CONPTY:
        _CreatePseudoConsole.argtypes = [
            _COORD, wintypes.HANDLE, wintypes.HANDLE, wintypes.DWORD,
            ctypes.POINTER(HPCON)]
        _CreatePseudoConsole.restype = ctypes.c_long  # HRESULT
        _ResizePseudoConsole.argtypes = [HPCON, _COORD]
        _ResizePseudoConsole.restype = ctypes.c_long
        _ClosePseudoConsole.argtypes = [HPCON]
        _ClosePseudoConsole.restype = None

    _k32.InitializeProcThreadAttributeList.argtypes = [
        ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
        ctypes.POINTER(ctypes.c_size_t)]
    _k32.InitializeProcThreadAttributeList.restype = wintypes.BOOL

    _k32.UpdateProcThreadAttribute.argtypes = [
        ctypes.c_void_p, wintypes.DWORD, ctypes.c_size_t, ctypes.c_void_p,
        ctypes.c_size_t, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t)]
    _k32.UpdateProcThreadAttribute.restype = wintypes.BOOL

    _k32.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
    _k32.DeleteProcThreadAttributeList.restype = None

    _k32.CreateProcessW.argtypes = [
        wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
        wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
        ctypes.POINTER(_STARTUPINFOEXW), ctypes.POINTER(_PROCESS_INFORMATION)]
    _k32.CreateProcessW.restype = wintypes.BOOL

    _k32.ReadFile.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    _k32.ReadFile.restype = wintypes.BOOL

    # PeekNamedPipe：读前先窥探可用字节数，避免 ReadFile 在无数据时永久阻塞
    # （ConPTY 不渲染时其输出管道永不来数据也不关闭，阻塞读会卡死清理）。
    _k32.PeekNamedPipe.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD)]
    _k32.PeekNamedPipe.restype = wintypes.BOOL

    _k32.WriteFile.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    _k32.WriteFile.restype = wintypes.BOOL

    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.CloseHandle.restype = wintypes.BOOL

    _k32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _k32.TerminateProcess.restype = wintypes.BOOL

    _k32.GetExitCodeProcess.argtypes = [
        wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    _k32.GetExitCodeProcess.restype = wintypes.BOOL

    _k32.SetHandleInformation.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]
    _k32.SetHandleInformation.restype = wintypes.BOOL

    def _winerr(msg):
        return OSError(f"{msg} (GetLastError={ctypes.get_last_error()})")


# pywinpty（可选）：成熟的真 PTY 封装（内部走 ConPTY，失败再退 winpty-agent 后端）。
# exe 打包内置；脚本模式可 `pip install pywinpty`。有它则终端走 OS 级真 PTY ——
# 真回显 / 编码协商 / 行规程 / 作业控制 / Ctrl+C 全部由 PTY 处理，无需 pipe 模式的补偿。
_HAS_WINPTY = False
_winpty = None
if _IS_WIN:
    try:
        import winpty as _winpty
        _HAS_WINPTY = True
    except Exception:
        _winpty = None
        _HAS_WINPTY = False


class TermSession:
    """一个终端会话：持久 shell + 输出缓冲。

    优先级：pywinpty 真 PTY → 本文件自带 ctypes ConPTY → 持久 subprocess + 管道。
    真 PTY（winpty/conpty）下 shell 自带回显，后端绝不回灌；仅 pipe 回退才需补偿。
    """

    _BUF_CAP = 4 * 1024 * 1024  # 回滚缓冲上限 4MB；超出从头截断（_base 记累计丢弃量，保持绝对 offset）

    def __init__(self, shell_id: str, cols: int = 80, rows: int = 24):
        self.shell_id = shell_id
        self.cols = max(1, int(cols or 80))
        self.rows = max(1, int(rows or 24))
        self._buf = bytearray()
        self._base = 0          # 已从缓冲头截断的累计字节数（绝对 offset = _base + len(_buf)）
        self._lock = threading.Lock()
        self._alive = True
        self._mode = None  # "winpty" | "conpty" | "pipe"
        self._closed = False
        self._pty = None   # pywinpty PtyProcess（winpty 模式用）
        # pipe 模式：是否由后端负责回显（见 _SHELL_BACKEND_ECHO）。
        # conpty 模式有真 PTY，shell 自身回显，后端绝不回灌。
        self._backend_echo = _SHELL_BACKEND_ECHO.get(shell_id, True)
        # shell 原生编码（cmd=OEM 码页，其余=utf-8）。_buf 内永远存 UTF-8，
        # 收到非 UTF-8 原生输出时在 reader 里增量解码再转回 UTF-8。
        self._term_enc = _SHELL_TERM_ENC.get(shell_id, "utf-8")
        self._decoder = None
        if self._term_enc != "utf-8":
            import codecs
            self._decoder = codecs.getincrementaldecoder(
                self._term_enc)(errors="replace")

        cmdline = _shell_cmdline(shell_id)
        if not cmdline:
            raise ValueError(f"未知 shell: {shell_id}")
        path = _shell_path(shell_id)
        if not path or not os.path.isfile(path):
            raise FileNotFoundError(f"shell 不存在: {path}")

        self._fallback_reason = ""
        started = False
        # ① 首选 pywinpty 真 PTY（最稳：真回显/编码/作业控制，删光 pipe 补偿）
        if _IS_WIN and _HAS_WINPTY:
            try:
                self._start_winpty()
                self._mode = "winpty"
                self._start_reader()
                started = True
            except Exception as e:
                self._pty = None
                self._fallback_reason = f"winpty: {e}"
        # ② 次选本文件自带的 ctypes ConPTY
        if not started and _IS_WIN and _HAS_CONPTY:
            try:
                self._start_conpty(cmdline)
                self._mode = "conpty"
                self._start_reader()
                # 探活：ConPTY 正常会立刻吐出 shell 横幅/提示符的 VT 序列。
                # 某些环境（无交互窗口站/会话0的无头 VM）下 conhost 渲染不工作，
                # 句柄都成功但永远读不到字节 —— 此时回退到管道模式。
                if self._probe_conpty_output():
                    started = True
                else:
                    self._fallback_reason = "ConPTY 已建立但无输出（环境不支持伪控制台渲染）"
                    self._teardown_conpty()
            except Exception as e:
                self._cleanup_handles()
                self._fallback_reason = str(e)
        if not started:
            self._start_pipe(cmdline)
            self._mode = "pipe"
            self._alive = True
            self._closed = False
            self._start_reader()

    def _start_reader(self):
        t = threading.Thread(target=self._reader, daemon=True)
        t.start()
        self._reader_thread = t

    def _probe_conpty_output(self, timeout=1.5):
        """等待 ConPTY 首次输出；timeout 内有字节即认为可用。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if self._buf:
                    return True
            if not self._is_alive():
                # 进程已退出且有输出也算（极快退出）；无输出则不可用
                with self._lock:
                    return bool(self._buf)
            time.sleep(0.05)
        return False

    def _teardown_conpty(self):
        """探活失败时拆掉 ConPTY（终止子进程 + 关句柄），让读线程退出。"""
        self._closed = True  # 让 PeekNamedPipe 轮询的读线程尽快退出
        try:
            if getattr(self, "_hProcess", None):
                _k32.TerminateProcess(self._hProcess, 0)
        except Exception:
            pass
        # 先等读线程退出（它现在轮询 _closed，不会阻塞）再关句柄，避免竞争
        rt = getattr(self, "_reader_thread", None)
        if rt:
            rt.join(timeout=1.0)
        self._cleanup_handles()
        try:
            if getattr(self, "_hProcess", None):
                _k32.CloseHandle(self._hProcess)
                self._hProcess = None
        except Exception:
            pass
        # 复位状态供管道模式重新使用
        self._closed = False
        with self._lock:
            self._buf = bytearray()
            self._base = 0

    # ---------- winpty (pywinpty 真 PTY) ----------
    def _start_winpty(self):
        argv = _shell_argv_pty(self.shell_id)
        if not argv:
            raise ValueError(f"未知 shell: {self.shell_id}")
        # cwd 必须是有效目录，否则 pywinpty spawn 直接 FileNotFoundError；
        # ROOT 异常时退回 None（默认工作目录）而非让 winpty 失败。
        root = str(ROOT)
        cwd = root if os.path.isdir(root) else None
        # dimensions=(rows, cols)。真 PTY 自带回显/编码/Clear-Host/作业控制，
        # 故不注入初始化命令、不规整 \r、不后端回显。
        self._pty = _winpty.PtyProcess.spawn(
            argv, cwd=cwd, dimensions=(self.rows, self.cols))

    # ---------- ConPTY ----------
    def _start_conpty(self, cmdline):
        sa = _SECURITY_ATTRIBUTES()
        sa.nLength = ctypes.sizeof(_SECURITY_ATTRIBUTES)
        sa.bInheritHandle = True
        sa.lpSecurityDescriptor = None

        in_read = wintypes.HANDLE()
        in_write = wintypes.HANDLE()
        out_read = wintypes.HANDLE()
        out_write = wintypes.HANDLE()

        # 输入管道：父写 in_write → 子从 in_read 读
        if not _k32.CreatePipe(ctypes.byref(in_read), ctypes.byref(in_write),
                               ctypes.byref(sa), 0):
            raise _winerr("CreatePipe(input) 失败")
        # 输出管道：子写 out_write → 父从 out_read 读
        if not _k32.CreatePipe(ctypes.byref(out_read), ctypes.byref(out_write),
                               ctypes.byref(sa), 0):
            _k32.CloseHandle(in_read)
            _k32.CloseHandle(in_write)
            raise _winerr("CreatePipe(output) 失败")

        # 父侧保留端不可继承
        _k32.SetHandleInformation(in_write, _HANDLE_FLAG_INHERIT, 0)
        _k32.SetHandleInformation(out_read, _HANDLE_FLAG_INHERIT, 0)

        size = _COORD(self.cols, self.rows)
        hpc = HPCON()
        hr = _CreatePseudoConsole(size, in_read, out_write, 0,
                                  ctypes.byref(hpc))
        if hr != 0:
            for h in (in_read, in_write, out_read, out_write):
                _k32.CloseHandle(h)
            raise OSError(f"CreatePseudoConsole 失败 (HRESULT=0x{hr & 0xffffffff:08x})")
        self._hpc = hpc

        # 父进程关掉传给 PTY 的两端（PTY 已持有副本）
        _k32.CloseHandle(in_read)
        _k32.CloseHandle(out_write)
        self._in_read = None
        self._out_write = None
        self._in_write = in_write
        self._out_read = out_read

        # 构建带 PSEUDOCONSOLE 属性的 STARTUPINFOEX
        attr_size = ctypes.c_size_t(0)
        _k32.InitializeProcThreadAttributeList(None, 1, 0,
                                               ctypes.byref(attr_size))
        attr_buf = (ctypes.c_byte * attr_size.value)()
        si_ex = _STARTUPINFOEXW()
        si_ex.StartupInfo.cb = ctypes.sizeof(_STARTUPINFOEXW)
        si_ex.lpAttributeList = ctypes.cast(attr_buf, ctypes.c_void_p)
        if not _k32.InitializeProcThreadAttributeList(
                si_ex.lpAttributeList, 1, 0, ctypes.byref(attr_size)):
            self._cleanup_handles()
            raise _winerr("InitializeProcThreadAttributeList 失败")
        self._attr_buf = attr_buf  # 保活
        if not _k32.UpdateProcThreadAttribute(
                si_ex.lpAttributeList, 0,
                _PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                ctypes.cast(hpc, ctypes.c_void_p),
                ctypes.sizeof(HPCON), None, None):
            _k32.DeleteProcThreadAttributeList(si_ex.lpAttributeList)
            self._cleanup_handles()
            raise _winerr("UpdateProcThreadAttribute 失败")

        pi = _PROCESS_INFORMATION()
        flags = (_EXTENDED_STARTUPINFO_PRESENT | _CREATE_NO_WINDOW_FLAG
                 | _CREATE_UNICODE_ENVIRONMENT)
        cmd_buf = ctypes.create_unicode_buffer(cmdline)
        ok = _k32.CreateProcessW(
            None, cmd_buf, None, None, False, flags, None,
            str(ROOT), ctypes.byref(si_ex), ctypes.byref(pi))
        _k32.DeleteProcThreadAttributeList(si_ex.lpAttributeList)
        if not ok:
            self._cleanup_handles()
            raise _winerr("CreateProcessW 失败")
        self._hProcess = pi.hProcess
        if pi.hThread:
            _k32.CloseHandle(pi.hThread)
        self._pid = pi.dwProcessId

    # ---------- 回退：持久 subprocess + 管道 ----------
    def _start_pipe(self, cmdline):
        # 合并 stderr 到 stdout；行缓冲交互
        flags = _NO_WINDOW
        self._proc = subprocess.Popen(
            cmdline, cwd=str(ROOT), shell=False,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, bufsize=0,
            creationflags=flags,
        )
        # 注入初始化命令（统一编码 / 清屏去噪），直接写 stdin、不经回显逻辑，
        # 这些非用户输入不该回灌到屏幕；末尾的 cls/clear 也会抹掉初始化痕迹。
        init = _shell_init_lines(self.shell_id)
        if init:
            text = "".join(line + "\n" for line in init)
            try:
                payload = text.encode(self._term_enc, "replace")
            except Exception:
                payload = text.encode("utf-8", "replace")
            try:
                self._proc.stdin.write(payload)
                self._proc.stdin.flush()
            except (OSError, ValueError):
                pass

    # ---------- 读循环 ----------
    def _reader(self):
        if self._mode == "winpty":
            self._reader_winpty()
        elif self._mode == "conpty":
            self._reader_conpty()
        else:
            self._reader_pipe()
        self._alive = False

    def _reader_winpty(self):
        # pywinpty read() 返回 str（PTY 已协商好编码）；_buf 内统一存 UTF-8 字节。
        # 进程结束时 read() 抛 EOFError → 退出；空闲返回空串则小睡避免空转。
        while not self._closed:
            try:
                data = self._pty.read(8192)
            except EOFError:
                break
            except Exception:
                break
            if data:
                with self._lock:
                    self._append(data.encode("utf-8", "replace"))
            else:
                time.sleep(0.02)

    def _reader_conpty(self):
        # 用 PeekNamedPipe 先窥探可用字节，只在有数据时才 ReadFile —— 避免无数据时
        # 阻塞在 ReadFile 里（ConPTY 不渲染的环境下输出管道永不来数据），从而能响应
        # _closed 并让句柄关闭/清理瞬间完成。
        buf = (ctypes.c_byte * 8192)()
        nread = wintypes.DWORD(0)
        avail = wintypes.DWORD(0)
        while not self._closed:
            h = self._out_read
            if not h:
                break
            ok = _k32.PeekNamedPipe(h, None, 0, None,
                                    ctypes.byref(avail), None)
            if not ok:
                break  # 管道已坏/关闭（子进程退出）
            if avail.value == 0:
                time.sleep(0.02)
                continue
            n = min(avail.value, 8192)
            rok = _k32.ReadFile(h, buf, n, ctypes.byref(nread), None)
            if not rok or nread.value == 0:
                break
            with self._lock:
                self._append(bytes(buf[:nread.value]))

    def _reader_pipe(self):
        stream = self._proc.stdout
        while True:
            try:
                chunk = stream.read(4096)
            except (OSError, ValueError):
                break
            if not chunk:
                break
            if self._decoder is not None:
                # cmd 原生 OEM 码页 → 增量解码（跨块多字节安全）→ 转 UTF-8 进缓冲，
                # 保证 _buf 始终是干净 UTF-8（前端按 UTF-8 解码）。
                text = self._decoder.decode(chunk)
                if text:
                    with self._lock:
                        self._append(text.encode("utf-8"))
            else:
                with self._lock:
                    self._append(chunk)

    # ---------- 输入 / 缩放 ----------
    def write(self, data: bytes):
        if self._closed:
            return
        if self._mode == "winpty":
            # 真 PTY：直接写，回显/行规程由 PTY 处理，无需 \r 规整或后端回显。
            if data:
                try:
                    self._pty.write(data.decode("utf-8", "replace"))
                except Exception:
                    pass
            return
        if self._mode == "conpty":
            nwrote = wintypes.DWORD(0)
            cbuf = (ctypes.c_byte * len(data)).from_buffer_copy(data) if data else None
            if not _k32.WriteFile(self._in_write, cbuf, len(data),
                                  ctypes.byref(nwrote), None):
                raise _winerr("WriteFile 失败")
        else:
            # 管道回退模式：无真 PTY，需补偿——
            # ① xterm 回车只发裸 \r，但管道里的 cmd/powershell 需要换行(\n)才会处理整行；
            #    把不带 \n 的 \r 规整成 \n 写进 shell stdin。
            # ② 回显单一份：仅当 _backend_echo=True 时由后端回灌输入（cmd 已 /Q 关自身回显、
            #    bash/wsl 无 PTY 不回显）；powershell 管道模式 PS 自己会回显 stdin，后端不回灌，
            #    确保每个字符只显示一次。
            # ③ data 是 UTF-8 字节（请求里的字符串解码而来）。回显进 _buf 保持 UTF-8；
            #    写进 shell stdin 则转成该 shell 的原生编码（cmd=OEM 码页），避免中文乱码。
            out = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            if self._backend_echo:
                with self._lock:
                    # 回显：\n 显示为 \r\n 让 xterm 正确换行回到行首
                    self._append(out.replace(b"\n", b"\r\n"))
            if self._term_enc != "utf-8":
                try:
                    out = out.decode("utf-8", "replace").encode(
                        self._term_enc, "replace")
                except Exception:
                    pass
            try:
                self._proc.stdin.write(out)
                self._proc.stdin.flush()
            except (OSError, ValueError):
                pass

    def resize(self, cols: int, rows: int):
        self.cols = max(1, int(cols))
        self.rows = max(1, int(rows))
        if self._mode == "winpty" and not self._closed:
            try:
                self._pty.setwinsize(self.rows, self.cols)
            except Exception:
                pass
            return
        if self._mode == "conpty" and not self._closed:
            hr = _ResizePseudoConsole(self._hpc, _COORD(self.cols, self.rows))
            if hr != 0:
                raise OSError(f"ResizePseudoConsole 失败 (HRESULT=0x{hr & 0xffffffff:08x})")
        # pipe 模式无真 PTY，缩放无操作

    # ---------- 读出 / 关闭 ----------
    def _append(self, data: bytes):
        """追加输出进回滚缓冲（调用方须持 self._lock）。超上限从头截断并累加 _base。"""
        self._buf.extend(data)
        excess = len(self._buf) - self._BUF_CAP
        if excess > 0:
            del self._buf[:excess]
            self._base += excess

    def read_since(self, offset: int):
        with self._lock:
            base = self._base
            total = base + len(self._buf)     # 绝对累计字节数
            if offset < base:
                offset = base                 # 客户端落后于截断点：从当前缓冲头给起（中间旧输出已丢）
            if offset > total:
                offset = total
            chunk = bytes(self._buf[offset - base:])
        return chunk, total, self._is_alive()

    def _is_alive(self):
        if not self._alive:
            return False
        if self._mode == "winpty":
            try:
                if not self._pty.isalive():
                    self._alive = False
                    return False
            except Exception:
                self._alive = False
                return False
            return True
        if self._mode == "conpty":
            code = wintypes.DWORD(0)
            if _k32.GetExitCodeProcess(self._hProcess, ctypes.byref(code)):
                if code.value != _STILL_ACTIVE:
                    self._alive = False
                    return False
            return True
        else:
            if self._proc.poll() is not None:
                self._alive = False
                return False
            return True

    def _cleanup_handles(self):
        if not _IS_WIN:
            return
        # 先关我们这侧的管道端：阻塞中的 ReadFile/WriteFile 会因句柄失效而返回，
        # 读线程得以退出。
        for attr in ("_out_read", "_in_write", "_in_read", "_out_write"):
            h = getattr(self, attr, None)
            if h:
                try:
                    _k32.CloseHandle(h)
                except Exception:
                    pass
                setattr(self, attr, None)
        hpc = getattr(self, "_hpc", None)
        if hpc and _HAS_CONPTY:
            self._hpc = None
            # ClosePseudoConsole 会阻塞直到 host 排空输出/退出；host 卡死时会永久
            # 阻塞。放到看门狗线程里调用，超时即放弃（句柄泄漏可接受，避免挂死）。
            def _close_pc(handle=hpc):
                try:
                    _ClosePseudoConsole(handle)
                except Exception:
                    pass
            wt = threading.Thread(target=_close_pc, daemon=True)
            wt.start()
            wt.join(timeout=1.0)

    def close(self):
        if self._closed:
            return
        self._closed = True
        self._alive = False
        if self._mode == "winpty":
            try:
                self._pty.terminate(force=True)
            except Exception:
                pass
            return
        if self._mode == "conpty":
            try:
                if getattr(self, "_hProcess", None):
                    _k32.TerminateProcess(self._hProcess, 0)
            except Exception:
                pass
            # ClosePseudoConsole 会断开 PTY，读线程随之结束
            self._cleanup_handles()
            try:
                if getattr(self, "_hProcess", None):
                    _k32.CloseHandle(self._hProcess)
                    self._hProcess = None
            except Exception:
                pass
        else:
            try:
                self._proc.terminate()
            except Exception:
                pass
            for s in (getattr(self._proc, "stdin", None),
                      getattr(self._proc, "stdout", None)):
                try:
                    if s:
                        s.close()
                except Exception:
                    pass


# 全局会话表：sessionId → TermSession，并发上限
TERMS = {}
TERMS_LOCK = threading.Lock()
MAX_TERMS = 8


def parse_makefile_targets(text: str):
    """从 Makefile 文本里提取目标名（粗解析，忽略以 . 开头与含 % 的模式规则）。"""
    targets = []
    seen = set()
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9][\w.\-/]*)\s*:(?!=)", line)
        if not m:
            continue
        name = m.group(1)
        if name.startswith(".") or "%" in name or name in seen:
            continue
        seen.add(name)
        targets.append(name)
    return targets


def find_repo(start: Path):
    """从 start 向上找包含 .git 的目录，只在所属工作区根范围内。找不到返回 None。"""
    d = start if start.is_dir() else start.parent
    _, base_root = _workspace_root_for_path(d)
    if base_root is None:
        return None
    for c in [d, *d.parents]:
        within = c == base_root or base_root in c.parents
        if within and (c / ".git").exists():
            return c
        if c == base_root:
            break
    return None


def classify(p: Path) -> str:
    ext = p.suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in TEXT_EXTS or p.name.lower() in {"dockerfile", "makefile", "readme"}:
        return "text"
    return "binary"


class Handler(BaseHTTPRequestHandler):
    server_version = "Workbench/0.1"

    def log_message(self, fmt, *args):
        pass  # 安静

    # ---------- helpers ----------
    # 统一安全响应头。CSP 的关键是 script-src 不含 'unsafe-inline' —— 这会拦掉
    # 内联事件处理器(<img onerror=…>)与内联 <script>，即便消毒被绕过也挡住 XSS→/api/exec RCE；
    # 保留 'unsafe-eval' 以兼容个别 vendored 库(mermaid/vditor)的 eval/new Function。
    _CSP = ("default-src 'self'; "
            "script-src 'self' 'unsafe-eval'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "font-src 'self' data:; "
            "connect-src 'self' blob: data:; "
            "worker-src 'self' blob:; child-src 'self' blob:; "
            "frame-src 'self' blob: data:; media-src 'self' blob: data:; "
            "object-src 'none'; base-uri 'none'; form-action 'none'")

    def _sec_headers(self):
        self.send_header("Content-Security-Policy", self._CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")

    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self._sec_headers()
        self.end_headers()
        self.wfile.write(data)

    def _err(self, msg, status=400):
        self._json({"error": msg}, status)

    def _host_is_loopback(self):
        """Host 头主机名是否为本地回环。绝对白名单，用于击穿 DNS rebinding：
        重绑攻击页发来的请求 Host 仍是 evil.example（非回环）→ 直接拒。"""
        try:
            host_only = urlparse("//" + self.headers.get("Host", "")).hostname
        except ValueError:
            return False
        return host_only in ("localhost", "127.0.0.1", "::1")

    def _check_csrf(self):
        """阻止跨站请求伪造：写操作必须同源 + Content-Type 为 application/json。

        - 要求 application/json：跨站的表单/简单请求无法设置该类型，会触发预检，
          而本服务不应答 CORS 预检，浏览器即拦截，从根上挡住无预检的简单请求 CSRF。
        - Host 必须是回环主机名：击穿 DNS rebinding（相对的 Origin==Host 比较挡不住）。
        - Sec-Fetch-Site 若存在，必须是 same-origin/same-site/none。
        - Origin 若存在，其 host 必须与 Host 头一致。
        """
        ctype = self.headers.get("Content-Type", "")
        if not ctype.startswith("application/json"):
            return False
        if not self._host_is_loopback():   # DNS rebinding 防护
            return False
        site = self.headers.get("Sec-Fetch-Site")
        if site and site not in ("same-origin", "same-site", "none"):
            return False
        origin = self.headers.get("Origin")
        if origin:
            host = self.headers.get("Host", "")
            try:
                if urlparse(origin).netloc != host:
                    return False
            except ValueError:
                return False
        return True

    _MAX_BODY = 64 * 1024 * 1024  # 请求体上限 64MB（图片上传 base64 也够），防超大/负数 Content-Length

    def _read_json_body(self):
        """读取并解析 POST 的 JSON。出错时已发响应并返回 None。
        防御：畸形 Content-Length(垃圾值抛 ValueError、负值致 read(-1) 阻塞 worker)、
        超大体、非对象顶层(list/数字等使 handler 的 body.get 抛 AttributeError)。"""
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except (TypeError, ValueError):
            self._err("Content-Length 非法")
            return None
        if length < 0:
            self._err("Content-Length 非法")
            return None
        if length > self._MAX_BODY:
            self._err("请求体过大", 413)
            return None
        raw = self.rfile.read(length)
        try:
            obj = json.loads(raw.decode("utf-8")) if raw else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._err("请求体必须是合法的 UTF-8 JSON")
            return None
        if not isinstance(obj, dict):
            self._err("请求体必须是 JSON 对象")
            return None
        return obj

    def _send_bytes(self, data: bytes, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # 禁缓存：本地单用户工具，且 pywebview/WebView2 会缓存 app.js/style.css，
        # 重新打包后窗口仍显示旧前端。no-store 强制每次取最新。
        self.send_header("Cache-Control", "no-store, max-age=0")
        self._sec_headers()
        self.end_headers()
        self.wfile.write(data)

    # ---------- routing ----------
    def do_GET(self):
        parsed = urlparse(self.path)
        # 读侧 DNS rebinding 防护：/api 读接口（文件/树/搜索…）要求回环 Host；静态壳子不限制
        if parsed.path.startswith("/api/") and not self._host_is_loopback():
            return self._err("forbidden", 403)
        try:
            return self._dispatch_get(parsed)
        except PermissionError:
            return self._safe_err("forbidden", 403)
        except (BrokenPipeError, ConnectionError):
            raise
        except Exception:
            return self._safe_err("请求处理失败", 500)

    def _dispatch_get(self, parsed):
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/" or path == "":
            return self._serve_static("index.html")
        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/"):])
        if path == "/api/root":
            roots = [str(r) for r in current_workspace_roots()]
            cur = _workspace_payload(roots) if roots else None
            return self._json({
                "root": str(ROOT) if ROOT is not None else None,
                "hasWorkspace": has_workspace(),
                "workspaceRoots": roots,
                "workspaceId": cur.get("id") if isinstance(cur, dict) else None,
            })
        if path == "/api/config":
            return self._api_config()
        if path == "/api/project-roadmap":
            return self._api_project_roadmap()
        if path == "/api/tree":
            return self._api_tree(qs.get("path", [""])[0])
        if path == "/api/file":
            return self._api_file(qs.get("path", [""])[0])
        if path == "/api/raw":
            return self._api_raw(qs.get("path", [""])[0])
        if path == "/api/files-flat":
            return self._api_files_flat()
        if path == "/api/search":
            return self._api_search(
                qs.get("q", [""])[0],
                qs.get("regex", ["0"])[0] == "1",
                qs.get("case", ["0"])[0] == "1",
            )
        if path == "/api/git/status":
            return self._api_git_status(qs.get("path", [""])[0])
        if path == "/api/git/diff":
            return self._api_git_diff(qs.get("path", [""])[0])
        if path == "/api/git/log":
            return self._api_git_log(qs.get("path", [""])[0], qs.get("ref", [""])[0])
        if path == "/api/git/branches":
            return self._api_git_branches(qs.get("path", [""])[0])
        if path == "/api/git/show":
            return self._api_git_show(qs.get("path", [""])[0], qs.get("hash", [""])[0])
        if path == "/api/git/commit_files":
            return self._api_git_commit_files(qs.get("path", [""])[0], qs.get("hash", [""])[0])
        if path == "/api/git/commit_diff":
            return self._api_git_commit_diff(
                qs.get("path", [""])[0], qs.get("hash", [""])[0], qs.get("file", [""])[0])
        if path == "/api/git/file-log":
            return self._api_git_file_log(qs.get("path", [""])[0])
        if path == "/api/git/blame":
            return self._api_git_blame(qs.get("path", [""])[0])
        if path == "/api/git/stash-list":
            return self._api_git_stash_list(qs.get("path", [""])[0])
        if path == "/api/notes":
            return self._api_notes_get()
        if path == "/api/tasks":
            return self._api_tasks(qs.get("path", [""])[0])
        if path == "/api/workflow-tasks":
            return self._api_workflow_tasks()
        if path == "/api/agent-sessions":
            return self._api_agent_sessions()
        if path == "/api/ecosystem":
            return self._api_ecosystem()
        if path == "/api/project-state":
            return self._api_project_state(qs.get("name", [""])[0])
        if path == "/api/project-state/open":
            return self._api_project_state_file(qs.get("name", [""])[0])
        if path == "/api/term/shells":
            return self._api_term_shells()
        if path == "/api/term/read":
            return self._api_term_read(qs.get("id", [""])[0],
                                       qs.get("offset", ["0"])[0])
        return self._err("not found", 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if not self._check_csrf():
            return self._err("拒绝跨站请求（需同源且 Content-Type: application/json）", 403)
        try:
            return self._dispatch_post(parsed)
        except PermissionError:
            return self._safe_err("forbidden", 403)
        except (BrokenPipeError, ConnectionError):
            raise   # 连接已断，无法再回写，交给上层收尾
        except Exception:
            # 任何 handler 异常(畸形字段类型/越界等)都回落成 JSON，而不是把连接直接断开
            return self._safe_err("请求处理失败", 500)

    def _safe_err(self, msg, status):
        """尝试回写 JSON 错误；若响应已部分写出则静默放弃。"""
        try:
            return self._err(msg, status)
        except Exception:
            return None

    def _dispatch_post(self, parsed):
        if parsed.path == "/api/save":
            body = self._read_json_body()
            if body is None:
                return
            return self._api_save(body)
        # 路由 → 处理方法名（用名字而非绑定方法，缺失的处理器不会让整个 POST 分发崩溃）
        post_routes = {
            "/api/git/commit": "_api_git_commit",
            "/api/git/push": "_api_git_push",
            "/api/git/init": "_api_git_init",
            "/api/git/stage": "_api_git_stage",
            "/api/git/unstage": "_api_git_unstage",
            "/api/git/discard": "_api_git_discard",
            "/api/git/checkout": "_api_git_checkout",
            "/api/git/branch-create": "_api_git_branch_create",
            "/api/git/branch-delete": "_api_git_branch_delete",
            "/api/git/stash-save": "_api_git_stash_save",
            "/api/git/stash-pop": "_api_git_stash_pop",
            "/api/fs/create": "_api_fs_create",
            "/api/fs/rename": "_api_fs_rename",
            "/api/fs/delete": "_api_fs_delete",
            "/api/notes": "_api_notes_save",
            "/api/upload-image": "_api_upload_image",
            "/api/exec": "_api_exec",
            "/api/run-file": "_api_run_file",
            "/api/run-task": "_api_run_task",
            "/api/workflow-tasks": "_api_workflow_tasks_save",
            "/api/agent-sessions": "_api_agent_sessions_save",
            "/api/term/open": "_api_term_open",
            "/api/term/input": "_api_term_input",
            "/api/term/resize": "_api_term_resize",
            "/api/term/close": "_api_term_close",
            "/api/set-root": "_api_set_root",
            "/api/create-workspace": "_api_create_workspace",
            "/api/recent/remove": "_api_recent_remove",
            "/api/project-state/append": "_api_project_state_append",
            "/api/project-state/save": "_api_project_state_save",
        }
        if parsed.path in post_routes:
            handler = getattr(self, post_routes[parsed.path], None)
            if handler is None:
                return self._err("server route missing", 500)
            body = self._read_json_body()
            if body is None:
                return
            return handler(body)
        return self._err("not found", 404)

    # ---------- static ----------
    def _serve_static(self, rel):
        rel = rel.split("?")[0]
        fp = (STATIC_DIR / rel).resolve()
        if STATIC_DIR not in fp.parents and fp != STATIC_DIR:
            return self._err("forbidden", 403)
        if not fp.is_file():
            return self._err("not found", 404)
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        self._send_bytes(fp.read_bytes(), ctype)

    # ---------- api ----------
    def _api_tree(self, rel):
        if not has_workspace():
            return self._err("no workspace", 403)
        roots = current_workspace_roots()
        if not (rel or "").strip():
            if len(roots) > 1:
                entries = []
                for idx, root in enumerate(roots):
                    entries.append({
                        "name": root.name or str(root),
                        "path": f"@{idx}",
                        "type": "dir",
                        "workspaceRoot": True,
                        "absPath": str(root),
                    })
                return self._json({"path": "", "entries": entries})
        try:
            root, d, idx, inner = resolve_workspace_detail(rel)
        except PermissionError:
            return self._err("forbidden", 403)
        if not d.is_dir():
            return self._err("not a directory", 404)
        dirs, files = [], []
        try:
            for entry in sorted(d.iterdir(), key=lambda e: e.name.lower()):
                if entry.name.startswith("$") or entry.name == "System Volume Information":
                    continue
                try:
                    rel_path = workspace_relpath(entry)
                    is_dir = entry.is_dir()
                except (OSError, ValueError):
                    # Broken symlinks/junctions or targets outside the workspace should not
                    # make the whole Explorer tree fail to render.
                    continue
                if is_dir:
                    dirs.append({"name": entry.name, "path": rel_path, "type": "dir"})
                    continue
                try:
                    size = entry.stat().st_size
                    kind = classify(entry)
                except OSError:
                    continue  # TOCTOU or inaccessible file: skip this entry only.
                files.append({
                    "name": entry.name, "path": rel_path, "type": "file",
                    "kind": kind,
                    "size": size,
                })
        except (PermissionError, OSError):
            return self._err("permission denied", 403)
        if inner:
            rel_norm = f"@{idx}/{inner}" if idx else inner
        else:
            rel_norm = f"@{idx}" if idx else ""
        return self._json({"path": rel_norm, "entries": dirs + files})

    def _api_file(self, rel):
        try:
            fp = safe_resolve(rel)
        except PermissionError:
            return self._err("forbidden", 403)
        if not fp.is_file():
            return self._err("not found", 404)
        kind = classify(fp)
        if kind == "image":
            ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
            return self._send_bytes(fp.read_bytes(), ctype)
        size = fp.stat().st_size
        if size > MAX_TEXT_BYTES:
            return self._json({"kind": "binary", "size": size, "name": fp.name})
        # 不再仅凭扩展名判 binary 就拒绝——读出字节做内容嗅探：含 NUL 字节(典型二进制)
        # 才当二进制；否则尝试 UTF-8 解码，成功即作可编辑文本（覆盖 .spec 等未列入
        # TEXT_EXTS 的杂项文本/配置/无扩展名文件）。
        try:
            raw = fp.read_bytes()
        except OSError as e:
            return self._err("读取失败", 500)
        if b"\x00" in raw:
            return self._json({"kind": "binary", "size": size, "name": fp.name})
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            return self._json({"kind": "binary", "size": size, "name": fp.name})
        return self._json({"kind": "text", "name": fp.name, "ext": fp.suffix.lower(),
                           "content": content, "size": size})

    def _api_raw(self, rel):
        """GET /api/raw?path= —— 原样返回文件字节（供多格式查看器读原始数据）。

        - safe_resolve 限定 ROOT 内（越界 403）。
        - 不存在 / 不是文件 → 404。
        - Content-Type 用 mimetypes 猜，猜不到回退 application/octet-stream。
        """
        try:
            fp = safe_resolve(rel)
        except PermissionError:
            return self._err("forbidden", 403)
        if not fp.is_file():
            return self._err("not found", 404)
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        try:
            data = fp.read_bytes()
        except OSError as e:
            return self._err("读取失败", 500)
        return self._send_bytes(data, ctype)

    # 忽略遍历的目录名（避免巨量/无关文件拖慢快速打开）
    _FLAT_SKIP_DIRS = {
        ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
        ".pytest_cache", "dist", "build", ".next", ".nuxt", "target",
        ".idea", ".vscode", ".cache", "System Volume Information",
    }
    _FLAT_LIMIT = 2000

    def _api_files_flat(self):
        """递归遍历 ROOT，返回相对路径字符串数组（供 Ctrl+P 快速打开）。"""
        out = []
        skip = self._FLAT_SKIP_DIRS
        limit = self._FLAT_LIMIT
        for root in current_workspace_roots():
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [
                    d for d in dirnames
                    if d not in skip and not d.startswith("$")
                    and within_root_real(Path(dirpath) / d)
                ]
                dirnames.sort(key=str.lower)
                for name in sorted(filenames, key=str.lower):
                    fp = Path(dirpath) / name
                    if not within_root_real(fp):
                        continue
                    try:
                        rel = workspace_relpath(fp)
                    except ValueError:
                        continue
                    out.append(rel)
                    if len(out) >= limit:
                        return self._json({"files": out, "truncated": True})
        return self._json({"files": out, "truncated": False})

    # 全文搜索：忽略的目录 / 限额
    _SEARCH_SKIP_DIRS = {
        ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
        ".pytest_cache", "dist", "build", ".next", ".nuxt", "target",
        ".idea", ".vscode", ".cache", "System Volume Information",
    }
    _SEARCH_TOTAL_LIMIT = 500     # 总结果条数上限
    _SEARCH_PER_FILE_LIMIT = 50   # 单文件结果条数上限
    _SEARCH_MAX_BYTES = 2 * 1024 * 1024  # 单文件超过此大小跳过

    def _api_search(self, q, use_regex, case_sensitive):
        q = q or ""
        if not q.strip():
            return self._json({"results": [], "truncated": False})
        # 构造匹配器
        if use_regex:
            try:
                flags = 0 if case_sensitive else re.IGNORECASE
                pattern = re.compile(q, flags)
            except re.error as e:
                return self._err(f"正则非法: {e}")
            matcher = lambda line: pattern.search(line)
        else:
            needle = q if case_sensitive else q.lower()
            def matcher(line, _n=needle, _cs=case_sensitive):
                hay = line if _cs else line.lower()
                idx = hay.find(_n)
                return None if idx < 0 else (idx, idx + len(_n))

        results = []
        truncated = False
        skip = self._SEARCH_SKIP_DIRS
        total_limit = self._SEARCH_TOTAL_LIMIT
        per_file = self._SEARCH_PER_FILE_LIMIT
        max_bytes = self._SEARCH_MAX_BYTES

        for root in current_workspace_roots():
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames
                               if d not in skip and not d.startswith("$")
                               and within_root_real(Path(dirpath) / d)]
                dirnames.sort(key=str.lower)
                for name in sorted(filenames, key=str.lower):
                    fp = Path(dirpath) / name
                    if not within_root_real(fp):
                        continue
                    try:
                        st = fp.stat()
                    except OSError:
                        continue
                    if st.st_size > max_bytes:
                        continue
                    try:
                        raw = fp.read_bytes()
                    except OSError:
                        continue
                    if b"\x00" in raw:
                        continue
                    try:
                        text = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        continue
                    try:
                        rel = workspace_relpath(fp)
                    except ValueError:
                        continue
                    file_hits = 0
                    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
                    for lineno, line in enumerate(lines, 1):
                        m = matcher(line)
                        if not m:
                            continue
                        if use_regex:
                            col = m.start()
                            mlen = max(1, m.end() - m.start())
                        else:
                            col = m[0]
                            mlen = m[1] - m[0]
                        results.append({
                            "path": rel, "line": lineno, "col": col,
                            "len": mlen,
                            "text": line[:1000],
                        })
                        file_hits += 1
                        if len(results) >= total_limit:
                            truncated = True
                            return self._json({"results": results, "truncated": True})
                        if file_hits >= per_file:
                            truncated = True
                            break
        return self._json({"results": results, "truncated": truncated})

    def _api_save(self, body):
        rel = body.get("path")
        content = body.get("content")
        if rel is None or content is None:
            return self._err("missing path or content")
        if not isinstance(content, str):
            return self._err("content 必须是字符串")
        data = content.encode("utf-8")
        if len(data) > MAX_TEXT_BYTES:
            return self._err(f"内容过大（>{MAX_TEXT_BYTES // (1024*1024)}MB），不宜在线编辑")
        try:
            fp = safe_resolve(rel)
        except PermissionError:
            return self._err("forbidden", 403)
        if fp.is_dir():
            return self._err("path is a directory")
        try:
            # 原子写，保留原始 \n（不做 CRLF 转换）；写入中断不会截断旧文件
            atomic_write_bytes(fp, data)
        except OSError:
            return self._err("写入失败", 500)
        return self._json({"ok": True, "size": len(data)})

    # ---------- 文件操作（新建/重命名/删除）----------
    @staticmethod
    def _valid_name(name):
        return bool(name) and name not in (".", "..") \
            and "/" not in name and "\\" not in name \
            and not re.search(r'[:*?"<>|]', name)

    def _rel_of(self, p):
        return workspace_relpath(p)

    def _api_fs_create(self, body):
        parent_rel = body.get("path", "") or ""
        name = (body.get("name") or "").strip()
        kind = body.get("type", "file")
        if not self._valid_name(name):
            return self._err("名称非法（不能含 / \\ : * ? \" < > | 或为空）")
        try:
            parent = safe_resolve(parent_rel) if parent_rel else ROOT
        except PermissionError:
            return self._err("forbidden", 403)
        if not parent.is_dir():
            parent = parent.parent
        target = parent / name
        if target.exists():
            return self._err("已存在同名文件/文件夹")
        try:
            if kind == "dir":
                target.mkdir(parents=False)
            else:
                target.write_bytes(b"")
        except OSError:
            return self._err("创建失败", 500)
        return self._json({"ok": True, "path": self._rel_of(target), "type": kind})

    def _api_fs_rename(self, body):
        rel = body.get("path")
        new_name = (body.get("newName") or "").strip()
        if not rel:
            return self._err("missing path")
        if not self._valid_name(new_name):
            return self._err("名称非法")
        try:
            src = safe_resolve(rel)
        except PermissionError:
            return self._err("forbidden", 403)
        if not src.exists():
            return self._err("源不存在", 404)
        dst = src.parent / new_name
        if dst.exists():
            # 仅大小写改名(Windows 大小写不敏感)时 dst.exists() 会把自己当成已存在 → 放行同一实体
            try:
                same = os.path.samefile(str(dst), str(src))
            except OSError:
                same = False
            if not same:
                return self._err("目标已存在")
        try:
            src.rename(dst)
        except OSError:
            return self._err("重命名失败", 500)
        return self._json({"ok": True, "path": self._rel_of(dst),
                           "type": "dir" if dst.is_dir() else "file"})

    def _api_fs_delete(self, body):
        rel = body.get("path")
        if not rel:
            return self._err("missing path")
        try:
            target = safe_resolve(rel)
        except PermissionError:
            return self._err("forbidden", 403)
        if not target.exists():
            return self._err("不存在", 404)
        try:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        except OSError as e:
            return self._err("删除失败", 500)
        return self._json({"ok": True})

    # ---------- 便签 / Todo ----------
    def _notes_path(self) -> Path:
        return _notes_global_path()

    def _api_notes_get(self):
        fp = self._notes_path()
        data = {"todos": [], "note": ""}
        if fp.is_file():
            try:
                loaded = json.loads(fp.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    todos = loaded.get("todos")
                    note = loaded.get("note")
                    if isinstance(todos, list):
                        data["todos"] = todos
                    if isinstance(note, str):
                        data["note"] = note
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                pass
        elif ROOT is not None:
            # 兼容旧版工作区本地存储：全局 notes.json 还不存在时，回退读取当前工作区旧文件，
            # 让用户切到新版本后至少能看到原有内容；后续一旦保存就会落到全局文件。
            legacy = ROOT / ".workbench" / "notes.json"
            if legacy.is_file():
                try:
                    loaded = json.loads(legacy.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        todos = loaded.get("todos")
                        note = loaded.get("note")
                        if isinstance(todos, list):
                            data["todos"] = todos
                        if isinstance(note, str):
                            data["note"] = note
                except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                    pass
        return self._json(data)

    def _api_notes_save(self, body):
        todos = body.get("todos", [])
        note = body.get("note", "")
        if not isinstance(todos, list):
            return self._err("todos 必须是数组")
        if not isinstance(note, str):
            return self._err("note 必须是字符串")
        # 规范化每个 todo，剔除多余字段
        clean = []
        for t in todos:
            if not isinstance(t, dict):
                continue
            clean.append({
                "id": str(t.get("id", "")),
                "text": str(t.get("text", "")),
                "done": bool(t.get("done", False)),
            })
        payload = {"todos": clean, "note": note}
        data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        fp = self._notes_path()
        try:
            atomic_write_bytes(fp, data)   # 原子写：notes.json 是 todo/便签唯一存储，中断不可截断
        except OSError:
            return self._err("保存失败", 500)
        return self._json({"ok": True})

    # ---------- 工作区 / 最近列表 ----------
    def _api_config(self):
        """GET /api/config → 全局配置 + 当前工作区状态。

        前端启动据此决定：渲染欢迎页(hasWorkspace=false) 还是直接进工作区。
        recent 列表里失效路径在前端置灰，这里不主动剔除（避免读盘开销 + 保留用户记忆）。
        """
        cfg = load_config()
        roots = [str(r) for r in current_workspace_roots()]
        cur = _workspace_payload(roots) if roots else None
        return self._json({
            "lastRoot": roots[0] if roots else cfg.get("lastRoot"),
            "recent": cfg.get("recentWorkspaces", cfg.get("recent", [])),
            "currentRoot": str(ROOT) if ROOT is not None else None,
            "currentWorkspace": cur,
            "workspaceRoots": roots,
            "workspaceId": cur.get("id") if isinstance(cur, dict) else None,
            "hasWorkspace": has_workspace(),
        })

    def _workspace_state_dir(self) -> Path:
        """当前工作区的轻量状态目录；无工作区时回退到应用内置状态。"""
        roots = current_workspace_roots()
        if roots:
            root = roots[0].resolve()
            base = (root / "state").resolve()
            if base == root or root in base.parents:
                return base
        return (APP_DIR / "state").resolve()

    def _api_project_state(self, name):
        """GET /api/project-state → 读取当前工作区项目记忆文件。

        只允许 `state/` 下固定白名单，避免把它变成任意本机文件读取接口。
        """
        base = self._workspace_state_dir()
        if name:
            key = (name or "").strip().lower()
            fn = PROJECT_STATE_FILES.get(key)
            if not fn:
                return self._err("unknown project state file", 404)
            files = [(key, fn)]
        else:
            files = list(PROJECT_STATE_FILES.items())
        out = []
        for key, fn in files:
            fp = (base / fn).resolve()
            if fp.parent != base:
                continue
            try:
                exists = fp.is_file()
                text = fp.read_text(encoding="utf-8-sig") if exists else ""
                mtime = fp.stat().st_mtime if exists else None
            except OSError:
                text, mtime = "", None
            out.append({"name": key, "file": fn, "content": text, "mtime": mtime})
        return self._json({"files": out})

    def _project_state_path(self, key):
        key = (key or "").strip().lower()
        fn = PROJECT_STATE_FILES.get(key)
        if not fn:
            return None, None
        base = self._workspace_state_dir()
        fp = (base / fn).resolve()
        if fp.parent != base:
            return None, None
        return fn, fp

    def _api_project_state_file(self, name):
        """GET /api/project-state/open → 读取单个白名单项目记忆文件供编辑。"""
        key = (name or "").strip().lower()
        fn, fp = self._project_state_path(key)
        if not fn:
            return self._err("unknown project state file", 404)
        try:
            text = fp.read_text(encoding="utf-8-sig") if fp.is_file() else ""
            size = len(text.encode("utf-8"))
        except OSError:
            return self._err("读取失败", 500)
        return self._json({
            "kind": "text",
            "name": fn,
            "ext": ".md",
            "content": text,
            "size": size,
            "virtualPath": f"project://{key}",
        })

    def _api_project_roadmap(self):
        """GET /api/project-roadmap → 只读内置生态路线文档。"""
        fp = (DOCS_DIR / ROADMAP_FILE).resolve()
        if fp.parent != DOCS_DIR:
            return self._err("forbidden", 403)
        try:
            text = fp.read_text(encoding="utf-8-sig") if fp.is_file() else ""
            mtime = fp.stat().st_mtime if fp.is_file() else None
        except OSError:
            return self._err("路线文档读取失败", 500)
        return self._json({
            "name": "roadmap",
            "file": f"docs/{ROADMAP_FILE}",
            "content": text,
            "mtime": mtime,
            "readonly": True,
        })

    @staticmethod
    def _md_line(text, limit=2000):
        text = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
        text = text[:limit]
        # 避免用户输入直接形成标题/列表结构，保持为引用块内容。
        return "\n".join("> " + line for line in text.split("\n")) if text else "> （空）"

    def _append_state_file(self, key, block):
        fn, fp = self._project_state_path(key)
        if not fn:
            return self._err("unknown project state file", 404)
        try:
            fp.parent.mkdir(parents=True, exist_ok=True)
            old = fp.read_text(encoding="utf-8-sig") if fp.is_file() else f"# {fn}\n"
            if old and not old.endswith("\n"):
                old += "\n"
            atomic_write_bytes(fp, (old + "\n" + block.strip() + "\n").encode("utf-8"))
        except OSError:
            return self._err("保存失败", 500)
        return None

    def _api_project_state_append(self, body):
        """POST /api/project-state/append → 安全追加项目记忆。

        只支持追加到 LOG/PROGRESS，作为任务验证和决策沉淀入口；不提供任意覆盖能力。
        """
        kind = str(body.get("kind") or "").strip().lower()
        target = str(body.get("target") or "").strip().lower()
        title = str(body.get("title") or "").strip()[:160]
        content = str(body.get("content") or "").strip()
        if kind not in {"decision", "validation", "note"}:
            return self._err("kind 必须是 decision / validation / note")
        if target not in {"log", "progress"}:
            return self._err("target 必须是 log 或 progress")
        if not title and not content:
            return self._err("缺少记录内容")
        if len(content) > 5000:
            return self._err("内容过长")
        label = {"decision": "Decision", "validation": "Validation", "note": "Note"}[kind]
        title = title or label
        stamp = _now_iso().replace("T", " ")
        block = f"### {stamp} · {label}: {title}\n\n{self._md_line(content)}"
        err = self._append_state_file(target, block)
        if err:
            return err
        return self._json({"ok": True, "target": target, "kind": kind})

    def _api_project_state_save(self, body):
        """POST /api/project-state/save → 保存单个白名单项目记忆文件。"""
        key = str(body.get("name") or "").strip().lower()
        content = body.get("content")
        if not isinstance(content, str):
            return self._err("content 必须是字符串")
        data = content.encode("utf-8")
        if len(data) > MAX_TEXT_BYTES:
            return self._err(f"内容过大（>{MAX_TEXT_BYTES // (1024*1024)}MB），不宜在线编辑")
        fn, fp = self._project_state_path(key)
        if not fn:
            return self._err("unknown project state file", 404)
        try:
            fp.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(fp, data)
        except OSError:
            return self._err("保存失败", 500)
        return self._json({"ok": True, "size": len(data), "target": key})

    def _workflow_tasks_path(self) -> Path:
        return (self._workspace_state_dir() / "TASKS.json").resolve()

    def _agent_sessions_path(self) -> Path:
        return (self._workspace_state_dir() / "SESSIONS.json").resolve()

    @staticmethod
    def _text_list(value, *, item_limit=200, count_limit=20):
        if isinstance(value, str):
            value = value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if not isinstance(value, list):
            return []
        out = []
        for item in value:
            text = str(item or "").strip()
            if text:
                out.append(text[:item_limit])
            if len(out) >= count_limit:
                break
        return out

    def _load_workflow_tasks(self):
        fp = self._workflow_tasks_path()
        if fp.parent != self._workspace_state_dir():
            return []
        if not fp.is_file():
            return []
        try:
            data = json.loads(fp.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return []
        raw = data.get("tasks") if isinstance(data, dict) else data
        if not isinstance(raw, list):
            return []
        return [t for t in (self._clean_workflow_task(x) for x in raw) if t]

    def _save_workflow_tasks(self, tasks):
        fp = self._workflow_tasks_path()
        if fp.parent != self._workspace_state_dir():
            return self._err("forbidden", 403)
        payload = {
            "version": 1,
            "updatedAt": _now_iso(),
            "tasks": tasks,
        }
        try:
            fp.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(fp, json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
        except OSError:
            return self._err("保存失败", 500)
        return None

    def _clean_workflow_task(self, item):
        if not isinstance(item, dict):
            return None
        title = str(item.get("title") or "").strip()[:160]
        goal = str(item.get("goal") or "").strip()[:1200]
        if not title and not goal:
            return None
        tid = str(item.get("id") or "").strip()
        if not re.fullmatch(r"task-\d{8}-\d{6}-[a-f0-9]{4}", tid):
            tid = "task-" + time.strftime("%Y%m%d-%H%M%S", time.localtime()) + "-" + secrets.token_hex(2)
        status = str(item.get("status") or "todo").strip().lower()
        if status not in {"todo", "running", "verified", "blocked"}:
            status = "todo"
        now = _now_iso()
        return {
            "id": tid,
            "title": title or "未命名任务",
            "status": status,
            "goal": goal,
            "plan": self._text_list(item.get("plan"), item_limit=180, count_limit=24),
            "evidence": self._text_list(item.get("evidence"), item_limit=260, count_limit=30),
            "log": self._text_list(item.get("log"), item_limit=500, count_limit=80),
            "next": str(item.get("next") or "").strip()[:500],
            "createdAt": str(item.get("createdAt") or now)[:32],
            "updatedAt": str(item.get("updatedAt") or now)[:32],
        }

    def _api_workflow_tasks(self):
        """GET /api/workflow-tasks → 本地任务/Agent 工作流记录。"""
        return self._json({"tasks": self._load_workflow_tasks()})

    def _api_workflow_tasks_save(self, body):
        """POST /api/workflow-tasks → 保存本地任务/Agent 工作流记录。"""
        raw = body.get("tasks")
        if not isinstance(raw, list):
            return self._err("tasks 必须是数组")
        if len(raw) > 80:
            return self._err("任务数量过多")
        now = _now_iso()
        tasks = []
        for item in raw:
            if isinstance(item, dict):
                item = dict(item)
                item["updatedAt"] = now
            clean = self._clean_workflow_task(item)
            if clean:
                tasks.append(clean)
        err = self._save_workflow_tasks(tasks)
        if err:
            return err
        return self._json({"ok": True, "tasks": tasks})

    def _load_agent_sessions(self):
        fp = self._agent_sessions_path()
        if fp.parent != self._workspace_state_dir():
            return []
        if not fp.is_file():
            return []
        try:
            data = json.loads(fp.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return []
        raw = data.get("sessions") if isinstance(data, dict) else data
        if not isinstance(raw, list):
            return []
        return [s for s in (self._clean_agent_session(x) for x in raw) if s]

    def _save_agent_sessions(self, sessions):
        fp = self._agent_sessions_path()
        if fp.parent != self._workspace_state_dir():
            return self._err("forbidden", 403)
        payload = {
            "version": 1,
            "updatedAt": _now_iso(),
            "sessions": sessions,
        }
        try:
            fp.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(fp, json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
        except OSError:
            return self._err("保存失败", 500)
        return None

    def _clean_agent_session(self, item):
        if not isinstance(item, dict):
            return None
        sid = str(item.get("id") or "").strip()
        if not re.fullmatch(r"session-\d{8}-\d{6}-[a-f0-9]{4}", sid):
            sid = "session-" + time.strftime("%Y%m%d-%H%M%S", time.localtime()) + "-" + secrets.token_hex(2)
        title = str(item.get("title") or "").strip()[:180]
        task_id = str(item.get("taskId") or "").strip()[:80]
        task_title = str(item.get("taskTitle") or "").strip()[:180]
        now = _now_iso()
        if not title:
            title = task_title or "未命名会话"
        brief = str(item.get("brief") or "").strip()
        if len(brief.encode("utf-8")) > MAX_TEXT_BYTES:
            brief = brief[:MAX_TEXT_BYTES // 4]
        status = str(item.get("status") or "draft").strip().lower()
        if status not in {"draft", "running", "verified", "blocked", "archived"}:
            status = "draft"
        return {
            "id": sid,
            "title": title,
            "status": status,
            "taskId": task_id,
            "taskTitle": task_title,
            "brief": brief[:12000],
            "context": self._text_list(item.get("context"), item_limit=500, count_limit=60),
            "outputs": self._text_list(item.get("outputs"), item_limit=800, count_limit=80),
            "evidence": self._text_list(item.get("evidence"), item_limit=260, count_limit=80),
            "log": self._text_list(item.get("log"), item_limit=500, count_limit=120),
            "createdAt": str(item.get("createdAt") or now)[:32],
            "updatedAt": str(item.get("updatedAt") or now)[:32],
        }

    def _api_agent_sessions(self):
        """GET /api/agent-sessions → 本地 Agent session 记录。"""
        return self._json({"sessions": self._load_agent_sessions()})

    def _api_agent_sessions_save(self, body):
        """POST /api/agent-sessions → 保存本地 Agent session 记录。"""
        raw = body.get("sessions")
        if not isinstance(raw, list):
            return self._err("sessions 必须是数组")
        if len(raw) > 120:
            return self._err("会话数量过多")
        now = _now_iso()
        sessions = []
        for item in raw:
            if isinstance(item, dict):
                item = dict(item)
                item["updatedAt"] = now
            clean = self._clean_agent_session(item)
            if clean:
                sessions.append(clean)
        err = self._save_agent_sessions(sessions)
        if err:
            return err
        return self._json({"ok": True, "sessions": sessions})

    @staticmethod
    def _parse_frontmatter(text):
        meta = {}
        body = text
        if text.startswith("---\n"):
            end = text.find("\n---", 4)
            if end > 0:
                raw = text[4:end].strip().splitlines()
                body = text[end + 4:].lstrip("\r\n")
                current = None
                for line in raw:
                    if not line.strip():
                        continue
                    if line.startswith("  - ") and current:
                        meta.setdefault(current, []).append(line[4:].strip())
                        continue
                    if ":" in line:
                        key, value = line.split(":", 1)
                        current = key.strip()
                        value = value.strip().strip('"').strip("'")
                        meta[current] = value if value else []
        return meta, body

    @staticmethod
    def _fm_list(meta, key, limit=40):
        value = meta.get(key)
        if isinstance(value, list):
            return [str(x)[:500] for x in value[:limit] if str(x).strip()]
        if isinstance(value, str) and value.strip():
            return [value[:500]]
        return []

    @staticmethod
    def _fm_text(meta, key, limit=500):
        value = meta.get(key)
        if isinstance(value, str):
            return value[:limit]
        return ""

    @staticmethod
    def _md_title(body, fallback):
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("# "):
                return line[2:].strip()[:120] or fallback
        return fallback

    @staticmethod
    def _summary(body, limit=240):
        lines = []
        for line in body.splitlines():
            s = line.strip()
            if not s or s.startswith("#") or s.startswith("---"):
                continue
            lines.append(s)
            if len(" ".join(lines)) >= limit:
                break
        return " ".join(lines)[:limit]

    def _api_ecosystem(self):
        """GET /api/ecosystem → 只读扫描工作区内 Skills / Playbooks。"""
        skills, playbooks = [], []
        max_bytes = 256 * 1024
        sources = []
        for root in current_workspace_roots():
            sources.append(("workspace", root, (root / ".workbench").resolve()))
        sources.append(("builtin", BUNDLE_DIR, (BUNDLE_DIR / ".workbench").resolve()))
        seen_bases = set()
        for source, root, base in sources:
            if str(base) in seen_bases:
                continue
            seen_bases.add(str(base))
            if not base.is_dir() or (base != root and root not in base.parents):
                continue
            pb_dir = base / "playbooks"
            if pb_dir.is_dir():
                for fp in sorted(pb_dir.glob("*.md"), key=lambda p: p.name.lower())[:80]:
                    try:
                        if fp.stat().st_size > max_bytes:
                            continue
                        text = fp.read_text(encoding="utf-8-sig")
                        meta, body = self._parse_frontmatter(text)
                        try:
                            rel_path = workspace_relpath(fp)
                        except ValueError:
                            rel_path = str(fp.relative_to(base)).replace("\\", "/")
                        playbooks.append({
                            "kind": "playbook",
                            "title": str(meta.get("title") or self._md_title(body, fp.stem))[:120],
                            "path": rel_path,
                            "source": source,
                            "risk": str(meta.get("risk") or "read")[:40],
                            "scope": self._fm_text(meta, "scope"),
                            "requires": self._fm_list(meta, "requires"),
                            "inputs": self._fm_list(meta, "inputs"),
                            "commands": self._fm_list(meta, "commands"),
                            "verification": self._fm_list(meta, "verification"),
                            "summary": self._summary(body),
                            "content": text[:20000],
                        })
                    except (OSError, UnicodeDecodeError, ValueError):
                        continue
            sk_dir = base / "skills"
            if sk_dir.is_dir():
                for fp in sorted(sk_dir.glob("**/SKILL.md"), key=lambda p: str(p).lower())[:80]:
                    try:
                        if fp.stat().st_size > max_bytes:
                            continue
                        text = fp.read_text(encoding="utf-8-sig")
                        meta, body = self._parse_frontmatter(text)
                        try:
                            rel_path = workspace_relpath(fp)
                        except ValueError:
                            rel_path = str(fp.relative_to(base)).replace("\\", "/")
                        skills.append({
                            "kind": "skill",
                            "title": str(meta.get("name") or meta.get("title") or fp.parent.name)[:120],
                            "path": rel_path,
                            "source": source,
                            "risk": str(meta.get("risk") or "read")[:40],
                            "scope": self._fm_text(meta, "scope"),
                            "requires": self._fm_list(meta, "requires"),
                            "inputs": self._fm_list(meta, "inputs"),
                            "commands": self._fm_list(meta, "commands"),
                            "verification": self._fm_list(meta, "verification"),
                            "description": str(meta.get("description") or self._summary(body))[:240],
                            "summary": self._summary(body),
                            "content": text[:20000],
                        })
                    except (OSError, UnicodeDecodeError, ValueError):
                        continue
        return self._json({
            "skills": skills,
            "playbooks": playbooks,
            "hasWorkspace": has_workspace(),
        })

    def _resolve_workspace_root(self, raw, *, create=False):
        """把用户输入的绝对/相对路径解析成可用工作区目录。"""
        if not isinstance(raw, str) or not raw.strip():
            return None, self._err("缺少 path")
        try:
            p = Path(raw).resolve()
        except (OSError, ValueError):
            return None, self._err("路径非法")
        if create:
            try:
                p.mkdir(parents=True, exist_ok=True)
            except OSError:
                return None, self._err("创建目录失败", 500)
        # realpath 再解析一次 junction/符号链接，避免工作根指向敏感位置的链接目标
        try:
            rp = Path(os.path.realpath(str(p)))
        except OSError:
            return None, self._err("路径无法解析")
        if not rp.is_dir():
            return None, self._err("不是有效目录")
        return rp, None

    def _resolve_workspace_roots(self, body, *, create=False):
        if isinstance(body.get("roots"), list):
            raw_roots = body.get("roots")
        else:
            raw = body.get("path")
            raw_roots = [raw] if raw is not None else []
        roots = []
        seen = set()
        for raw in raw_roots:
            rp, err = self._resolve_workspace_root(raw, create=create)
            if err:
                return None, err
            key = str(rp)
            if key in seen:
                continue
            seen.add(key)
            roots.append(rp)
        if not roots:
            return None, self._err("至少需要一个目录")
        return roots, None

    def _activate_workspace(self, roots: list[Path]) -> dict:
        """切换当前工作区并持久化 recent/lastRoot。"""
        set_workspace_roots(roots)
        with _CFG_LOCK:
            cfg = load_config()
            _touch_recent_workspace(cfg, current_workspace_roots())
            save_config(cfg)
        return cfg

    def _api_set_root(self, body):
        """POST /api/set-root {path}|{roots[]} → 切换工作区并持久化。

        统一入口：浏览器版与桌面版都走这里改 ROOT（桌面版 open_folder 也改调此 API，
        不再直接改 server.ROOT）。校验目录存在 + 真实路径（解析符号链接/junction），
        防止把工作根设到一个指向敏感位置的 junction。
        """
        roots, err = self._resolve_workspace_roots(body, create=False)
        if err:
            return err
        cfg = self._activate_workspace(roots)
        cur = cfg.get("currentWorkspace") or {}
        return self._json({
            "ok": True,
            "root": str(ROOT),
            "workspace": cur,
            "workspaceRoots": cur.get("roots", []),
            "workspaceId": cur.get("id"),
            "recent": cfg.get("recentWorkspaces", cfg.get("recent", [])),
        })

    def _api_create_workspace(self, body):
        """POST /api/create-workspace {path}|{roots[]} → 创建目录并切换为工作区。"""
        roots, err = self._resolve_workspace_roots(body, create=True)
        if err:
            return err
        cfg = self._activate_workspace(roots)
        cur = cfg.get("currentWorkspace") or {}
        return self._json({
            "ok": True,
            "root": str(ROOT),
            "workspace": cur,
            "workspaceRoots": cur.get("roots", []),
            "workspaceId": cur.get("id"),
            "recent": cfg.get("recentWorkspaces", cfg.get("recent", [])),
        })

    def _api_recent_remove(self, body):
        """POST /api/recent/remove {path} → 从最近列表移除一项（不改变当前 ROOT）。"""
        raw = body.get("id") or body.get("path")
        if not isinstance(raw, str):
            return self._err("缺少 id/path")
        with _CFG_LOCK:
            cfg = load_config()
            cfg["recentWorkspaces"] = [
                r for r in cfg.get("recentWorkspaces", [])
                if r.get("id") != raw and r.get("path") != raw
            ]
            cfg["recent"] = [
                r for r in cfg.get("recent", [])
                if r.get("path") != raw
            ]
            cur = cfg.get("currentWorkspace") if isinstance(cfg.get("currentWorkspace"), dict) else None
            if cur and (cur.get("id") == raw or cur.get("path") == raw):
                cfg["currentWorkspace"] = None
                cfg["lastRoot"] = None
            save_config(cfg)
        return self._json({"ok": True, "recent": cfg.get("recentWorkspaces", cfg.get("recent", []))})

    # ---------- 粘贴图片存盘 ----------
    _IMG_EXT_BY_MIME = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
        "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp",
        "image/svg+xml": ".svg", "image/x-icon": ".ico",
    }
    _MAX_IMG_BYTES = 20 * 1024 * 1024  # 单图上限 20MB

    def _api_upload_image(self, body):
        """把 base64 图片存到 ROOT/assets/ 下，返回相对路径。

        body: {dataB64: str(可含 data:URL 前缀), name?: str, mime?: str}
        """
        raw_b64 = body.get("dataB64") or body.get("data") or ""
        if not isinstance(raw_b64, str) or not raw_b64.strip():
            return self._err("缺少图片数据")
        mime = body.get("mime") or ""
        # 兼容 data:URL 形式（data:image/png;base64,xxxx）
        m = re.match(r"^data:([^;,]+)[^,]*,", raw_b64)
        if m:
            if not mime:
                mime = m.group(1)
            raw_b64 = raw_b64[m.end():]
        raw_b64 = raw_b64.strip().replace("\n", "").replace("\r", "")
        try:
            data = base64.b64decode(raw_b64, validate=False)
        except (ValueError, Exception):
            return self._err("图片数据不是合法的 base64")
        if not data:
            return self._err("图片数据为空")
        if len(data) > self._MAX_IMG_BYTES:
            return self._err(f"图片过大（>{self._MAX_IMG_BYTES // (1024*1024)}MB）")
        # 推断扩展名：优先 mime，其次原文件名，默认 .png
        ext = self._IMG_EXT_BY_MIME.get(mime.lower(), "")
        if not ext:
            orig = str(body.get("name") or "")
            oext = os.path.splitext(orig)[1].lower()
            if oext in IMAGE_EXTS:
                ext = oext
        if not ext:
            ext = ".png"
        # 文件名带时间戳避免重名
        stem = "img"
        orig_name = str(body.get("name") or "").strip()
        if orig_name:
            base_stem = os.path.splitext(os.path.basename(orig_name))[0]
            base_stem = re.sub(r'[^\w.\-]+', "-", base_stem).strip("-")
            if base_stem:
                stem = base_stem
        ts = time.strftime("%Y%m%d-%H%M%S")
        fname = f"{stem}-{ts}-{int(time.time() * 1000) % 1000:03d}{ext}"
        assets_dir = ROOT / "assets"
        try:
            assets_dir.mkdir(parents=True, exist_ok=True)
            fp = assets_dir / fname
            # 极小概率撞名时再补随机
            if fp.exists():
                fname = f"{stem}-{ts}-{int(time.time() * 1000000) % 1000000:06d}{ext}"
                fp = assets_dir / fname
            atomic_write_bytes(fp, data)
        except OSError:
            return self._err("保存失败", 500)
        rel = self._rel_of(fp)
        return self._json({"ok": True, "path": rel, "size": len(data)})

    # ---------- 终端 / 运行文件 / 任务 ----------
    def _api_exec(self, body):
        """POST /api/exec {cmd, cwd?} —— 在 ROOT 内执行 shell 命令。"""
        cmd = (body.get("cmd") or "").strip()
        if not cmd:
            return self._err("命令不能为空")
        try:
            cwd = resolve_cwd(body.get("cwd", ""))
        except PermissionError:
            return self._err("forbidden", 403)
        code, out, err = run_shell(cmd, cwd, EXEC_TIMEOUT)
        return self._json({
            "code": code, "stdout": out, "stderr": err,
            "cwd": self._rel_of(cwd) if cwd != ROOT else "",
        })

    def _api_run_file(self, body):
        """POST /api/run-file {path} —— 按扩展名选解释器运行该文件。"""
        rel = body.get("path")
        if not rel:
            return self._err("缺少 path")
        try:
            fp = safe_resolve(rel)
        except PermissionError:
            return self._err("forbidden", 403)
        if not fp.is_file():
            return self._err("文件不存在", 404)
        ext = fp.suffix.lower()
        prefix = RUN_INTERPRETERS.get(ext)
        if not prefix:
            return self._err(f"不支持运行该类型文件（{ext or '无扩展名'}）")
        argv = list(prefix) + [str(fp)]
        cwd = fp.parent
        # cwd 仍在 ROOT 内（safe_resolve 已保证父目录受控）
        code, out, err = run_argv(argv, cwd, EXEC_TIMEOUT)
        return self._json({
            "code": code, "stdout": out, "stderr": err,
            "interpreter": os.path.basename(prefix[0]),
            "path": self._rel_of(fp),
        })

    def _api_run_task(self, body):
        """POST /api/run-task {name, kind} —— 跑 npm/make 任务（在 ROOT）。"""
        if ROOT is None:
            return self._err("未打开工作区")
        name = (body.get("name") or "").strip()
        kind = (body.get("kind") or "").strip()
        if not name:
            return self._err("缺少任务名")
        # 任务名做保守白名单，避免命令注入
        if not re.fullmatch(r"[\w.:\-/]+", name):
            return self._err("任务名含非法字符")
        if kind == "npm":
            if not (ROOT / "package.json").is_file():
                return self._err("根目录无 package.json")
            cmd = f"npm run {name}"
        elif kind == "make":
            if not (ROOT / "Makefile").is_file():
                return self._err("根目录无 Makefile")
            cmd = f"make {name}"
        else:
            return self._err("kind 必须是 npm 或 make")
        code, out, err = run_shell(cmd, ROOT, 300)
        return self._json({"code": code, "stdout": out, "stderr": err, "cmd": cmd})

    def _api_tasks(self, rel):
        """GET /api/tasks —— 读 ROOT/package.json scripts 与 Makefile 目标。"""
        if ROOT is None:
            return self._json({"npm": [], "make": []})
        npm, make = [], []
        pkg = ROOT / "package.json"
        if pkg.is_file():
            try:
                data = json.loads(pkg.read_text(encoding="utf-8-sig"))
                scripts = data.get("scripts") if isinstance(data, dict) else None
                if isinstance(scripts, dict):
                    npm = [str(k) for k in scripts.keys()]
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                pass
        mk = ROOT / "Makefile"
        if mk.is_file():
            try:
                make = parse_makefile_targets(mk.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                pass
        return self._json({"npm": npm, "make": make})

    # ---------- 交互终端（ConPTY）----------
    def _api_term_shells(self):
        """GET /api/term/shells —— 列出可用 shell（含 exists 文件存在性）。"""
        return self._json({"shells": detect_shells()})

    def _api_term_open(self, body):
        """POST /api/term/open {shell, cols, rows} —— 起一个 ConPTY 会话。"""
        shell = (body.get("shell") or "").strip()
        if not shell or _shell_path(shell) is None:
            return self._err("未知或缺失 shell")
        try:
            cols = int(body.get("cols", 80))
            rows = int(body.get("rows", 24))
        except (TypeError, ValueError):
            cols, rows = 80, 24
        cols = max(1, min(cols, 1000))
        rows = max(1, min(rows, 1000))
        # 回收已自行退出(shell exit)的死会话，免得它们白占 MAX_TERMS 名额
        with TERMS_LOCK:
            dead = [(s, ss) for s, ss in TERMS.items() if not ss._is_alive()]
            for s, _ in dead:
                TERMS.pop(s, None)
        for _, ss in dead:
            try:
                ss.close()   # close 可能阻塞(ClosePseudoConsole)，放锁外执行
            except Exception:
                pass
        with TERMS_LOCK:
            if len(TERMS) >= MAX_TERMS:
                return self._err(f"会话数已达上限（{MAX_TERMS}），请先关闭其它终端", 429)
        try:
            sess = TermSession(shell, cols, rows)
        except FileNotFoundError as e:
            return self._err(str(e), 404)
        except Exception as e:
            return self._err(f"启动终端失败: {e}", 500)
        sid = secrets.token_hex(8)
        over = False
        with TERMS_LOCK:
            if len(TERMS) >= MAX_TERMS:   # 二次校验：与上面的检查之间隔了 TermSession 创建(并发可越额)，此处与插入同锁
                over = True
            else:
                TERMS[sid] = sess
        if over:
            try:
                sess.close()
            except Exception:
                pass
            return self._err(f"会话数已达上限（{MAX_TERMS}），请先关闭其它终端", 429)
        return self._json({"id": sid, "mode": sess._mode})

    def _api_term_input(self, body):
        """POST /api/term/input {id, data} —— 把用户输入写入会话 PTY。"""
        sid = body.get("id", "")
        data = body.get("data", "")
        if not isinstance(data, str):
            return self._err("data 必须是字符串")
        with TERMS_LOCK:
            sess = TERMS.get(sid)
        if sess is None:
            return self._err("会话不存在", 404)
        try:
            sess.write(data.encode("utf-8"))
        except Exception as e:
            return self._err(f"写入失败: {e}", 500)
        return self._json({"ok": True})

    def _api_term_read(self, sid, offset_raw):
        """GET /api/term/read?id=&offset= —— 读取自 offset 起的新输出（base64）。"""
        try:
            offset = int(offset_raw or 0)
        except (TypeError, ValueError):
            offset = 0
        with TERMS_LOCK:
            sess = TERMS.get(sid)
        if sess is None:
            return self._err("会话不存在", 404)
        chunk, new_offset, alive = sess.read_since(offset)
        return self._json({
            "data": base64.b64encode(chunk).decode("ascii"),
            "offset": new_offset,
            "alive": alive,
        })

    def _api_term_resize(self, body):
        """POST /api/term/resize {id, cols, rows} —— ResizePseudoConsole。"""
        sid = body.get("id", "")
        try:
            cols = int(body.get("cols", 80))
            rows = int(body.get("rows", 24))
        except (TypeError, ValueError):
            return self._err("cols/rows 非法")
        cols = max(1, min(cols, 1000))
        rows = max(1, min(rows, 1000))
        with TERMS_LOCK:
            sess = TERMS.get(sid)
        if sess is None:
            return self._err("会话不存在", 404)
        try:
            sess.resize(cols, rows)
        except Exception as e:
            return self._err(f"缩放失败: {e}", 500)
        return self._json({"ok": True})

    def _api_term_close(self, body):
        """POST /api/term/close {id} —— 关闭 PTY、终止子进程、清理。"""
        sid = body.get("id", "")
        with TERMS_LOCK:
            sess = TERMS.pop(sid, None)
        if sess is None:
            return self._err("会话不存在", 404)
        try:
            sess.close()
        except Exception:
            pass
        return self._json({"ok": True})

    # ---------- git api ----------
    def _resolve_repo(self, rel):
        """返回 (repo_path, error_response_called)。找不到仓库时已发送响应。"""
        try:
            target = safe_resolve(rel)
        except PermissionError:
            self._json({"repo": None, "branch": None, "files": [],
                        "message": "当前目录不在 git 仓库内"})
            return None
        if not target.exists():
            target = ROOT
        repo = find_repo(target)
        if repo is None:
            self._json({"repo": None, "branch": None, "files": [],
                        "message": "当前目录不在 git 仓库内"})
            return None
        return repo

    def _api_git_status(self, rel):
        repo = self._resolve_repo(rel)
        if repo is None:
            return
        code, out, err = run_git(["status", "--porcelain=v1", "-b"], repo)
        if code != 0:
            return self._err(err.strip() or "git status 失败", 500)
        branch, ahead, behind = None, 0, 0
        staged, unstaged = [], []

        def entry(status, fname):
            try:
                root_rel = workspace_relpath((repo / fname).resolve())
            except ValueError:
                root_rel = None
            return {"status": status, "repoPath": fname, "path": root_rel}

        for line in out.splitlines():
            if line.startswith("## "):
                head = line[3:]
                unborn = re.match(r"No commits yet on (.+)", head)
                if unborn:
                    branch = unborn.group(1).strip()
                else:
                    branch = head.split("...")[0].strip()
                if "[ahead " in head:
                    ahead = int(head.split("[ahead ")[1].split("]")[0].split(",")[0])
                if "behind " in head:
                    behind = int(head.split("behind ")[1].split("]")[0])
                continue
            if not line.strip():
                continue
            x, y = line[0], line[1]
            fname = line[3:].strip().strip('"')
            if " -> " in fname:  # 重命名
                fname = fname.split(" -> ")[1]
            if line[:2] == "??":           # 未跟踪 → 仅未暂存
                unstaged.append(entry("?", fname))
                continue
            if x not in (" ", "?"):         # 索引区有改动 → 已暂存
                staged.append(entry(x, fname))
            if y != " ":                    # 工作区有改动 → 未暂存
                unstaged.append(entry(y, fname))
        try:
            repo_rel = workspace_relpath(repo)
        except ValueError:
            repo_rel = ""
        head_code, _, _ = run_git(["rev-parse", "--verify", "HEAD"], repo)
        # 唯一文件数（一个文件可能同时在两组）作为徽标计数
        changed = len({e["repoPath"] for e in staged + unstaged})
        return self._json({"repo": repo_rel, "branch": branch,
                           "hasHead": head_code == 0,
                           "ahead": ahead, "behind": behind,
                           "staged": staged, "unstaged": unstaged, "changed": changed})

    def _api_git_diff(self, rel):
        try:
            fp = safe_resolve(rel)
        except PermissionError:
            return self._err("forbidden", 403)
        repo = find_repo(fp)
        if repo is None:
            return self._err("不在仓库内", 404)
        repo_rel = str(fp.relative_to(repo)).replace("\\", "/")
        code, out, err = run_git(["diff", "HEAD", "--", repo_rel], repo)
        if code != 0:
            # 可能是未跟踪文件或无 HEAD, 退化为与空对比
            code2, out2, _ = run_git(["diff", "--no-index", "--", os.devnull, repo_rel], repo)
            out = out2
        return self._json({"diff": out, "path": rel})

    def _api_git_branches(self, rel):
        repo = self._resolve_repo(rel)
        if repo is None:
            return
        cur = ""
        code, out, _ = run_git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo)
        if code == 0:
            cur = out.strip()
        head_code, _, _ = run_git(["rev-parse", "--verify", "HEAD"], repo)
        branches = []
        code, out, _ = run_git(["branch", "--format=%(refname:short)"], repo)
        if code == 0:
            branches = [b.strip() for b in out.splitlines() if b.strip()]
        return self._json({"current": cur, "branches": branches, "hasHead": head_code == 0})

    def _api_git_log(self, rel, ref=""):
        repo = self._resolve_repo(rel)
        if repo is None:
            return
        args = ["log", "--topo-order", "-100", "--pretty=format:%h\x1f%an\x1f%ar\x1f%s\x1f%D\x1f%p"]
        if ref == "__all__":
            args.append("--all")
        elif ref and self._valid_ref(ref):   # 用统一校验器：拒前导 '-'(选项注入)/'..'/.lock
            args.append(ref)
        code, out, err = run_git(args, repo)
        commits = []
        if code == 0:
            for line in out.splitlines():
                parts = line.split("\x1f")
                if len(parts) >= 4:
                    refs = []
                    refs_raw = parts[4] if len(parts) > 4 else ""
                    for r in refs_raw.split(","):
                        r = r.strip()
                        if not r or r == "HEAD":
                            continue
                        if r.startswith("HEAD -> "):
                            r = r[len("HEAD -> "):]
                            refs.insert(0, {"name": r, "kind": "head"})
                        elif r.startswith("tag: "):
                            refs.append({"name": r[len("tag: "):], "kind": "tag"})
                        elif r.startswith("origin/") or "/" in r and r.split("/")[0] in ("origin", "upstream"):
                            refs.append({"name": r, "kind": "remote"})
                        else:
                            refs.append({"name": r, "kind": "branch"})
                    parents = parts[5].split() if len(parts) > 5 and parts[5].strip() else []
                    commits.append({"hash": parts[0], "author": parts[1],
                                    "when": parts[2], "subject": parts[3],
                                    "refs": refs, "parents": parents})
        return self._json({"commits": commits})

    def _api_git_show(self, rel, h):
        if not re.fullmatch(r"[0-9a-fA-F]{4,40}", h or ""):
            return self._err("非法 hash")
        try:
            target = safe_resolve(rel)
        except PermissionError:
            return self._err("forbidden", 403)
        if not target.exists():
            target = ROOT
        repo = find_repo(target)
        if repo is None:
            return self._err("不在仓库内", 404)
        code, out, err = run_git(
            ["log", "-1", h, "--shortstat", "--date=format:%Y-%m-%d %H:%M",
             "--format=%h\x1f%an\x1f%ae\x1f%ad\x1f%ar\x1f%D\x1f%s"], repo)
        if code != 0:
            return self._err(err.strip() or "git show 失败", 500)
        lines = out.split("\n")
        meta = lines[0].split("\x1f")
        while len(meta) < 7:
            meta.append("")
        short, an, ae, ad, ar, refs_raw, subject = meta[:7]
        files = ins = dele = 0
        for L in lines[1:]:
            if "changed" in L:
                m = re.search(r"(\d+) files? changed", L); files = int(m.group(1)) if m else 0
                m = re.search(r"(\d+) insertion", L); ins = int(m.group(1)) if m else 0
                m = re.search(r"(\d+) deletion", L); dele = int(m.group(1)) if m else 0
                break
        refs = []
        for r in refs_raw.split(","):
            r = r.strip()
            if not r:
                continue
            if r.startswith("HEAD -> "):
                r = r[len("HEAD -> "):]
            elif r == "HEAD":
                continue
            elif r.startswith("tag: "):
                r = r[len("tag: "):]
            refs.append(r)
        return self._json({
            "hash": short, "author": an, "email": ae, "date": ad, "when": ar,
            "subject": subject, "refs": refs,
            "files": files, "insertions": ins, "deletions": dele,
        })

    def _api_git_commit(self, body):
        rel = body.get("path", "")
        message = (body.get("message") or "").strip()
        stage_all = body.get("stageAll", True)
        if not message:
            return self._err("提交信息不能为空")
        repo = self._resolve_repo(rel)
        if repo is None:
            return
        if stage_all:
            run_git(["add", "-A"], repo)
        code, out, err = run_git(["commit", "-m", message], repo)
        if code != 0:
            return self._json({"ok": False, "output": (out + err).strip()})
        return self._json({"ok": True, "output": out.strip()})

    def _api_git_push(self, body):
        repo = self._resolve_repo(body.get("path", ""))
        if repo is None:
            return
        code, out, err = run_git(["push"], repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _api_git_init(self, body):
        repo = self._resolve_repo_for_init(body.get("path", ""))
        if repo is None:
            return
        code, out, err = run_git(["init"], repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _resolve_repo_for_init(self, rel):
        try:
            target = safe_resolve(rel)
        except PermissionError:
            self._err("forbidden", 403)
            return None
        d = target if target.is_dir() else target.parent
        return d

    # ---------- 暂存 / 取消暂存 / 丢弃 ----------
    def _repo_and_relpath(self, rel):
        """把 ROOT 相对路径解析为 (repo, repo相对路径, 绝对Path)。失败时已发响应并返回 None。"""
        try:
            fp = safe_resolve(rel)
        except PermissionError:
            self._err("forbidden", 403)
            return None
        repo = find_repo(fp if fp.exists() else fp.parent)
        if repo is None:
            self._err("不在仓库内", 404)
            return None
        repo_rel = str(fp.relative_to(repo)).replace("\\", "/")
        return repo, repo_rel, fp

    def _api_git_stage(self, body):
        info = self._repo_and_relpath(body.get("path", ""))
        if info is None:
            return
        repo, repo_rel, _ = info
        code, out, err = run_git(["add", "--", repo_rel], repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _api_git_unstage(self, body):
        info = self._repo_and_relpath(body.get("path", ""))
        if info is None:
            return
        repo, repo_rel, _ = info
        # 无 HEAD（空仓库）时用 rm --cached 退化
        code, out, err = run_git(["reset", "-q", "HEAD", "--", repo_rel], repo)
        if code != 0:
            code, out, err = run_git(["rm", "--cached", "-q", "--", repo_rel], repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _api_git_discard(self, body):
        info = self._repo_and_relpath(body.get("path", ""))
        if info is None:
            return
        repo, repo_rel, fp = info
        if body.get("untracked"):
            # 未跟踪文件/目录：直接删除（仍受 ROOT 约束）
            try:
                if fp.is_dir():
                    import shutil
                    shutil.rmtree(fp)
                    return self._json({"ok": True, "output": "已删除未跟踪目录"})
                if fp.is_file():
                    fp.unlink()
                    return self._json({"ok": True, "output": "已删除未跟踪文件"})
                return self._err("目标不存在", 404)
            except OSError:
                return self._err("删除失败", 500)
        code, out, err = run_git(["checkout", "--", repo_rel], repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _api_git_commit_files(self, rel, h):
        if not re.fullmatch(r"[0-9a-fA-F]{4,40}", h or ""):
            return self._err("非法 hash")
        repo = self._resolve_repo(rel)
        if repo is None:
            return
        code, out, err = run_git(
            ["show", "--name-status", "--format=", "-M", h], repo)
        if code != 0:
            return self._err(err.strip() or "读取提交失败", 500)
        files = []
        for line in out.splitlines():
            if not line.strip():
                continue
            cols = line.split("\t")
            status = cols[0][:1]
            path = cols[-1]  # 重命名取新名
            files.append({"status": status, "path": path})
        return self._json({"hash": h, "files": files})

    def _api_git_commit_diff(self, rel, h, path):
        if not re.fullmatch(r"[0-9a-fA-F]{4,40}", h or ""):
            return self._err("非法 hash")
        if not path:
            return self._err("缺少 path")
        repo = self._resolve_repo(rel)
        if repo is None:
            return
        code, out, err = run_git(
            ["show", "--format=", "-M", h, "--", path], repo)
        if code != 0:
            return self._err(err.strip() or "读取 diff 失败", 500)
        return self._json({"diff": out, "path": path, "hash": h})

    # ---------- 单文件历史 / blame ----------
    def _api_git_file_log(self, rel):
        """某文件的提交历史（沿重命名追踪）。"""
        info = self._repo_and_relpath(rel)
        if info is None:
            return
        repo, repo_rel, _ = info
        code, out, err = run_git(
            ["log", "-100", "--follow",
             "--pretty=format:%h\x1f%an\x1f%ar\x1f%ad\x1f%s",
             "--date=format:%Y-%m-%d %H:%M", "--", repo_rel], repo)
        if code != 0:
            return self._err(err.strip() or "读取文件历史失败", 500)
        commits = []
        for line in out.splitlines():
            parts = line.split("\x1f")
            if len(parts) >= 5:
                commits.append({"hash": parts[0], "author": parts[1],
                                "when": parts[2], "date": parts[3],
                                "subject": parts[4]})
        return self._json({"path": repo_rel, "commits": commits})

    def _api_git_blame(self, rel):
        """git blame --porcelain 解析，逐行返回 作者 / 短hash / 内容。"""
        info = self._repo_and_relpath(rel)
        if info is None:
            return
        repo, repo_rel, fp = info
        if not fp.is_file():
            return self._err("不是文件", 404)
        code, out, err = run_git(
            ["blame", "--porcelain", "--", repo_rel], repo)
        if code != 0:
            return self._err(err.strip() or "blame 失败", 500)
        lines = []
        commit_meta = {}   # hash -> {author, summary}
        cur_hash = None
        cur_author = ""
        cur_summary = ""
        it = iter(out.split("\n"))
        for raw in it:
            if not raw:
                continue
            # 头行: <40hex> <orig-line> <final-line> [num]
            m = re.match(r"^([0-9a-f]{40})\s+\d+\s+\d+", raw)
            if m:
                cur_hash = m.group(1)
                meta = commit_meta.get(cur_hash, {})
                cur_author = meta.get("author", "")
                cur_summary = meta.get("summary", "")
                continue
            if raw.startswith("author "):
                cur_author = raw[len("author "):]
                commit_meta.setdefault(cur_hash, {})["author"] = cur_author
                continue
            if raw.startswith("summary "):
                cur_summary = raw[len("summary "):]
                commit_meta.setdefault(cur_hash, {})["summary"] = cur_summary
                continue
            if raw.startswith("\t"):
                lines.append({
                    "hash": (cur_hash or "")[:8],
                    "author": cur_author,
                    "summary": cur_summary,
                    "text": raw[1:],
                })
        return self._json({"path": repo_rel, "lines": lines})

    # ---------- 分支操作 ----------
    @staticmethod
    def _valid_ref(name):
        """合法的分支/引用名（保守白名单）。"""
        name = (name or "").strip()
        if not name or len(name) > 200:
            return False
        if name.startswith("-") or name.startswith("/") or name.endswith("/"):
            return False
        if ".." in name or name.endswith(".lock"):
            return False
        # 允许字母数字 / . _ - 及命名空间分隔 /
        return bool(re.fullmatch(r"[\w./-]+", name))

    def _api_git_checkout(self, body):
        ref = (body.get("ref") or "").strip()
        if not self._valid_ref(ref):
            return self._err("非法分支/引用名")
        repo = self._resolve_repo(body.get("path", ""))
        if repo is None:
            return
        code, out, err = run_git(["checkout", ref], repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _api_git_branch_create(self, body):
        name = (body.get("name") or "").strip()
        if not self._valid_ref(name):
            return self._err("非法分支名")
        repo = self._resolve_repo(body.get("path", ""))
        if repo is None:
            return
        # 默认创建并切换；可选 from 起点
        start = (body.get("from") or "").strip()
        args = ["checkout", "-b", name]
        if start and self._valid_ref(start):
            args.append(start)
        code, out, err = run_git(args, repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _api_git_branch_delete(self, body):
        name = (body.get("name") or "").strip()
        if not self._valid_ref(name):
            return self._err("非法分支名")
        repo = self._resolve_repo(body.get("path", ""))
        if repo is None:
            return
        flag = "-D" if body.get("force") else "-d"
        code, out, err = run_git(["branch", flag, name], repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    # ---------- stash ----------
    def _api_git_stash_list(self, rel):
        repo = self._resolve_repo(rel)
        if repo is None:
            return
        code, out, err = run_git(
            ["stash", "list", "--pretty=format:%gd\x1f%s\x1f%cr"], repo)
        if code != 0:
            return self._err(err.strip() or "stash list 失败", 500)
        stashes = []
        for line in out.splitlines():
            parts = line.split("\x1f")
            if len(parts) >= 2:
                stashes.append({"ref": parts[0], "subject": parts[1],
                                "when": parts[2] if len(parts) > 2 else ""})
        return self._json({"stashes": stashes})

    def _api_git_stash_save(self, body):
        repo = self._resolve_repo(body.get("path", ""))
        if repo is None:
            return
        msg = (body.get("message") or "").strip()
        args = ["stash", "push", "-u"]
        if msg:
            args += ["-m", msg]
        code, out, err = run_git(args, repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _api_git_stash_pop(self, body):
        repo = self._resolve_repo(body.get("path", ""))
        if repo is None:
            return
        ref = (body.get("ref") or "").strip()
        args = ["stash", "pop"]
        if ref:
            if not re.fullmatch(r"stash@\{\d+\}", ref):
                return self._err("非法 stash 引用")
            args.append(ref)
        code, out, err = run_git(args, repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=None, help="工作根目录")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true", help="启动时不自动打开浏览器")
    args = ap.parse_args()

    # 工作区决策（IDE 式）：命令行显式路径 > 上次活动工作区(config.currentWorkspace) > 旧版 lastRoot > 空工作区。
    if args.root:
        set_workspace_roots([Path(args.root).resolve()])
    else:
        cfg = load_config()
        cur = cfg.get("currentWorkspace") if isinstance(cfg.get("currentWorkspace"), dict) else None
        roots = []
        if cur and isinstance(cur.get("roots"), list):
            for raw in cur.get("roots", []):
                try:
                    p = Path(raw).resolve()
                except (OSError, ValueError):
                    continue
                if p.is_dir():
                    roots.append(p)
        if roots:
            set_workspace_roots(roots)
        else:
            last = cfg.get("lastRoot")
            if last and Path(last).is_dir():
                set_workspace_roots([Path(last).resolve()])
            else:
                set_workspace_roots([])
    if ROOT is not None and not ROOT.is_dir():
        print(f"根目录不存在: {ROOT}", file=sys.stderr)
        sys.exit(1)

    # 非回环绑定守卫：默认拒绝把无鉴权的 /api/exec(任意命令) 与 /api/file(任意读) 暴露到局域网
    def _is_loopback(host):
        import ipaddress
        if host == "localhost":
            return True
        try:
            return ipaddress.ip_address(host).is_loopback
        except ValueError:
            return False
    if not _is_loopback(args.host):
        print(f"[!] 警告: 绑定到非本地地址 {args.host} 会把无鉴权的 /api/exec(任意命令执行) 与 "
              f"/api/file(任意文件读取) 暴露给局域网。", file=sys.stderr)
        if os.environ.get("WORKBENCH_ALLOW_REMOTE") != "1":
            print("    已拒绝启动。如确需远程绑定，请显式设置环境变量 WORKBENCH_ALLOW_REMOTE=1。", file=sys.stderr)
            sys.exit(1)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    print(f"Workbench 已启动")
    print(f"  根目录: {ROOT}")
    print(f"  地址:   {url}")
    print("  Ctrl+C 退出")
    # 默认自动打开浏览器（套接字已绑定监听，连接会正常排队）
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")


if __name__ == "__main__":
    main()
