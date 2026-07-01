"""Loom HTTP Handler — 基础设施 + 路由 + Mixin 组装。"""
import json
import mimetypes
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import wb.state
from wb.paths import current_workspace_roots, has_workspace
from wb.config import _workspace_payload
from wb.api_files import FilesMixin
from wb.api_git import GitMixin
from wb.api_terminal import TerminalMixin
from wb.api_project import ProjectMixin


class Handler(FilesMixin, GitMixin, TerminalMixin, ProjectMixin, BaseHTTPRequestHandler):
    server_version = "Loom/0.1"

    def log_message(self, fmt, *args):
        pass

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
        try:
            host_only = urlparse("//" + self.headers.get("Host", "")).hostname
        except ValueError:
            return False
        return host_only in ("localhost", "127.0.0.1", "::1")

    def _check_csrf(self):
        ctype = self.headers.get("Content-Type", "")
        if not ctype.startswith("application/json"):
            return False
        if not self._host_is_loopback():
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

    _MAX_BODY = 64 * 1024 * 1024

    def _read_json_body(self):
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
        self.send_header("Cache-Control", "no-store, max-age=0")
        self._sec_headers()
        self.end_headers()
        self.wfile.write(data)

    # ---------- routing ----------

    def do_GET(self):
        parsed = urlparse(self.path)
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

    def _safe_err(self, msg, status):
        try:
            return self._err(msg, status)
        except Exception:
            return None

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
                "root": str(wb.state.ROOT) if wb.state.ROOT is not None else None,
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
            raise
        except Exception:
            return self._safe_err("请求处理失败", 500)

    def _dispatch_post(self, parsed):
        if parsed.path == "/api/save":
            body = self._read_json_body()
            if body is None:
                return
            return self._api_save(body)
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
            "/api/playbook/run": "_api_playbook_run",
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

    def _serve_static(self, rel):
        rel = rel.split("?")[0]
        fp = (wb.state.STATIC_DIR / rel).resolve()
        if wb.state.STATIC_DIR not in fp.parents and fp != wb.state.STATIC_DIR:
            return self._err("forbidden", 403)
        if not fp.is_file():
            return self._err("not found", 404)
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        self._send_bytes(fp.read_bytes(), ctype)
