/* Workbench 源代码管理 (Git) —— 仿 VS Code 面板 */
const gjson = (url, opts) => fetch(url, opts).then(r => r.json());
const gpost = (url, obj) => gjson(url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

function gitCurPath() { return (window.state && window.state.current) || ""; }

const G_CODE_EXTS = new Set(["json","js","ts","jsx","tsx","py","go","rs","java",
  "c","cpp","h","css","scss","html","htm","xml","yaml","yml","toml","sh",
  "bash","ps1","bat","sql","vue","svelte"]);
function gitIconFor(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "md" || ext === "markdown") return ["markdown", "ic-md"];
  if (["png","jpg","jpeg","gif","webp","svg","bmp","ico"].includes(ext)) return ["image", "ic-img"];
  if (G_CODE_EXTS.has(ext)) return ["fileCode", "ic-code"];
  return ["fileText", "ic-text"];
}
function statusLetter(code) {
  code = (code || "").trim();
  if (code.includes("?")) return ["U", "g-new"];
  if (code.includes("D")) return ["D", "g-del"];
  if (code.includes("A")) return ["A", "g-add"];
  if (code.includes("R")) return ["R", "g-mod"];
  return ["M", "g-mod"];
}

async function refreshGit() {
  const branchEl = document.querySelector("#git-branch");
  const filesEl = document.querySelector("#git-files");
  const countEl = document.querySelector("#git-changes-count");
  const commitLabel = document.querySelector("#git-commit-label");
  const badge = document.querySelector("#git-badge");
  const stBranch = document.querySelector("#status-branch");

  const d = await gjson(`/api/git/status?path=${encodeURIComponent(gitCurPath())}`);

  if (d.repo === null || d.repo === undefined) {
    branchEl.textContent = "";
    countEl.classList.add("hidden");
    commitLabel.textContent = "提交";
    filesEl.innerHTML = `<div class="scm-empty">不在 Git 仓库内<button class="btn ghost" id="git-init" style="margin-top:10px">初始化仓库</button></div>`;
    badge.classList.add("hidden");
    stBranch.textContent = "";
    document.querySelector("#git-log").innerHTML = "";
    const ib = document.querySelector("#git-init");
    if (ib) ib.onclick = async () => {
      const r = await gpost("/api/git/init", { path: gitCurPath() });
      setGitOut(r.output || "", r.ok); refreshGit();
    };
    return;
  }

  const branch = d.branch || "(无分支)";
  let chip = escapeHtml(branch);
  if (d.ahead) chip += ` ↑${d.ahead}`;
  if (d.behind) chip += ` ↓${d.behind}`;
  branchEl.innerHTML = svgIcon("branch", 12) + `<span>${chip}</span>`;
  stBranch.innerHTML = svgIcon("branch", 12) + `<span>${chip}</span>`;
  commitLabel.textContent = `提交到 ${branch}`;
  refreshLog();

  const n = d.files.length;
  if (n) { badge.textContent = n; badge.classList.remove("hidden");
    countEl.textContent = n; countEl.classList.remove("hidden"); }
  else { badge.classList.add("hidden"); countEl.classList.add("hidden"); }

  if (!n) {
    filesEl.innerHTML = `<div class="scm-empty">✓ 没有更改</div>`;
    return;
  }
  filesEl.innerHTML = "";
  for (const f of d.files) {
    const repoPath = f.repoPath;
    const slash = repoPath.lastIndexOf("/");
    const name = slash >= 0 ? repoPath.slice(slash + 1) : repoPath;
    const dir = slash >= 0 ? repoPath.slice(0, slash) : "";
    const [iconName, iconCls] = gitIconFor(name);
    const [letter, letterCls] = statusLetter(f.status);

    const row = document.createElement("div");
    row.className = "scm-file";
    row.title = repoPath;
    row.innerHTML = `
      <span class="scm-file-ico ${iconCls}">${svgIcon(iconName, 15)}</span>
      <span class="scm-file-name">${escapeHtml(name)}</span>
      <span class="scm-file-dir">${escapeHtml(dir)}</span>
      <span class="scm-file-actions">
        <button class="scm-act" title="在编辑器打开">${svgIcon("file", 14)}</button>
      </span>
      <span class="scm-file-status ${letterCls}">${letter}</span>`;

    row.querySelector(".scm-act").onclick = (e) => {
      e.stopPropagation();
      if (f.path && window.openFile) window.openFile(f.path);
    };
    row.onclick = async () => {
      document.querySelectorAll(".scm-file.active").forEach(e => e.classList.remove("active"));
      row.classList.add("active");
      if (!f.path) return;
      const dd = await gjson(`/api/git/diff?path=${encodeURIComponent(f.path)}`);
      window.showDiffView(repoPath, dd.diff || "(无文本差异 / 二进制文件)");
    };
    filesEl.appendChild(row);
  }
}

