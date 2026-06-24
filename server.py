#!/usr/bin/env python3
"""Workbench - 本地工作台后端 (纯标准库)

用法:
    python server.py [工作根目录] [--port 8765]

不传根目录时默认当前盘符根 (脚本所在盘)。浏览器打开 http://localhost:<port>
"""
import argparse
import json
import mimetypes
import os
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# 这些扩展名按文本编辑处理
TEXT_EXTS = {
    ".md", ".markdown", ".txt", ".json", ".js", ".ts", ".jsx", ".tsx",
    ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".css",
    ".scss", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini",
    ".cfg", ".conf", ".sh", ".bash", ".ps1", ".bat", ".sql", ".csv",
    ".log", ".env", ".gitignore", ".dockerfile", ".vue", ".svelte",
}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"}
MAX_TEXT_BYTES = 5 * 1024 * 1024  # 5MB 以上不当文本读

ROOT = Path("/")  # 运行时覆盖


def safe_resolve(rel: str) -> Path:
    """把相对路径解析到 ROOT 内, 阻止越界 (.. 穿越)。"""
    rel = unquote(rel or "").lstrip("/\\")
    target = (ROOT / rel).resolve()
    if target != ROOT and ROOT not in target.parents:
        raise PermissionError("path escapes root")
    return target


# ---------- git 辅助 ----------
def run_git(args, cwd):
    """运行 git, 返回 (returncode, stdout, stderr)。"""
    try:
        p = subprocess.run(
            ["git", "-c", "core.quotepath=false"] + args,
            cwd=str(cwd), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=30,
        )
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return -1, "", "未找到 git 命令"
    except subprocess.TimeoutExpired:
        return -1, "", "git 执行超时"


