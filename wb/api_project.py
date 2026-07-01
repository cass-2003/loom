"""项目状态/任务/会话/生态/工作区 API Mixin。"""
import json
import os
import re
import secrets
import time
from pathlib import Path

import wb.state
from wb.constants import MAX_TEXT_BYTES, PROJECT_STATE_FILES, ROADMAP_FILE
from wb.paths import (safe_resolve, current_workspace_roots, has_workspace,
                      workspace_relpath, atomic_write_bytes)
from wb.config import (load_config, save_config, set_workspace_roots,
                       _workspace_payload, _now_iso, _touch_recent_workspace,
                       _annotate_recent_workspaces)


class ProjectMixin:
    """Handler mixin: 项目记忆/任务/Agent 会话/生态/工作区管理。"""

    # ---------- 段 6: 项目状态 API ----------

    def _api_config(self):
        cfg = load_config()
        roots = [str(r) for r in current_workspace_roots()]
        cur = _workspace_payload(roots) if roots else None
        recent = cfg.get("recentWorkspaces", cfg.get("recent", []))
        return self._json({
            "lastRoot": roots[0] if roots else cfg.get("lastRoot"),
            "recent": _annotate_recent_workspaces(recent),
            "currentRoot": str(wb.state.ROOT) if wb.state.ROOT is not None else None,
            "currentWorkspace": cur,
            "workspaceRoots": roots,
            "workspaceId": cur.get("id") if isinstance(cur, dict) else None,
            "hasWorkspace": has_workspace(),
        })

    def _workspace_state_dir(self) -> Path:
        roots = current_workspace_roots()
        if roots:
            root = roots[0].resolve()
            base = (root / "state").resolve()
            if base == root or root in base.parents:
                return base
        return (wb.state.APP_DIR / "state").resolve()

    def _api_project_state(self, name):
        base = self._workspace_state_dir()
        if name:
            key = (name or "").strip().lower()
            fn = PROJECT_STATE_FILES.get(key)
            if not fn:
                return self._err("unknown project state file", 404)
            files = [(key, fn)]
        else:
            files = list(PROJECT_STATE_FILES.items())
        out = []
        for key, fn in files:
            fp = (base / fn).resolve()
            if fp.parent != base:
                continue
            try:
                exists = fp.is_file()
                text = fp.read_text(encoding="utf-8-sig") if exists else ""
                mtime = fp.stat().st_mtime if exists else None
            except OSError:
                text, mtime = "", None
            out.append({"name": key, "file": fn, "content": text, "mtime": mtime})
        return self._json({"files": out})

    def _project_state_path(self, key):
        key = (key or "").strip().lower()
        fn = PROJECT_STATE_FILES.get(key)
        if not fn:
            return None, None
        base = self._workspace_state_dir()
        fp = (base / fn).resolve()
        if fp.parent != base:
            return None, None
        return fn, fp

    def _api_project_state_file(self, name):
        key = (name or "").strip().lower()
        fn, fp = self._project_state_path(key)
        if not fn:
            return self._err("unknown project state file", 404)
        try:
            text = fp.read_text(encoding="utf-8-sig") if fp.is_file() else ""
            size = len(text.encode("utf-8"))
        except OSError:
            return self._err("读取失败", 500)
        return self._json({
            "kind": "text",
            "name": fn,
            "ext": ".md",
            "content": text,
            "size": size,
            "virtualPath": f"project://{key}",
        })

    def _api_project_roadmap(self):
        fp = (wb.state.DOCS_DIR / ROADMAP_FILE).resolve()
        if fp.parent != wb.state.DOCS_DIR:
            return self._err("forbidden", 403)
        try:
            text = fp.read_text(encoding="utf-8-sig") if fp.is_file() else ""
            mtime = fp.stat().st_mtime if fp.is_file() else None
        except OSError:
            return self._err("路线文档读取失败", 500)
        return self._json({
            "name": "roadmap",
            "file": f"docs/{ROADMAP_FILE}",
            "content": text,
            "mtime": mtime,
            "readonly": True,
        })

    @staticmethod
    def _md_line(text, limit=2000):
        text = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
        text = text[:limit]
        return "\n".join("> " + line for line in text.split("\n")) if text else "> （空）"

    def _append_state_file(self, key, block):
        fn, fp = self._project_state_path(key)
        if not fn:
            return self._err("unknown project state file", 404)
        try:
            fp.parent.mkdir(parents=True, exist_ok=True)
            old = fp.read_text(encoding="utf-8-sig") if fp.is_file() else f"# {fn}\n"
            if old and not old.endswith("\n"):
                old += "\n"
            atomic_write_bytes(fp, (old + "\n" + block.strip() + "\n").encode("utf-8"))
        except OSError:
            return self._err("保存失败", 500)
        return None

    def _api_project_state_append(self, body):
        kind = str(body.get("kind") or "").strip().lower()
        target = str(body.get("target") or "").strip().lower()
        title = str(body.get("title") or "").strip()[:160]
        content = str(body.get("content") or "").strip()
        if kind not in {"decision", "validation", "note"}:
            return self._err("kind 必须是 decision / validation / note")
        if target not in {"log", "progress"}:
            return self._err("target 必须是 log 或 progress")
        if not title and not content:
            return self._err("缺少记录内容")
        if len(content) > 5000:
            return self._err("内容过长")
        label = {"decision": "Decision", "validation": "Validation", "note": "Note"}[kind]
        title = title or label
        stamp = _now_iso().replace("T", " ")
        block = f"### {stamp} · {label}: {title}\n\n{self._md_line(content)}"
        err = self._append_state_file(target, block)
        if err:
            return err
        return self._json({"ok": True, "target": target, "kind": kind})

    def _api_project_state_save(self, body):
        key = str(body.get("name") or "").strip().lower()
        content = body.get("content")
        if not isinstance(content, str):
            return self._err("content 必须是字符串")
        data = content.encode("utf-8")
        if len(data) > MAX_TEXT_BYTES:
            return self._err(f"内容过大（>{MAX_TEXT_BYTES // (1024*1024)}MB），不宜在线编辑")
        fn, fp = self._project_state_path(key)
        if not fn:
            return self._err("unknown project state file", 404)
        try:
            fp.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(fp, data)
        except OSError:
            return self._err("保存失败", 500)
        return self._json({"ok": True, "size": len(data), "target": key})

    # ---------- 段 7: 任务/会话 API ----------

    def _workflow_tasks_path(self) -> Path:
        return (self._workspace_state_dir() / "TASKS.json").resolve()

    def _agent_sessions_path(self) -> Path:
        return (self._workspace_state_dir() / "SESSIONS.json").resolve()

    @staticmethod
    def _text_list(value, *, item_limit=200, count_limit=20):
        if isinstance(value, str):
            value = value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if not isinstance(value, list):
            return []
        out = []
        for item in value:
            text = str(item or "").strip()
            if text:
                out.append(text[:item_limit])
            if len(out) >= count_limit:
                break
        return out

    def _load_workflow_tasks(self):
        fp = self._workflow_tasks_path()
        if fp.parent != self._workspace_state_dir():
            return []
        if not fp.is_file():
            return []
        try:
            data = json.loads(fp.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return []
        raw = data.get("tasks") if isinstance(data, dict) else data
        if not isinstance(raw, list):
            return []
        return [t for t in (self._clean_workflow_task(x) for x in raw) if t]

    def _save_workflow_tasks(self, tasks):
        fp = self._workflow_tasks_path()
        if fp.parent != self._workspace_state_dir():
            return self._err("forbidden", 403)
        payload = {
            "version": 1,
            "updatedAt": _now_iso(),
            "tasks": tasks,
        }
        try:
            fp.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(fp, json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
        except OSError:
            return self._err("保存失败", 500)
        return None

    def _clean_workflow_task(self, item):
        if not isinstance(item, dict):
            return None
        title = str(item.get("title") or "").strip()[:160]
        goal = str(item.get("goal") or "").strip()[:1200]
        if not title and not goal:
            return None
        tid = str(item.get("id") or "").strip()
        if not re.fullmatch(r"task-\d{8}-\d{6}-[a-f0-9]{4}", tid):
            tid = "task-" + time.strftime("%Y%m%d-%H%M%S", time.localtime()) + "-" + secrets.token_hex(2)
        status = str(item.get("status") or "todo").strip().lower()
        if status not in {"todo", "running", "verified", "blocked"}:
            status = "todo"
        now = _now_iso()
        return {
            "id": tid,
            "title": title or "未命名任务",
            "status": status,
            "goal": goal,
            "plan": self._text_list(item.get("plan"), item_limit=180, count_limit=24),
            "evidence": self._text_list(item.get("evidence"), item_limit=260, count_limit=30),
            "log": self._text_list(item.get("log"), item_limit=500, count_limit=80),
            "depends_on": [str(d) for d in item.get("depends_on", []) if isinstance(d, str)][:10],
            "complexity": str(item.get("complexity", ""))[:10] if item.get("complexity") else "",
            "next": str(item.get("next") or "").strip()[:500],
            "createdAt": str(item.get("createdAt") or now)[:32],
            "updatedAt": str(item.get("updatedAt") or now)[:32],
        }

    def _api_workflow_tasks(self):
        return self._json({"tasks": self._load_workflow_tasks()})

    def _api_workflow_tasks_save(self, body):
        raw = body.get("tasks")
        if not isinstance(raw, list):
            return self._err("tasks 必须是数组")
        if len(raw) > 80:
            return self._err("任务数量过多")
        now = _now_iso()
        existing = {t["id"]: t for t in self._load_workflow_tasks()}
        tasks = []
        for item in raw:
            if isinstance(item, dict):
                item = dict(item)
                item["updatedAt"] = now
            clean = self._clean_workflow_task(item)
            if clean:
                tasks.append(clean)
        task_map = {t["id"]: t for t in tasks}
        for t in tasks:
            old = existing.get(t["id"])
            old_status = old["status"] if old else "todo"
            if old_status == "todo" and t["status"] == "running" and t["depends_on"]:
                pending = [
                    d for d in t["depends_on"]
                    if d in task_map and task_map[d]["status"] != "verified"
                ]
                if pending:
                    names = ", ".join(
                        task_map[d].get("title", d) for d in pending
                    )
                    return self._err(f"前置任务未完成: {names}")
        err = self._save_workflow_tasks(tasks)
        if err:
            return err
        return self._json({"ok": True, "tasks": tasks})

    def _load_agent_sessions(self):
        fp = self._agent_sessions_path()
        if fp.parent != self._workspace_state_dir():
            return []
        if not fp.is_file():
            return []
        try:
            data = json.loads(fp.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return []
        raw = data.get("sessions") if isinstance(data, dict) else data
        if not isinstance(raw, list):
            return []
        return [s for s in (self._clean_agent_session(x) for x in raw) if s]

    def _save_agent_sessions(self, sessions):
        fp = self._agent_sessions_path()
        if fp.parent != self._workspace_state_dir():
            return self._err("forbidden", 403)
        payload = {
            "version": 1,
            "updatedAt": _now_iso(),
            "sessions": sessions,
        }
        try:
            fp.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(fp, json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
        except OSError:
            return self._err("保存失败", 500)
        return None

    def _clean_agent_session(self, item):
        if not isinstance(item, dict):
            return None
        sid = str(item.get("id") or "").strip()
        if not re.fullmatch(r"session-\d{8}-\d{6}-[a-f0-9]{4}", sid):
            sid = "session-" + time.strftime("%Y%m%d-%H%M%S", time.localtime()) + "-" + secrets.token_hex(2)
        title = str(item.get("title") or "").strip()[:180]
        task_id = str(item.get("taskId") or "").strip()[:80]
        task_title = str(item.get("taskTitle") or "").strip()[:180]
        now = _now_iso()
        if not title:
            title = task_title or "未命名会话"
        brief = str(item.get("brief") or "").strip()
        if len(brief.encode("utf-8")) > MAX_TEXT_BYTES:
            brief = brief[:MAX_TEXT_BYTES // 4]
        status = str(item.get("status") or "draft").strip().lower()
        if status not in {"draft", "running", "verified", "blocked", "archived"}:
            status = "draft"
        return {
            "id": sid,
            "title": title,
            "status": status,
            "taskId": task_id,
            "taskTitle": task_title,
            "brief": brief[:12000],
            "context": self._text_list(item.get("context"), item_limit=500, count_limit=60),
            "outputs": self._text_list(item.get("outputs"), item_limit=800, count_limit=80),
            "evidence": self._text_list(item.get("evidence"), item_limit=260, count_limit=80),
            "log": self._text_list(item.get("log"), item_limit=500, count_limit=120),
            "createdAt": str(item.get("createdAt") or now)[:32],
            "updatedAt": str(item.get("updatedAt") or now)[:32],
        }

    def _api_agent_sessions(self):
        return self._json({"sessions": self._load_agent_sessions()})

    def _api_agent_sessions_save(self, body):
        raw = body.get("sessions")
        if not isinstance(raw, list):
            return self._err("sessions 必须是数组")
        if len(raw) > 120:
            return self._err("会话数量过多")
        now = _now_iso()
        sessions = []
        for item in raw:
            if isinstance(item, dict):
                item = dict(item)
                item["updatedAt"] = now
            clean = self._clean_agent_session(item)
            if clean:
                sessions.append(clean)
        err = self._save_agent_sessions(sessions)
        if err:
            return err
        return self._json({"ok": True, "sessions": sessions})

    # ---------- 段 8: 生态 API ----------

    @staticmethod
    def _parse_frontmatter(text):
        meta = {}
        body = text
        if text.startswith("---\n"):
            end = text.find("\n---", 4)
            if end > 0:
                raw = text[4:end].strip().splitlines()
                body = text[end + 4:].lstrip("\r\n")
                current = None
                for line in raw:
                    if not line.strip():
                        continue
                    if line.startswith("  - ") and current:
                        meta.setdefault(current, []).append(line[4:].strip())
                        continue
                    if ":" in line:
                        key, value = line.split(":", 1)
                        current = key.strip()
                        value = value.strip().strip('"').strip("'")
                        meta[current] = value if value else []
        return meta, body

    @staticmethod
    def _fm_list(meta, key, limit=40):
        value = meta.get(key)
        if isinstance(value, list):
            return [str(x)[:500] for x in value[:limit] if str(x).strip()]
        if isinstance(value, str) and value.strip():
            return [value[:500]]
        return []

    @staticmethod
    def _fm_text(meta, key, limit=500):
        value = meta.get(key)
        if isinstance(value, str):
            return value[:limit]
        return ""

    @staticmethod
    def _md_title(body, fallback):
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("# "):
                return line[2:].strip()[:120] or fallback
        return fallback

    @staticmethod
    def _summary(body, limit=240):
        lines = []
        for line in body.splitlines():
            s = line.strip()
            if not s or s.startswith("#") or s.startswith("---"):
                continue
            lines.append(s)
            if len(" ".join(lines)) >= limit:
                break
        return " ".join(lines)[:limit]

    def _api_ecosystem(self):
        skills, playbooks = [], []
        max_bytes = 256 * 1024
        sources = []
        for root in current_workspace_roots():
            sources.append(("workspace", root, (root / ".workbench").resolve()))
        sources.append(("builtin", wb.state.BUNDLE_DIR, (wb.state.BUNDLE_DIR / ".workbench").resolve()))
        seen_bases = set()
        for source, root, base in sources:
            if str(base) in seen_bases:
                continue
            seen_bases.add(str(base))
            if not base.is_dir() or (base != root and root not in base.parents):
                continue
            pb_dir = base / "playbooks"
            if pb_dir.is_dir():
                for fp in sorted(pb_dir.glob("*.md"), key=lambda p: p.name.lower())[:80]:
                    try:
                        if fp.stat().st_size > max_bytes:
                            continue
                        text = fp.read_text(encoding="utf-8-sig")
                        meta, body = self._parse_frontmatter(text)
                        try:
                            rel_path = workspace_relpath(fp)
                        except ValueError:
                            rel_path = str(fp.relative_to(base)).replace("\\", "/")
                        playbooks.append({
                            "kind": "playbook",
                            "title": str(meta.get("title") or self._md_title(body, fp.stem))[:120],
                            "path": rel_path,
                            "source": source,
                            "risk": str(meta.get("risk") or "read")[:40],
                            "scope": self._fm_text(meta, "scope"),
                            "requires": self._fm_list(meta, "requires"),
                            "inputs": self._fm_list(meta, "inputs"),
                            "commands": self._fm_list(meta, "commands"),
                            "verification": self._fm_list(meta, "verification"),
                            "summary": self._summary(body),
                            "content": text[:20000],
                        })
                    except (OSError, UnicodeDecodeError, ValueError):
                        continue
            sk_dir = base / "skills"
            if sk_dir.is_dir():
                for fp in sorted(sk_dir.glob("**/SKILL.md"), key=lambda p: str(p).lower())[:80]:
                    try:
                        if fp.stat().st_size > max_bytes:
                            continue
                        text = fp.read_text(encoding="utf-8-sig")
                        meta, body = self._parse_frontmatter(text)
                        try:
                            rel_path = workspace_relpath(fp)
                        except ValueError:
                            rel_path = str(fp.relative_to(base)).replace("\\", "/")
                        skills.append({
                            "kind": "skill",
                            "title": str(meta.get("name") or meta.get("title") or fp.parent.name)[:120],
                            "path": rel_path,
                            "source": source,
                            "risk": str(meta.get("risk") or "read")[:40],
                            "scope": self._fm_text(meta, "scope"),
                            "requires": self._fm_list(meta, "requires"),
                            "inputs": self._fm_list(meta, "inputs"),
                            "commands": self._fm_list(meta, "commands"),
                            "verification": self._fm_list(meta, "verification"),
                            "description": str(meta.get("description") or self._summary(body))[:240],
                            "summary": self._summary(body),
                            "content": text[:20000],
                        })
                    except (OSError, UnicodeDecodeError, ValueError):
                        continue
        return self._json({
            "skills": skills,
            "playbooks": playbooks,
            "hasWorkspace": has_workspace(),
        })

    # ---------- 段 8b: Playbook 执行 ----------

    def _api_playbook_run(self, body):
        """执行 Playbook 中的命名步骤。"""
        path = str(body.get("path") or "").strip()
        step_name = str(body.get("step") or "").strip()
        if not path or not step_name:
            return self._err("缺少 path 或 step")
        try:
            target = safe_resolve(path)
        except (PermissionError, ValueError):
            target = None
        if not target or not target.is_file():
            candidate = (wb.state.BUNDLE_DIR / path).resolve()
            if candidate.is_file() and wb.state.BUNDLE_DIR in candidate.parents:
                target = candidate
            else:
                return self._err("Playbook 文件未找到")
        if "playbooks" not in target.parts:
            return self._err("仅允许执行 playbooks 目录下的文件")
        try:
            text = target.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            return self._err("读取 Playbook 失败")
        blocks = re.findall(
            r'```(?:bash|sh|shell|cmd|powershell)\s+name=(\S+)\s*\n(.*?)```',
            text, re.DOTALL
        )
        cmd = None
        for name, content in blocks:
            if name == step_name:
                cmd = content.strip()
                break
        if not cmd:
            return self._err(f"未找到步骤: {step_name}")
        from wb.run import run_shell
        cwd = current_workspace_roots()[0] if current_workspace_roots() else wb.state.ROOT or Path(".")
        code, stdout, stderr = run_shell(cmd, cwd, timeout=30)
        try:
            roots = current_workspace_roots()
            if roots:
                log_dir = roots[0] / "state"
                log_dir.mkdir(parents=True, exist_ok=True)
                log_file = log_dir / "PLAYBOOK-LOG.md"
                import datetime
                ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                status = "✓" if code == 0 else "✗"
                entry = f"| {ts} | {step_name} | {os.path.basename(path)} | {status} | exit {code} |\n"
                if not log_file.exists():
                    header = "# Playbook 执行日志\n\n| 时间 | 步骤 | 文件 | 状态 | 退出码 |\n|------|------|------|------|--------|\n"
                    log_file.write_text(header + entry, encoding="utf-8")
                else:
                    with open(log_file, "a", encoding="utf-8") as f:
                        f.write(entry)
        except OSError:
            pass
        return self._json({
            "ok": code == 0,
            "step": step_name,
            "code": code,
            "stdout": stdout[:8000],
            "stderr": stderr[:4000],
        })

    # ---------- 段 9: 工作区 API ----------

    def _resolve_workspace_root(self, raw, *, create=False):
        if not isinstance(raw, str) or not raw.strip():
            return None, self._err("缺少 path")
        try:
            p = Path(raw).resolve()
        except (OSError, ValueError):
            return None, self._err("路径非法")
        if create:
            try:
                p.mkdir(parents=True, exist_ok=True)
            except OSError:
                return None, self._err("创建目录失败", 500)
        try:
            rp = Path(os.path.realpath(str(p)))
        except OSError:
            return None, self._err("路径无法解析")
        if not rp.is_dir():
            return None, self._err("不是有效目录")
        return rp, None

    def _resolve_workspace_roots(self, body, *, create=False):
        if isinstance(body.get("roots"), list):
            raw_roots = body.get("roots")
        else:
            raw = body.get("path")
            raw_roots = [raw] if raw is not None else []
        roots = []
        seen = set()
        for raw in raw_roots:
            rp, err = self._resolve_workspace_root(raw, create=create)
            if err:
                return None, err
            key = str(rp)
            if key in seen:
                continue
            seen.add(key)
            roots.append(rp)
        if not roots:
            return None, self._err("至少需要一个目录")
        return roots, None

    def _activate_workspace(self, roots: list[Path]) -> dict:
        set_workspace_roots(roots)
        with wb.state._CFG_LOCK:
            cfg = load_config()
            _touch_recent_workspace(cfg, current_workspace_roots())
            save_config(cfg)
        return cfg

    def _api_set_root(self, body):
        roots, err = self._resolve_workspace_roots(body, create=False)
        if err:
            return err
        cfg = self._activate_workspace(roots)
        cur = cfg.get("currentWorkspace") or {}
        return self._json({
            "ok": True,
            "root": str(wb.state.ROOT),
            "workspace": cur,
            "workspaceRoots": cur.get("roots", []),
            "workspaceId": cur.get("id"),
            "recent": cfg.get("recentWorkspaces", cfg.get("recent", [])),
        })

    def _api_create_workspace(self, body):
        roots, err = self._resolve_workspace_roots(body, create=True)
        if err:
            return err
        cfg = self._activate_workspace(roots)
        cur = cfg.get("currentWorkspace") or {}
        return self._json({
            "ok": True,
            "root": str(wb.state.ROOT),
            "workspace": cur,
            "workspaceRoots": cur.get("roots", []),
            "workspaceId": cur.get("id"),
            "recent": cfg.get("recentWorkspaces", cfg.get("recent", [])),
        })

    def _api_recent_remove(self, body):
        raw = body.get("id") or body.get("path")
        if not isinstance(raw, str):
            return self._err("缺少 id/path")
        with wb.state._CFG_LOCK:
            cfg = load_config()
            cfg["recentWorkspaces"] = [
                r for r in cfg.get("recentWorkspaces", [])
                if r.get("id") != raw and r.get("path") != raw
            ]
            cfg["recent"] = [
                r for r in cfg.get("recent", [])
                if r.get("path") != raw
            ]
            cur = cfg.get("currentWorkspace") if isinstance(cfg.get("currentWorkspace"), dict) else None
            if cur and (cur.get("id") == raw or cur.get("path") == raw):
                cfg["currentWorkspace"] = None
                cfg["lastRoot"] = None
            save_config(cfg)
        return self._json({"ok": True, "recent": cfg.get("recentWorkspaces", cfg.get("recent", []))})
