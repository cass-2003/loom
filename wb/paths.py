"""路径安全与工作区路径解析。"""
import os
import re
from pathlib import Path
from urllib.parse import unquote

import wb.state


def current_workspace_roots() -> list[Path]:
    with wb.state._CFG_LOCK:
        if wb.state.WORKSPACE_ROOTS:
            return wb.state.WORKSPACE_ROOTS[:]
        return [wb.state.ROOT] if wb.state.ROOT is not None else []


def has_workspace() -> bool:
    return len(current_workspace_roots()) > 0


def _split_workspace_path(rel: str) -> tuple[int, str]:
    rel = unquote(rel or "").lstrip("/\\")
    m = re.match(r"^@(\d+)(?:/(.*))?$", rel)
    if not m:
        return 0, rel
    return int(m.group(1)), (m.group(2) or "")


def _workspace_root_for_path(p: Path) -> tuple[int, Path] | tuple[None, None]:
    try:
        rp = p.resolve()
    except (OSError, ValueError):
        return None, None
    best = None
    for idx, root in enumerate(current_workspace_roots()):
        if rp == root or root in rp.parents:
            score = len(str(root))
            if best is None or score > best[0]:
                best = (score, idx, root)
    if best is None:
        return None, None
    return best[1], best[2]


def workspace_relpath(p: Path) -> str:
    idx, root = _workspace_root_for_path(p)
    if root is None:
        raise ValueError("path outside workspace")
    rel = str(p.resolve().relative_to(root)).replace("\\", "/")
    if idx == 0:
        return rel
    return f"@{idx}" + (f"/{rel}" if rel else "")


def resolve_workspace_detail(rel: str) -> tuple[Path, Path, int, str]:
    """把工作区路径解析为 (根目录, 绝对路径, 根索引, 根内相对路径)。"""
    roots = current_workspace_roots()
    if not roots:
        raise PermissionError("no workspace")
    idx, inner = _split_workspace_path(rel)
    if idx < 0 or idx >= len(roots):
        raise PermissionError("invalid workspace root")
    root = roots[idx]
    target = (root / inner).resolve()
    if target != root and root not in target.parents:
        raise PermissionError("path escapes root")
    return root, target, idx, inner


def safe_resolve(rel: str) -> Path:
    _, target, _, _ = resolve_workspace_detail(rel)
    return target


def resolve_cwd(rel: str) -> Path:
    """把可选 cwd 解析到 ROOT 内的目录。"""
    rel = (rel or "").strip()
    if not rel:
        return wb.state.ROOT
    d = safe_resolve(rel)
    if not d.is_dir():
        d = d.parent
    return d


def within_root_real(p) -> bool:
    """p 的真实路径是否仍在任一工作区根内。"""
    try:
        rp = os.path.realpath(str(p))
        for root in current_workspace_roots():
            rr = os.path.realpath(str(root))
            if rp == rr or rp.startswith(rr + os.sep):
                return True
        return False
    except OSError:
        return False


def atomic_write_bytes(fp: Path, data: bytes):
    """原子写：写临时文件再 os.replace。"""
    import tempfile
    fp.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(fp.parent), prefix=".wb-tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, str(fp))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def find_repo(start: Path):
    """从 start 向上找包含 .git 的目录；找不到则向下扫描子目录（深度 2）。"""
    d = start if start.is_dir() else start.parent
    _, base_root = _workspace_root_for_path(d)
    if base_root is None:
        return None
    for c in [d, *d.parents]:
        within = c == base_root or base_root in c.parents
        if within and (c / ".git").exists():
            return c
        if c == base_root:
            break
    return _scan_repos_down(base_root, max_depth=2, limit=1)[0] if base_root else None


def _scan_repos_down(root: Path, max_depth: int = 2, limit: int = 20):
    """向下扫描子目录中的 git 仓库（BFS，限深度和数量）。"""
    repos = []
    try:
        queue = [(root, 0)]
        while queue and len(repos) < limit:
            cur, depth = queue.pop(0)
            if depth > max_depth:
                continue
            try:
                for child in sorted(cur.iterdir()):
                    if not child.is_dir() or child.name.startswith("."):
                        continue
                    if (child / ".git").exists():
                        repos.append(child)
                        if len(repos) >= limit:
                            break
                    elif depth + 1 <= max_depth:
                        queue.append((child, depth + 1))
            except (PermissionError, OSError):
                continue
    except (PermissionError, OSError):
        pass
    return repos
