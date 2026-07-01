#!/usr/bin/env python3
"""Loom - 本地工作台后端 (纯标准库)

用法:
    python server.py [工作根目录] [--port 8765]

不传根目录时默认恢复上次工作区。浏览器打开 http://localhost:<port>
"""
from wb.main import main

if __name__ == "__main__":
    main()