// 作者头像配色（名字哈希 → 稳定色相）
function authorColor(name) {
  let h = 0;
  for (const ch of (name || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 48% 46%)`;
}
function authorInitial(name) {
  const t = (name || "").trim();
  return t ? t[0].toUpperCase() : "?";
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
window.escapeHtml = escapeHtml;

// 提交历史（Git Graph）
async function refreshLog() {
  const logEl = document.querySelector("#git-log");
  if (!logEl) return;
  const d = await gjson(`/api/git/log?path=${encodeURIComponent(gitCurPath())}`);
  const commits = d.commits || [];
  if (!commits.length) { logEl.innerHTML = ""; return; }
  logEl.innerHTML = "";
  commits.forEach((c, i) => {
    const first = i === 0, last = i === commits.length - 1;
    const isHead = i === 0 || (c.refs || []).some(r => r.kind === "head");
    const refsHTML = (c.refs || []).map(r =>
      `<span class="glog-ref ${r.kind}">${r.kind === "tag" ? svgIcon("file", 10) : svgIcon("branch", 10)}<span>${escapeHtml(r.name)}</span></span>`
    ).join("");
    const row = document.createElement("div");
    row.className = "glog-row";
    row.dataset.hash = c.hash;
    row.innerHTML = `
      <div class="glog-lane">
        ${first ? "" : '<span class="glog-line top"></span>'}
        ${last ? "" : '<span class="glog-line bot"></span>'}
        <span class="glog-node${isHead ? " head" : ""}"></span>
      </div>
      <div class="glog-body">
        <div class="glog-top">
          <span class="glog-msg">${escapeHtml(c.subject)}</span>
          ${refsHTML}
        </div>
        <div class="glog-meta"><span class="glog-author">${escapeHtml(c.author)}</span><span class="glog-dot">·</span><span class="glog-hash">${c.hash}</span><span class="glog-dot">·</span>${escapeHtml(c.when)}</div>
      </div>`;
    attachCommitHover(row);
    logEl.appendChild(row);
  });
}

/* ===== 提交悬浮详情卡 ===== */
const commitCache = {};
let popEl = null, popShowTimer = null, popHideTimer = null;

function ensurePopover() {
  if (popEl) return popEl;
  popEl = document.createElement("div");
  popEl.id = "commit-popover";
  popEl.className = "commit-popover hidden";
  popEl.addEventListener("mouseenter", () => clearTimeout(popHideTimer));
  popEl.addEventListener("mouseleave", hidePopover);
  document.body.appendChild(popEl);
  return popEl;
}

function hidePopover() {
  clearTimeout(popShowTimer);
  popHideTimer = setTimeout(() => { if (popEl) popEl.classList.add("hidden"); }, 140);
}

function buildPopoverHTML(d) {
  const refs = (d.refs || []).map(r =>
    `<span class="cp-ref">${svgIcon("branch", 11)}<span>${escapeHtml(r)}</span></span>`).join("");
  return `
    <div class="cp-line1">
      <span class="cp-author">${escapeHtml(d.author)}</span>
      <span class="cp-when">${escapeHtml(d.when)}</span>
      <span class="cp-date">${escapeHtml(d.date)}</span>
    </div>
    <div class="cp-subject">${escapeHtml(d.subject)}</div>
    <div class="cp-stats">
      <span>${d.files} 个文件改动</span>
      ${d.insertions ? `<span class="cp-add">+${d.insertions}</span>` : ""}
      ${d.deletions ? `<span class="cp-del">−${d.deletions}</span>` : ""}
    </div>
    ${refs ? `<div class="cp-refs">${refs}</div>` : ""}
    <div class="cp-hash">${svgIcon("git", 11)}<span>${escapeHtml(d.hash)}</span></div>`;
}

function positionPopover(row) {
  const rect = row.getBoundingClientRect();
  const pop = popEl;
  pop.style.visibility = "hidden";
  pop.classList.remove("hidden");
  const ph = pop.offsetHeight, pw = pop.offsetWidth;
  let left = rect.right + 10;
  if (left + pw > window.innerWidth - 8) left = rect.left - pw - 10;
  if (left < 8) left = 8;
  let top = rect.top - 6;
  if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
  if (top < 8) top = 8;
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  pop.style.visibility = "";
}

function attachCommitHover(row) {
  row.addEventListener("mouseenter", () => {
    clearTimeout(popHideTimer);
    clearTimeout(popShowTimer);
    const h = row.dataset.hash;
    popShowTimer = setTimeout(async () => {
      ensurePopover();
      let d = commitCache[h];
      if (!d) {
        d = await gjson(`/api/git/show?path=${encodeURIComponent(gitCurPath())}&hash=${h}`);
        if (d.error) return;
        commitCache[h] = d;
      }
      popEl.innerHTML = buildPopoverHTML(d);
      positionPopover(row);
    }, 320);
  });
  row.addEventListener("mouseleave", hidePopover);
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

  // 文本框自动增高
  const autosize = () => { msg.style.height = "auto"; msg.style.height = Math.min(msg.scrollHeight, 160) + "px"; };
  msg.addEventListener("input", autosize);

  document.querySelector("#git-commit").onclick = async () => {
    const m = msg.value.trim();
    if (!m) { setGitOut("请填写提交信息", false); msg.focus(); return; }
    setGitOut("提交中…");
    const r = await gpost("/api/git/commit", { path: gitCurPath(), message: m });
    setGitOut(r.output || r.error || "", r.ok);
    if (r.ok) { msg.value = ""; autosize(); }
    refreshGit();
  };
  document.querySelector("#git-push").onclick = async () => {
    setGitOut("推送中…");
    const r = await gpost("/api/git/push", { path: gitCurPath() });
    setGitOut(r.output || "", r.ok);
    refreshGit();
  };
  msg.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault(); document.querySelector("#git-commit").click();
    }
  });

  // 分区折叠
  document.querySelectorAll(".scm-section-head").forEach(head => {
    head.onclick = (e) => {
      if (e.target.closest(".scm-branch-chip")) return;
      head.parentElement.classList.toggle("collapsed");
    };
  });
}
