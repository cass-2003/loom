#!/usr/bin/env python3
"""Workbench 桌面版入口。

把本地工作台包成一个**无边框原生窗口程序**（pywebview + 系统 WebView2 内核）：
去掉操作系统标题栏，由前端自绘一套跟随主题的标题栏与窗口按钮；
后端 HTTP 服务跑在后台线程，自动挑空闲端口，绝不与机器上其它服务撞端口。

依赖 pywebview（仅桌面版需要；纯命令行 server.py 仍是零依赖浏览器版）。
"""
import socket
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


def find_free_port(host="127.0.0.1"):
    """让操作系统分配一个空闲端口，避免与现有服务撞端口。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, 0))
        return s.getsockname()[1]
    finally:
        s.close()


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
    port = find_free_port(host)

    # ThreadingHTTPServer 构造时即 bind+listen，故下面创建窗口前端口已可连接
    httpd = server.ThreadingHTTPServer((host, port), server.Handler)
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
        httpd.shutdown()


if __name__ == "__main__":
    main()
