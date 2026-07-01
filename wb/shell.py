"""终端会话管理（ConPTY / pywinpty / pipe 回退）。"""
import codecs
import os
import subprocess
import sys
import threading
import time

import wb.state
from wb.constants import _NO_WINDOW

_IS_WIN = sys.platform == "win32"

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
        return f'"{path}" /Q'
    if shell_id == "gitbash":
        return f'"{path}" -l'
    if shell_id == "wsl":
        return f'"{path}"'
    return f'"{path}"'


def _shell_argv_pty(shell_id: str):
    """shell id → 真 PTY（pywinpty）的 argv 列表。"""
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


_SHELL_BACKEND_ECHO = {
    "cmd": True,
    "gitbash": True,
    "wsl": True,
    "powershell": False,
}


def _oem_codepage_name():
    """返回控制台 OEM 码页对应的 Python 编码名。"""
    if not _IS_WIN:
        return "utf-8"
    try:
        import ctypes
        cp = ctypes.windll.kernel32.GetOEMCP()
        name = "cp%d" % cp
        codecs.lookup(name)
        return name
    except Exception:
        return "mbcs"


_OEM_ENC = _oem_codepage_name()
_SHELL_TERM_ENC = {
    "cmd": _OEM_ENC,
    "powershell": "utf-8",
    "gitbash": "utf-8",
    "wsl": "utf-8",
}


def _shell_init_lines(shell_id: str):
    """会话起始注入的初始化命令。"""
    if shell_id == "cmd":
        return ["cls"]
    if shell_id == "powershell":
        return [
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
            "[Console]::InputEncoding=[Text.Encoding]::UTF8;"
            "$OutputEncoding=[Text.Encoding]::UTF8",
            "Clear-Host",
        ]
    if shell_id in ("gitbash", "wsl"):
        return ["clear"]
    return []


if _IS_WIN:
    import ctypes
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)

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
        _CreatePseudoConsole.restype = ctypes.c_long
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
    """

    _BUF_CAP = 4 * 1024 * 1024

    def __init__(self, shell_id: str, cols: int = 80, rows: int = 24):
        self.shell_id = shell_id
        self.cols = max(1, int(cols or 80))
        self.rows = max(1, int(rows or 24))
        self._buf = bytearray()
        self._base = 0
        self._lock = threading.Lock()
        self._alive = True
        self._mode = None
        self._closed = False
        self._pty = None
        self._backend_echo = _SHELL_BACKEND_ECHO.get(shell_id, True)
        self._term_enc = _SHELL_TERM_ENC.get(shell_id, "utf-8")
        self._decoder = None
        if self._term_enc != "utf-8":
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
        if _IS_WIN and _HAS_WINPTY:
            try:
                self._start_winpty()
                self._mode = "winpty"
                self._start_reader()
                started = True
            except Exception as e:
                self._pty = None
                self._fallback_reason = f"winpty: {e}"
        if not started and _IS_WIN and _HAS_CONPTY:
            try:
                self._start_conpty(cmdline)
                self._mode = "conpty"
                self._start_reader()
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
                with self._lock:
                    return bool(self._buf)
            time.sleep(0.05)
        return False

    def _teardown_conpty(self):
        """探活失败时拆掉 ConPTY。"""
        self._closed = True
        try:
            if getattr(self, "_hProcess", None):
                _k32.TerminateProcess(self._hProcess, 0)
        except Exception:
            pass
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
        self._closed = False
        with self._lock:
            self._buf = bytearray()
            self._base = 0

    def _start_winpty(self):
        argv = _shell_argv_pty(self.shell_id)
        if not argv:
            raise ValueError(f"未知 shell: {self.shell_id}")
        root = str(wb.state.ROOT)
        cwd = root if os.path.isdir(root) else None
        self._pty = _winpty.PtyProcess.spawn(
            argv, cwd=cwd, dimensions=(self.rows, self.cols))

    def _start_conpty(self, cmdline):
        sa = _SECURITY_ATTRIBUTES()
        sa.nLength = ctypes.sizeof(_SECURITY_ATTRIBUTES)
        sa.bInheritHandle = True
        sa.lpSecurityDescriptor = None

        in_read = wintypes.HANDLE()
        in_write = wintypes.HANDLE()
        out_read = wintypes.HANDLE()
        out_write = wintypes.HANDLE()

        if not _k32.CreatePipe(ctypes.byref(in_read), ctypes.byref(in_write),
                               ctypes.byref(sa), 0):
            raise _winerr("CreatePipe(input) 失败")
        if not _k32.CreatePipe(ctypes.byref(out_read), ctypes.byref(out_write),
                               ctypes.byref(sa), 0):
            _k32.CloseHandle(in_read)
            _k32.CloseHandle(in_write)
            raise _winerr("CreatePipe(output) 失败")

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

        _k32.CloseHandle(in_read)
        _k32.CloseHandle(out_write)
        self._in_read = None
        self._out_write = None
        self._in_write = in_write
        self._out_read = out_read

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
        self._attr_buf = attr_buf
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
            str(wb.state.ROOT), ctypes.byref(si_ex), ctypes.byref(pi))
        _k32.DeleteProcThreadAttributeList(si_ex.lpAttributeList)
        if not ok:
            self._cleanup_handles()
            raise _winerr("CreateProcessW 失败")
        self._hProcess = pi.hProcess
        if pi.hThread:
            _k32.CloseHandle(pi.hThread)
        self._pid = pi.dwProcessId

    def _start_pipe(self, cmdline):
        flags = _NO_WINDOW
        self._proc = subprocess.Popen(
            cmdline, cwd=str(wb.state.ROOT), shell=False,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, bufsize=0,
            creationflags=flags,
        )
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

    def _reader(self):
        if self._mode == "winpty":
            self._reader_winpty()
        elif self._mode == "conpty":
            self._reader_conpty()
        else:
            self._reader_pipe()
        self._alive = False

    def _reader_winpty(self):
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
                break
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
                text = self._decoder.decode(chunk)
                if text:
                    with self._lock:
                        self._append(text.encode("utf-8"))
            else:
                with self._lock:
                    self._append(chunk)

    def write(self, data: bytes):
        if self._closed:
            return
        if self._mode == "winpty":
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
            out = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            if self._backend_echo:
                with self._lock:
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

    def _append(self, data: bytes):
        self._buf.extend(data)
        excess = len(self._buf) - self._BUF_CAP
        if excess > 0:
            del self._buf[:excess]
            self._base += excess

    def read_since(self, offset: int):
        with self._lock:
            base = self._base
            total = base + len(self._buf)
            if offset < base:
                offset = base
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


TERMS = {}
TERMS_LOCK = threading.Lock()
MAX_TERMS = 8
