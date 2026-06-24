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
import shutil
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
        if path == "/api/files-flat":
            return self._api_files_flat()
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
        post_routes = {
            "/api/git/commit": self._api_git_commit,
            "/api/git/push": self._api_git_push,
            "/api/git/init": self._api_git_init,
            "/api/git/stage": self._api_git_stage,
            "/api/git/unstage": self._api_git_unstage,
            "/api/git/discard": self._api_git_discard,
            "/api/fs/create": self._api_fs_create,
            "/api/fs/rename": self._api_fs_rename,
            "/api/fs/delete": self._api_fs_delete,
        }
        if parsed.path in post_routes:
            body = self._read_json_body()
            if body is None:
                return
            return post_routes[parsed.path](body)
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
        for dirpath, dirnames, filenames in os.walk(ROOT):
            # 原地裁剪要进入的子目录（忽略隐藏的 $ 卷目录与黑名单目录）
            dirnames[:] = [
                d for d in dirnames
                if d not in skip and not d.startswith("$")
            ]
            dirnames.sort(key=str.lower)
            for name in sorted(filenames, key=str.lower):
                fp = Path(dirpath) / name
                try:
                    rel = str(fp.relative_to(ROOT)).replace("\\", "/")
                except ValueError:
                    continue
                out.append(rel)
                if len(out) >= limit:
                    return self._json({"files": out, "truncated": True})
        return self._json({"files": out, "truncated": False})

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

    # ---------- 文件操作（新建/重命名/删除）----------
    @staticmethod
    def _valid_name(name):
        return bool(name) and name not in (".", "..") \
            and "/" not in name and "\\" not in name \
            and not re.search(r'[:*?"<>|]', name)

    def _rel_of(self, p):
        return str(p.relative_to(ROOT)).replace("\\", "/")

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
        except OSError as e:
            return self._err(f"创建失败: {e}", 500)
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
            return self._err("目标已存在")
        try:
            src.rename(dst)
        except OSError as e:
            return self._err(f"重命名失败: {e}", 500)
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
            return self._err(f"删除失败: {e}", 500)
        return self._json({"ok": True})

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
        staged, unstaged = [], []

        def entry(status, fname):
            try:
                root_rel = str((repo / fname).resolve().relative_to(ROOT)).replace("\\", "/")
            except ValueError:
                root_rel = None
            return {"status": status, "repoPath": fname, "path": root_rel}

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
        repo_rel = str(repo.relative_to(ROOT)).replace("\\", "/") if repo != ROOT else ""
        # 唯一文件数（一个文件可能同时在两组）作为徽标计数
        changed = len({e["repoPath"] for e in staged + unstaged})
        return self._json({"repo": repo_rel, "branch": branch,
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
        code, out, _ = run_git(["rev-parse", "--abbrev-ref", "HEAD"], repo)
        if code == 0:
            cur = out.strip()
        branches = []
        code, out, _ = run_git(["branch", "--format=%(refname:short)"], repo)
        if code == 0:
            branches = [b.strip() for b in out.splitlines() if b.strip()]
        return self._json({"current": cur, "branches": branches})

    def _api_git_log(self, rel, ref=""):
        repo = self._resolve_repo(rel)
        if repo is None:
            return
        args = ["log", "-100", "--pretty=format:%h\x1f%an\x1f%ar\x1f%s\x1f%D\x1f%p"]
        if ref == "__all__":
            args.append("--all")
        elif ref and re.fullmatch(r"[\w./-]+", ref):
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
            # 未跟踪文件：直接删除（仍受 ROOT 约束）
            try:
                if fp.is_file():
                    fp.unlink()
                return self._json({"ok": True, "output": "已删除未跟踪文件"})
            except OSError as e:
                return self._err(f"删除失败: {e}", 500)
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
