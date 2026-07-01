"""文件与便签 API Mixin。"""
import json
import mimetypes
import os
import re
import shutil
import time
from pathlib import Path

import wb.state
from wb.classify import classify
from wb.config import _notes_global_path
from wb.constants import MAX_TEXT_BYTES
from wb.paths import (
    atomic_write_bytes,
    current_workspace_roots,
    has_workspace,
    resolve_workspace_detail,
    safe_resolve,
    within_root_real,
    workspace_relpath,
)


class FilesMixin:
    """Handler mixin: 文件树/读写/搜索/FS 操作 + 便签。"""

    # ---- 文件树 ----

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
                    continue
                if is_dir:
                    dirs.append({"name": entry.name, "path": rel_path, "type": "dir"})
                    continue
                try:
                    size = entry.stat().st_size
                    kind = classify(entry)
                except OSError:
                    continue
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
        try:
            raw = fp.read_bytes()
        except OSError:
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
        try:
            fp = safe_resolve(rel)
        except PermissionError:
            return self._err("forbidden", 403)
        if not fp.is_file():
            return self._err("not found", 404)
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        try:
            data = fp.read_bytes()
        except OSError:
            return self._err("读取失败", 500)
        return self._send_bytes(data, ctype)

    _FLAT_SKIP_DIRS = {
        ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
        ".pytest_cache", "dist", "build", ".next", ".nuxt", "target",
        ".idea", ".vscode", ".cache", "System Volume Information",
    }
    _FLAT_LIMIT = 8000

    def _api_files_flat(self):
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

    _SEARCH_SKIP_DIRS = {
        ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
        ".pytest_cache", "dist", "build", ".next", ".nuxt", "target",
        ".idea", ".vscode", ".cache", "System Volume Information",
    }
    _SEARCH_TOTAL_LIMIT = 500
    _SEARCH_PER_FILE_LIMIT = 50
    _SEARCH_MAX_BYTES = 2 * 1024 * 1024

    def _api_search(self, q, use_regex, case_sensitive):
        q = q or ""
        if not q.strip():
            return self._json({"results": [], "truncated": False})
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
        t0 = time.monotonic()

        for root in current_workspace_roots():
            if truncated:
                break
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
                    if time.monotonic() - t0 > 10:
                        truncated = True
                        break
                if truncated:
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
            atomic_write_bytes(fp, data)
        except OSError:
            return self._err("写入失败", 500)
        return self._json({"ok": True, "size": len(data)})

    # ---- 文件操作（新建/重命名/删除）----

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
            parent = safe_resolve(parent_rel) if parent_rel else wb.state.ROOT
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
        except OSError:
            return self._err("删除失败", 500)
        return self._json({"ok": True})

    # ---- 便签 / Todo ----

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
        elif wb.state.ROOT is not None:
            legacy = wb.state.ROOT / ".workbench" / "notes.json"
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
            atomic_write_bytes(fp, data)
        except OSError:
            return self._err("保存失败", 500)
        return self._json({"ok": True})
