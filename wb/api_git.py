"""Git API Mixin."""
import os
import re
from pathlib import Path

import wb.state
from wb.git_utils import run_git
from wb.paths import safe_resolve, find_repo, workspace_relpath, _scan_repos_down


class GitMixin:
    """Handler mixin: 所有 _api_git_* 方法。

    self._json() / self._err() / self._read_json_body() 由 Handler 基类提供。
    """

    def _resolve_repo(self, rel):
        """返回 (repo_path, error_response_called)。找不到仓库时已发送响应。"""
        try:
            target = safe_resolve(rel)
        except PermissionError:
            self._json({"repo": None, "branch": None, "files": [],
                        "message": "当前目录不在 git 仓库内"})
            return None
        if not target.exists():
            target = wb.state.ROOT
        repo = find_repo(target)
        if repo is None:
            self._json({"repo": None, "branch": None, "files": [],
                        "message": "当前目录不在 git 仓库内"})
            return None
        return repo

    def _api_git_repos(self):
        """GET /api/git/repos — 扫描工作区中的所有 git 仓库。"""
        from wb.paths import current_workspace_roots
        repos = []
        for root in current_workspace_roots():
            if (root / ".git").exists():
                try:
                    rel = workspace_relpath(root)
                except ValueError:
                    rel = str(root)
                repos.append({"path": rel, "abs": str(root), "isRoot": True})
            else:
                for r in _scan_repos_down(root, max_depth=2, limit=20):
                    try:
                        rel = workspace_relpath(r)
                    except ValueError:
                        rel = str(r)
                    repos.append({"path": rel, "abs": str(r), "isRoot": False})
        return self._json({"repos": repos})

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
                root_rel = workspace_relpath((repo / fname).resolve())
            except ValueError:
                root_rel = None
            return {"status": status, "repoPath": fname, "path": root_rel}

        for line in out.splitlines():
            if line.startswith("## "):
                head = line[3:]
                unborn = re.match(r"No commits yet on (.+)", head)
                if unborn:
                    branch = unborn.group(1).strip()
                else:
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
        try:
            repo_rel = workspace_relpath(repo)
        except ValueError:
            repo_rel = ""
        head_code, _, _ = run_git(["rev-parse", "--verify", "HEAD"], repo)
        # 唯一文件数（一个文件可能同时在两组）作为徽标计数
        changed = len({e["repoPath"] for e in staged + unstaged})
        return self._json({"repo": repo_rel, "branch": branch,
                           "hasHead": head_code == 0,
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
        code, out, _ = run_git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo)
        if code == 0:
            cur = out.strip()
        head_code, _, _ = run_git(["rev-parse", "--verify", "HEAD"], repo)
        branches = []
        code, out, _ = run_git(["branch", "--format=%(refname:short)"], repo)
        if code == 0:
            branches = [b.strip() for b in out.splitlines() if b.strip()]
        return self._json({"current": cur, "branches": branches, "hasHead": head_code == 0})

    def _api_git_log(self, rel, ref=""):
        repo = self._resolve_repo(rel)
        if repo is None:
            return
        args = ["log", "--topo-order", "-100", "--pretty=format:%h\x1f%an\x1f%ar\x1f%s\x1f%D\x1f%p"]
        if ref == "__all__":
            args.append("--all")
        elif ref and self._valid_ref(ref):
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
            target = wb.state.ROOT
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
            try:
                if fp.is_dir():
                    import shutil
                    shutil.rmtree(fp)
                    return self._json({"ok": True, "output": "已删除未跟踪目录"})
                if fp.is_file():
                    fp.unlink()
                    return self._json({"ok": True, "output": "已删除未跟踪文件"})
                return self._err("目标不存在", 404)
            except OSError:
                return self._err("删除失败", 500)
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

    def _api_git_file_log(self, rel):
        """某文件的提交历史（沿重命名追踪）。"""
        info = self._repo_and_relpath(rel)
        if info is None:
            return
        repo, repo_rel, _ = info
        code, out, err = run_git(
            ["log", "-100", "--follow",
             "--pretty=format:%h\x1f%an\x1f%ar\x1f%ad\x1f%s",
             "--date=format:%Y-%m-%d %H:%M", "--", repo_rel], repo)
        if code != 0:
            return self._err(err.strip() or "读取文件历史失败", 500)
        commits = []
        for line in out.splitlines():
            parts = line.split("\x1f")
            if len(parts) >= 5:
                commits.append({"hash": parts[0], "author": parts[1],
                                "when": parts[2], "date": parts[3],
                                "subject": parts[4]})
        return self._json({"path": repo_rel, "commits": commits})

    def _api_git_blame(self, rel):
        """git blame --porcelain 解析，逐行返回 作者 / 短hash / 内容。"""
        info = self._repo_and_relpath(rel)
        if info is None:
            return
        repo, repo_rel, fp = info
        if not fp.is_file():
            return self._err("不是文件", 404)
        code, out, err = run_git(
            ["blame", "--porcelain", "--", repo_rel], repo)
        if code != 0:
            return self._err(err.strip() or "blame 失败", 500)
        lines = []
        commit_meta = {}   # hash -> {author, summary}
        cur_hash = None
        cur_author = ""
        cur_summary = ""
        it = iter(out.split("\n"))
        for raw in it:
            if not raw:
                continue
            m = re.match(r"^([0-9a-f]{40})\s+\d+\s+\d+", raw)
            if m:
                cur_hash = m.group(1)
                meta = commit_meta.get(cur_hash, {})
                cur_author = meta.get("author", "")
                cur_summary = meta.get("summary", "")
                continue
            if raw.startswith("author "):
                cur_author = raw[len("author "):]
                commit_meta.setdefault(cur_hash, {})["author"] = cur_author
                continue
            if raw.startswith("summary "):
                cur_summary = raw[len("summary "):]
                commit_meta.setdefault(cur_hash, {})["summary"] = cur_summary
                continue
            if raw.startswith("\t"):
                lines.append({
                    "hash": (cur_hash or "")[:8],
                    "author": cur_author,
                    "summary": cur_summary,
                    "text": raw[1:],
                })
        return self._json({"path": repo_rel, "lines": lines})

    @staticmethod
    def _valid_ref(name):
        """合法的分支/引用名（保守白名单）。"""
        name = (name or "").strip()
        if not name or len(name) > 200:
            return False
        if name.startswith("-") or name.startswith("/") or name.endswith("/"):
            return False
        if ".." in name or name.endswith(".lock"):
            return False
        return bool(re.fullmatch(r"[\w./-]+", name))

    def _api_git_checkout(self, body):
        ref = (body.get("ref") or "").strip()
        if not self._valid_ref(ref):
            return self._err("非法分支/引用名")
        repo = self._resolve_repo(body.get("path", ""))
        if repo is None:
            return
        code, out, err = run_git(["checkout", ref], repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _api_git_branch_create(self, body):
        name = (body.get("name") or "").strip()
        if not self._valid_ref(name):
            return self._err("非法分支名")
        repo = self._resolve_repo(body.get("path", ""))
        if repo is None:
            return
        start = (body.get("from") or "").strip()
        args = ["checkout", "-b", name]
        if start and self._valid_ref(start):
            args.append(start)
        code, out, err = run_git(args, repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _api_git_branch_delete(self, body):
        name = (body.get("name") or "").strip()
        if not self._valid_ref(name):
            return self._err("非法分支名")
        repo = self._resolve_repo(body.get("path", ""))
        if repo is None:
            return
        flag = "-D" if body.get("force") else "-d"
        code, out, err = run_git(["branch", flag, name], repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _api_git_stash_list(self, rel):
        repo = self._resolve_repo(rel)
        if repo is None:
            return
        code, out, err = run_git(
            ["stash", "list", "--pretty=format:%gd\x1f%s\x1f%cr"], repo)
        if code != 0:
            return self._err(err.strip() or "stash list 失败", 500)
        stashes = []
        for line in out.splitlines():
            parts = line.split("\x1f")
            if len(parts) >= 2:
                stashes.append({"ref": parts[0], "subject": parts[1],
                                "when": parts[2] if len(parts) > 2 else ""})
        return self._json({"stashes": stashes})

    def _api_git_stash_save(self, body):
        repo = self._resolve_repo(body.get("path", ""))
        if repo is None:
            return
        msg = (body.get("message") or "").strip()
        args = ["stash", "push", "-u"]
        if msg:
            args += ["-m", msg]
        code, out, err = run_git(args, repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})

    def _api_git_stash_pop(self, body):
        repo = self._resolve_repo(body.get("path", ""))
        if repo is None:
            return
        ref = (body.get("ref") or "").strip()
        args = ["stash", "pop"]
        if ref:
            if not re.fullmatch(r"stash@\{\d+\}", ref):
                return self._err("非法 stash 引用")
            args.append(ref)
        code, out, err = run_git(args, repo)
        return self._json({"ok": code == 0, "output": (out + err).strip()})
