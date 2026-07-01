"""Loom 全局配置管理。"""
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import wb.state
from wb.paths import atomic_write_bytes


def _config_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return Path(base) / "Loom"
    return Path.home() / ".workbench"


def _config_path() -> Path:
    return _config_dir() / "config.json"


def _notes_global_path() -> Path:
    return _config_dir() / "notes.json"


def load_config() -> dict:
    empty = {"lastRoot": None, "recent": [], "currentWorkspace": None, "recentWorkspaces": []}
    fp = _config_path()
    if not fp.is_file():
        return empty
    try:
        data = json.loads(fp.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict):
            return empty
        if not isinstance(data.get("recent"), list):
            data["recent"] = []
        if not isinstance(data.get("lastRoot"), str):
            data["lastRoot"] = None
        if data.get("currentWorkspace") is not None and not isinstance(data.get("currentWorkspace"), dict):
            data["currentWorkspace"] = None
        if not isinstance(data.get("recentWorkspaces"), list):
            data["recentWorkspaces"] = []
        _upgrade_workspace_config(data)
        return data
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return empty


def save_config(cfg: dict):
    fp = _config_path()
    try:
        fp.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(fp, json.dumps(cfg, ensure_ascii=False, indent=2).encode("utf-8"))
    except OSError:
        pass


def set_workspace_roots(roots: list[Path]):
    uniq = []
    seen = set()
    for root in roots or []:
        if root is None:
            continue
        try:
            rp = Path(root).resolve()
        except (OSError, ValueError):
            continue
        if not rp.is_dir():
            continue
        key = str(rp)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(rp)
    with wb.state._CFG_LOCK:
        wb.state.WORKSPACE_ROOTS = uniq
        wb.state.ROOT = uniq[0] if uniq else None


def _touch_recent(cfg: dict, root: Path):
    root_str = str(root)
    cfg["lastRoot"] = root_str
    name = root.name or root_str
    cfg["recent"] = [r for r in cfg.get("recent", []) if r.get("path") != root_str]
    cfg["recent"].insert(0, {"path": root_str, "name": name, "lastUsed": _now_iso()})
    cfg["recent"] = cfg["recent"][:10]


def _norm_root_str(raw) -> str | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        p = Path(raw).resolve()
    except (OSError, ValueError):
        return None
    if not p.is_dir():
        return None
    return str(p)


def _workspace_label(roots: list[str]) -> str:
    if not roots:
        return "空工作区"
    first = Path(roots[0]).name or roots[0]
    return first if len(roots) == 1 else f"{first} +{len(roots) - 1}"


def _workspace_id(roots: list[str]) -> str | None:
    roots = [r for r in roots if isinstance(r, str) and r]
    if not roots:
        return None
    joined = "\n".join(roots).encode("utf-8")
    return "ws:" + hashlib.sha1(joined).hexdigest()[:16]


def _workspace_payload(roots: list[str], *, last_used=None) -> dict | None:
    roots = [r for r in roots if isinstance(r, str) and r]
    if not roots:
        return None
    return {
        "id": _workspace_id(roots),
        "name": _workspace_label(roots),
        "path": roots[0],
        "roots": roots,
        "lastUsed": last_used or _now_iso(),
    }


def _upgrade_workspace_config(cfg: dict):
    cur = cfg.get("currentWorkspace")
    if isinstance(cur, dict):
        roots = [_norm_root_str(r) for r in cur.get("roots", [])]
        roots = [r for r in roots if r]
        cfg["currentWorkspace"] = _workspace_payload(roots, last_used=cur.get("lastUsed")) if roots else None
    else:
        last = _norm_root_str(cfg.get("lastRoot"))
        cfg["currentWorkspace"] = _workspace_payload([last], last_used=_now_iso()) if last else None

    upgraded = []
    seen = set()
    src = cfg.get("recentWorkspaces") if cfg.get("recentWorkspaces") else cfg.get("recent", [])
    for item in src:
        if isinstance(item, dict) and isinstance(item.get("roots"), list):
            roots = [_norm_root_str(r) for r in item.get("roots", [])]
            roots = [r for r in roots if r]
            payload = _workspace_payload(roots, last_used=item.get("lastUsed"))
        else:
            path = _norm_root_str(item.get("path") if isinstance(item, dict) else item)
            payload = _workspace_payload([path], last_used=(item.get("lastUsed") if isinstance(item, dict) else None)) if path else None
        if not payload or payload["id"] in seen:
            continue
        seen.add(payload["id"])
        upgraded.append(payload)
    cfg["recentWorkspaces"] = upgraded[:10]


def _touch_recent_workspace(cfg: dict, roots: list[Path]):
    root_strs = [str(r) for r in roots]
    payload = _workspace_payload(root_strs)
    if not payload:
        cfg["currentWorkspace"] = None
        cfg["lastRoot"] = None
        return
    cfg["currentWorkspace"] = payload
    cfg["lastRoot"] = root_strs[0]
    cfg["recent"] = [{"path": root_strs[0], "name": payload["name"], "lastUsed": payload["lastUsed"]}]
    recent = [w for w in cfg.get("recentWorkspaces", []) if w.get("id") != payload["id"]]
    recent.insert(0, payload)
    cfg["recentWorkspaces"] = recent[:10]


def _annotate_recent_workspaces(items: list) -> list:
    annotated = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            annotated.append(item)
            continue
        entry = dict(item)
        roots = entry.get("roots")
        valid_roots = [root for root in roots if isinstance(root, str) and root] if isinstance(roots, list) else []
        if valid_roots:
            entry["exists"] = all(Path(root).is_dir() for root in valid_roots)
        else:
            path = entry.get("path")
            entry["exists"] = Path(str(path)).is_dir() if isinstance(path, str) and path else False
        annotated.append(entry)
    return annotated


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
