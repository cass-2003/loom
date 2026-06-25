#!/usr/bin/env python3
"""Workbench 桌面版入口。

把本地工作台包成一个**无边框原生窗口程序**（pywebview + 系统 WebView2 内核）：
去掉操作系统标题栏，由前端自绘一套跟随主题的标题栏与窗口按钮；
后端 HTTP 服务跑在后台线程，自动挑空闲端口，绝不与机器上其它服务撞端口。

依赖 pywebview（仅桌面版需要；纯命令行 server.py 仍是零依赖浏览器版）。
"""
import sys
import threading
from pathlib import Path

import webview

import server


class WindowApi:
    """暴露给前端 JS 的窗口控制接口（window.pywebview.api.*）。"""

    def __init__(self):
        self._win = None
        self._maximized = False

    def bind(self, win):
        self._win = win

    def minimize(self):
        if self._win:
            self._win.minimize()

    def toggle_maximize(self):
        if not self._win:
            return "normal"
        if self._maximized:
            self._win.restore()
            self._maximized = False
        else:
            self._win.maximize()
            self._maximized = True
        return "max" if self._maximized else "normal"

    def close(self):
        if self._win:
            self._win.destroy()

    # ---- 无边框窗口的四边四角缩放（前端透明热区驱动，原生 MoveWindow，无可见边框）----
    def _hwnd(self):
        """取本窗口原生 HWND（优先 pywebview 句柄，退回按标题查找）。"""
        try:
            h = int(self._win.native.Handle)
            if h:
                return h
        except Exception:
            pass
        try:
            import ctypes
            return ctypes.windll.user32.FindWindowW(None, "Workbench")
        except Exception:
            return 0

    def get_window_rect(self):
        """窗口屏幕物理像素几何 {x,y,w,h}，供前端缩放热区起拖取基准。"""
        try:
            import ctypes
            from ctypes import wintypes
            hwnd = self._hwnd()
            if not hwnd:
                return None
            r = wintypes.RECT()
            ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(r))
            return {"x": r.left, "y": r.top,
                    "w": r.right - r.left, "h": r.bottom - r.top}
        except Exception:
            return None

    def set_window_rect(self, x, y, w, h):
        """把窗口移到/缩放到给定物理像素几何（前端缩放热区拖动时调用）。"""
        try:
            import ctypes
            hwnd = self._hwnd()
            if not hwnd:
                return False
            ctypes.windll.user32.MoveWindow(
                hwnd, int(x), int(y), int(w), int(h), True)
            return True
        except Exception:
            return False

    def open_folder(self):
        """弹系统文件夹选择框，选中后切换工作根目录，返回新路径。"""
        if not self._win:
            return None
        res = self._win.create_file_dialog(webview.FOLDER_DIALOG)
        if not res:
            return None
        path = res[0] if isinstance(res, (list, tuple)) else res
        p = Path(path).resolve()
        if p.is_dir():
            server.ROOT = p
            return str(p)
        return None


def _fatal(msg):
    """致命错误提示。--windowed 无控制台，用 MessageBox 让用户看到，而非静默崩溃。"""
    try:
        if sys.platform == "win32":
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, str(msg), "Workbench", 0x10)
        else:
            print(msg, file=sys.stderr)
    except Exception:
        pass


def resolve_root():
    """工作根目录：命令行首个非选项参数 > (打包后) exe 所在目录 > 盘符根。"""
    for a in sys.argv[1:]:
        if not a.startswith("-"):
            p = Path(a).resolve()
            if p.is_dir():
                return p
    if getattr(sys, "frozen", False):
        return server.APP_DIR
    return Path(server.BASE_DIR.anchor or "/").resolve()


def main():
    server.ROOT = resolve_root()
    host = "127.0.0.1"

    # 直接绑定端口 0 让 OS 分配再读回实际端口——消除"先探测再绑定"之间的 TOCTOU/撞端口，
    # 且把绑定 OSError 捕获后弹窗提示（--windowed 无控制台，否则静默崩溃）。
    try:
        httpd = server.ThreadingHTTPServer((host, 0), server.Handler)
    except OSError as e:
        _fatal(f"无法启动本地服务（端口绑定失败）：{e}")
        return
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    api = WindowApi()
    win = webview.create_window(
        "Workbench",
        f"http://{host}:{port}/",
        js_api=api,
        frameless=True,        # 去掉系统标题栏，前端自绘
        easy_drag=False,       # 只允许 .pywebview-drag-region 拖动，不整窗乱拖
        width=1320,
        height=860,
        min_size=(900, 600),
    )
    api.bind(win)
    try:
        webview.start()          # 阻塞，直到用户关闭窗口
    finally:
        # 关窗时清理所有终端会话，杀掉子 shell / winpty agent，避免孤儿进程泄漏
        try:
            with server.TERMS_LOCK:
                sessions = list(server.TERMS.values())
                server.TERMS.clear()
            for sess in sessions:
                try:
                    sess.close()
                except Exception:
                    pass
        except Exception:
            pass
        httpd.shutdown()


if __name__ == "__main__":
    main()