def find_repo(start: Path):
    """从 start 向上找包含 .git 的目录, 只在 ROOT 范围内。找不到返回 None。"""
    d = start if start.is_dir() else start.parent
    for c in [d, *d.parents]:
        within = c == ROOT or ROOT in c.parents
        if within and (c / ".git").exists():
            return c
        if c == ROOT:
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
    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _err(self, msg, status=400):
        self._json({"error": msg}, status)

    def _check_csrf(self):
        """阻止跨站请求伪造：写操作必须同源 + Content-Type 为 application/json。

        - 要求 application/json：跨站的表单/简单请求无法设置该类型，会触发预检，
          而本服务不应答 CORS 预检，浏览器即拦截，从根上挡住无预检的简单请求 CSRF。
        - Sec-Fetch-Site 若存在，必须是 same-origin/same-site/none。
        - Origin 若存在，其 host 必须与 Host 头一致。
        """
        ctype = self.headers.get("Content-Type", "")
        if not ctype.startswith("application/json"):
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

    def _read_json_body(self):
        """读取并解析 POST 的 JSON。出错时已发响应并返回 None。"""
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._err("请求体必须是合法的 UTF-8 JSON")
            return None

    def _send_bytes(self, data: bytes, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------- routing ----------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/" or path == "":
            return self._serve_static("index.html")
        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/"):])
        if path == "/api/root":
            return self._json({"root": str(ROOT)})
        if path == "/api/tree":
            return self._api_tree(qs.get("path", [""])[0])
        if path == "/api/file":
            return self._api_file(qs.get("path", [""])[0])
        if path == "/api/git/status":
            return self._api_git_status(qs.get("path", [""])[0])
        if path == "/api/git/diff":
            return self._api_git_diff(qs.get("path", [""])[0])
        if path == "/api/git/log":
            return self._api_git_log(qs.get("path", [""])[0])
        if path == "/api/git/show":
            return self._api_git_show(qs.get("path", [""])[0], qs.get("hash", [""])[0])
        return self._err("not found", 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if not self._check_csrf():
            return self._err("拒绝跨站请求（需同源且 Content-Type: application/json）", 403)
        if parsed.path == "/api/save":
            body = self._read_json_body()
            if body is None:
                return
            return self._api_save(body)
        if parsed.path in ("/api/git/commit", "/api/git/push", "/api/git/init"):
            body = self._read_json_body()
            if body is None:
                return
            if parsed.path == "/api/git/commit":
                return self._api_git_commit(body)
            if parsed.path == "/api/git/push":
                return self._api_git_push(body)
            return self._api_git_init(body)
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
        try:
            d = safe_resolve(rel)
        except PermissionError:
            return self._err("forbidden", 403)
        if not d.is_dir():
            return self._err("not a directory", 404)
        dirs, files = [], []
        try:
            for entry in sorted(d.iterdir(), key=lambda e: e.name.lower()):
                if entry.name.startswith("$") or entry.name == "System Volume Information":
                    continue
                rel_path = str(entry.relative_to(ROOT)).replace("\\", "/")
                if entry.is_dir():
                    dirs.append({"name": entry.name, "path": rel_path, "type": "dir"})
                else:
                    files.append({
                        "name": entry.name, "path": rel_path, "type": "file",
                        "kind": classify(entry),
                        "size": entry.stat().st_size,
                    })
        except PermissionError:
            return self._err("permission denied", 403)
        rel_norm = str(d.relative_to(ROOT)).replace("\\", "/") if d != ROOT else ""
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
        if kind == "binary" or size > MAX_TEXT_BYTES:
            return self._json({"kind": "binary", "size": size,
                               "name": fp.name})
        try:
            content = fp.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return self._json({"kind": "binary", "size": size, "name": fp.name})
        return self._json({"kind": "text", "name": fp.name, "ext": fp.suffix.lower(),
                           "content": content, "size": size})

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
            fp.parent.mkdir(parents=True, exist_ok=True)
            # write_bytes 不做换行转换，保留原始 \n（避免 Windows 上被强制 CRLF）
            fp.write_bytes(data)
        except OSError as e:
            return self._err(f"write failed: {e}", 500)
        return self._json({"ok": True, "size": len(data)})

    # ---------- git api ----------
    def _resolve_repo(self, rel):
        """返回 (repo_path, error_response_called)。找不到仓库时已发送响应。"""
        try:
            target = safe_resolve(rel)
        except PermissionError:
            self._err("forbidden", 403)
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
        files = []
        for line in out.splitlines():
            if line.startswith("## "):
                head = line[3:]
                branch = head.split("...")[0].strip()
                if "[ahead " in head:
                    ahead = int(head.split("[ahead ")[1].split("]")[0].split(",")[0])
                if "behind " in head:
                    behind = int(head.split("behind ")[1].split("]")[0])
                continue
            if not line.strip():
                continue
            xy = line[:2]
            fname = line[3:].strip().strip('"')
            if " -> " in fname:  # 重命名
                fname = fname.split(" -> ")[1]
            try:
                root_rel = str((repo / fname).resolve().relative_to(ROOT)).replace("\\", "/")
            except ValueError:
                root_rel = None
            files.append({"status": xy, "repoPath": fname, "path": root_rel})
        repo_rel = str(repo.relative_to(ROOT)).replace("\\", "/") if repo != ROOT else ""
        return self._json({"repo": repo_rel, "branch": branch,
                           "ahead": ahead, "behind": behind, "files": files})

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

    def _api_git_log(self, rel):
        repo = self._resolve_repo(rel)
        if repo is None:
            return
        code, out, err = run_git(
            ["log", "-30", "--pretty=format:%h\x1f%an\x1f%ar\x1f%s\x1f%D"], repo)
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
                    commits.append({"hash": parts[0], "author": parts[1],
                                    "when": parts[2], "subject": parts[3], "refs": refs})
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


def main():
    global ROOT
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=None, help="工作根目录")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    if args.root:
        ROOT = Path(args.root).resolve()
    else:
        ROOT = Path(BASE_DIR.anchor or "/").resolve()  # 脚本所在盘根
    if not ROOT.is_dir():
        print(f"根目录不存在: {ROOT}", file=sys.stderr)
        sys.exit(1)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Workbench 已启动")
    print(f"  根目录: {ROOT}")
    print(f"  地址:   http://{args.host}:{args.port}")
    print("  Ctrl+C 退出")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")


if __name__ == "__main__":
    main()
