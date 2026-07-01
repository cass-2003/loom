"""Loom 启动入口。"""
import argparse
import os
import sys
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path

import wb.state
from wb.config import load_config, set_workspace_roots
from wb.handler import Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=None, help="工作根目录")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true", help="启动时不自动打开浏览器")
    args = ap.parse_args()

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
    if wb.state.ROOT is not None and not wb.state.ROOT.is_dir():
        print(f"根目录不存在: {wb.state.ROOT}", file=sys.stderr)
        sys.exit(1)

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
    print(f"Loom 已启动")
    print(f"  根目录: {wb.state.ROOT}")
    print(f"  地址:   {url}")
    print("  Ctrl+C 退出")
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")
