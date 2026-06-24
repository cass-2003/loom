/* Workbench 源代码管理 (Git) 视图 */
const gjson = (url, opts) => fetch(url, opts).then(r => r.json());
const gpost = (url, obj) => gjson(url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

function gitCurPath() { return (window.state && window.state.current) || ""; }

function flagClass(code) {
  if (code.includes("?")) return "g-new";
  if (code.includes("D")) return "g-del";
  if (code.includes("A")) return "g-add";
  return "g-mod";
}

async function refreshGit() {
  const branchEl = document.querySelector("#git-branch");
  const filesEl = document.querySelector("#git-files");
  const headEl = document.querySelector("#git-changes-head");
  const badge = document.querySelector("#git-badge");
  const stBranch = document.querySelector("#status-branch");

  const d = await gjson(`/api/git/status?path=${encodeURIComponent(gitCurPath())}`);

  if (d.repo === null || d.repo === undefined) {
    branchEl.textContent = d.message || "不在 git 仓库内";
    headEl.textContent = "";
    filesEl.innerHTML = `<div class="tool-row"><button class="btn" id="git-init">git init 当前目录</button></div>`;
    badge.classList.add("hidden");
    stBranch.textContent = "";
    document.querySelector("#git-log").innerHTML = "";
    document.querySelector("#git-log-head").style.display = "none";
    const ib = document.querySelector("#git-init");
    if (ib) ib.onclick = async () => {
      const r = await gpost("/api/git/init", { path: gitCurPath() });
      setGitOut(r.output || ""); refreshGit();
    };
    return;
  }

  let tail = d.branch || "(无分支)";
  if (d.ahead) tail += `  ↑${d.ahead}`;
  if (d.behind) tail += `  ↓${d.behind}`;
  branchEl.innerHTML = svgIcon("branch", 14) + `<span>${tail}</span>`;
  stBranch.innerHTML = svgIcon("branch", 12) + `<span>${tail}</span>`;
  refreshLog();  // 提交历史(树)始终显示，即便工作区干净

  const n = d.files.length;
  if (n) { badge.textContent = n; badge.classList.remove("hidden"); }
  else badge.classList.add("hidden");

  headEl.textContent = n ? `更改 (${n})` : "";
  if (!n) {
    filesEl.innerHTML = `<p class="muted" style="padding:6px 0">✓ 工作区干净</p>`;
    return;
  }
  filesEl.innerHTML = "";
  for (const f of d.files) {
    const code = (f.status || "").trim() || "??";
    const row = document.createElement("div");
    row.className = "git-file";
    row.innerHTML = `<span class="g-flag ${flagClass(code)}">${code[0] === " " ? code[1] : code[0]}</span>
      <span class="g-path" title="${f.repoPath}">${f.repoPath}</span>`;
    row.onclick = async () => {
      document.querySelectorAll(".git-file.active").forEach(e => e.classList.remove("active"));
      row.classList.add("active");
      if (!f.path) return;
      const dd = await gjson(`/api/git/diff?path=${encodeURIComponent(f.path)}`);
      window.showDiffView(f.repoPath, dd.diff || "(无文本差异 / 二进制文件)");
    };
    filesEl.appendChild(row);
  }
}

// 提交历史 (commit 树)
async function refreshLog() {
  const logEl = document.querySelector("#git-log");
  const head = document.querySelector("#git-log-head");
  if (!logEl) return;
  const d = await gjson(`/api/git/log?path=${encodeURIComponent(gitCurPath())}`);
  const commits = d.commits || [];
  if (!commits.length) { head.style.display = "none"; logEl.innerHTML = ""; return; }
  head.style.display = "";
  logEl.innerHTML = "";
  commits.forEach((c, i) => {
    const item = document.createElement("div");
    item.className = "git-log-item";
    const last = i === commits.length - 1;
    item.innerHTML = `
      <div class="log-graph"><span class="dot${i === 0 ? " head" : ""}"></span>${last ? "" : '<span class="line"></span>'}</div>
      <div class="log-main">
        <div class="log-subject" title="${c.subject.replace(/"/g, "&quot;")}">${c.subject}</div>
        <div class="log-meta"><span class="log-hash">${c.hash}</span> · ${c.author} · ${c.when}</div>
      </div>`;
    logEl.appendChild(item);
  });
}

let gitOutTimer = null;
function setGitOut(text, ok) {
  const el = document.querySelector("#git-out");
  el.textContent = text;
  el.style.color = ok === undefined ? "" : (ok ? "var(--accent2)" : "var(--danger)");
  clearTimeout(gitOutTimer);
  if (text) gitOutTimer = setTimeout(() => { el.textContent = ""; }, 6000);
}

function initGit() {
  document.querySelector("#git-refresh").onclick = refreshGit;
  const msg = document.querySelector("#git-msg");

  document.querySelector("#git-commit").onclick = async () => {
    const m = msg.value.trim();
    if (!m) { setGitOut("请填写提交信息", false); return; }
    setGitOut("提交中…");
    const r = await gpost("/api/git/commit", { path: gitCurPath(), message: m });
    setGitOut(r.output || r.error || "", r.ok);
    if (r.ok) msg.value = "";
    refreshGit();
  };
  document.querySelector("#git-push").onclick = async () => {
    setGitOut("推送中…");
    const r = await gpost("/api/git/push", { path: gitCurPath() });
    setGitOut(r.output || "", r.ok);
  };
  msg.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault(); document.querySelector("#git-commit").click();
    }
  });
}
