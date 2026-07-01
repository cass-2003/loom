"""终端与执行 API Mixin。"""
import base64
import json
import os
import re
import secrets
import time
from pathlib import Path

import wb.state
from wb.constants import IMAGE_EXTS, EXEC_TIMEOUT
from wb.paths import safe_resolve, resolve_cwd, atomic_write_bytes
from wb.run import run_shell, run_argv, RUN_INTERPRETERS
from wb.shell import TermSession, TERMS, TERMS_LOCK, MAX_TERMS, detect_shells, _shell_path
from wb.classify import parse_makefile_targets


class TerminalMixin:
    """Handler mixin: 终端会话 / 执行 / 上传。

    self._json() / self._err() / self._rel_of() 由 Handler 基类提供。
    """

    _IMG_EXT_BY_MIME = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
        "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp",
        "image/svg+xml": ".svg", "image/x-icon": ".ico",
    }
    _MAX_IMG_BYTES = 20 * 1024 * 1024

    def _api_upload_image(self, body):
        """把 base64 图片存到 ROOT/assets/ 下，返回相对路径。

        body: {dataB64: str(可含 data:URL 前缀), name?: str, mime?: str}
        """
        raw_b64 = body.get("dataB64") or body.get("data") or ""
        if not isinstance(raw_b64, str) or not raw_b64.strip():
            return self._err("缺少图片数据")
        mime = body.get("mime") or ""
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
        ext = self._IMG_EXT_BY_MIME.get(mime.lower(), "")
        if not ext:
            orig = str(body.get("name") or "")
            oext = os.path.splitext(orig)[1].lower()
            if oext in IMAGE_EXTS:
                ext = oext
        if not ext:
            ext = ".png"
        stem = "img"
        orig_name = str(body.get("name") or "").strip()
        if orig_name:
            base_stem = os.path.splitext(os.path.basename(orig_name))[0]
            base_stem = re.sub(r'[^\w.\-]+', "-", base_stem).strip("-")
            if base_stem:
                stem = base_stem
        ts = time.strftime("%Y%m%d-%H%M%S")
        fname = f"{stem}-{ts}-{int(time.time() * 1000) % 1000:03d}{ext}"
        ROOT = wb.state.ROOT
        assets_dir = ROOT / "assets"
        try:
            assets_dir.mkdir(parents=True, exist_ok=True)
            fp = assets_dir / fname
            if fp.exists():
                fname = f"{stem}-{ts}-{int(time.time() * 1000000) % 1000000:06d}{ext}"
                fp = assets_dir / fname
            atomic_write_bytes(fp, data)
        except OSError:
            return self._err("保存失败", 500)
        rel = self._rel_of(fp)
        return self._json({"ok": True, "path": rel, "size": len(data)})

    def _api_exec(self, body):
        """POST /api/exec {cmd, cwd?} —— 在 ROOT 内执行 shell 命令。"""
        cmd = (body.get("cmd") or "").strip()
        if not cmd:
            return self._err("命令不能为空")
        try:
            cwd = resolve_cwd(body.get("cwd", ""))
        except PermissionError:
            return self._err("forbidden", 403)
        ROOT = wb.state.ROOT
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
        code, out, err = run_argv(argv, cwd, EXEC_TIMEOUT)
        return self._json({
            "code": code, "stdout": out, "stderr": err,
            "interpreter": os.path.basename(prefix[0]),
            "path": self._rel_of(fp),
        })

    def _api_run_task(self, body):
        """POST /api/run-task {name, kind} —— 跑 npm/make 任务（在 ROOT）。"""
        ROOT = wb.state.ROOT
        if ROOT is None:
            return self._err("未打开工作区")
        name = (body.get("name") or "").strip()
        kind = (body.get("kind") or "").strip()
        if not name:
            return self._err("缺少任务名")
        if not re.fullmatch(r"[\w.:\-/]+", name):
            return self._err("任务名含非法字符")
        if kind == "npm":
            if not (ROOT / "package.json").is_file():
                return self._err("根目录无 package.json")
            argv = ["npm", "run", name]
        elif kind == "make":
            if not (ROOT / "Makefile").is_file():
                return self._err("根目录无 Makefile")
            argv = ["make", name]
        else:
            return self._err("kind 必须是 npm 或 make")
        code, out, err = run_argv(argv, ROOT, 300)
        return self._json({"code": code, "stdout": out, "stderr": err, "cmd": " ".join(argv)})

    def _api_tasks(self, rel):
        """GET /api/tasks —— 读 ROOT/package.json scripts 与 Makefile 目标。"""
        ROOT = wb.state.ROOT
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
        with TERMS_LOCK:
            dead = [(s, ss) for s, ss in TERMS.items() if not ss._is_alive()]
            for s, _ in dead:
                TERMS.pop(s, None)
        for _, ss in dead:
            try:
                ss.close()
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
            if len(TERMS) >= MAX_TERMS:
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
        if len(data) > 1048576:
            return self._err("终端输入过大")
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
