/* Workbench 源代码管理 (Git) —— 仿 VS Code：侧栏只放提交+暂存/更改，提交图独立宽幅视图 */
const gjson = (url, opts) => fetch(url, opts).then(r => r.json());
const gpost = (url, obj) => gjson(url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

function gitCurPath() { return (window.state && window.state.current) || ""; }

const gitState = { staged: 0, branch: null, ref: "" };

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
function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
window.escapeHtml = escapeHtml;

/* ============ 源代码管理侧栏 ============ */
async function refreshGit() {
  const stagedSec = document.querySelector("#scm-staged");
  const stagedEl = document.querySelector("#git-staged");
  const stagedCount = document.querySelector("#git-staged-count");
  const filesEl = document.querySelector("#git-files");
  const changesCount = document.querySelector("#git-changes-count");
  const commitLabel = document.querySelector("#git-commit-label");
  const badge = document.querySelector("#git-badge");
  const stBranch = document.querySelector("#status-branch");

  const d = await gjson(`/api/git/status?path=${encodeURIComponent(gitCurPath())}`);

  if (d.repo === null || d.repo === undefined) {
    stagedSec.classList.add("hidden");
    changesCount.classList.add("hidden");
    commitLabel.textContent = "提交";
    filesEl.innerHTML = `<div class="scm-empty">不在 Git 仓库内<button class="btn ghost" id="git-init" style="margin-top:10px">初始化仓库</button></div>`;
    badge.classList.add("hidden");
    stBranch.textContent = "";
    const ib = document.querySelector("#git-init");
    if (ib) ib.onclick = async () => {
      const r = await gpost("/api/git/init", { path: gitCurPath() });
      setGitOut(r.output || "", r.ok); refreshGit();
    };
    return;
  }

  const branch = d.branch || "(无分支)";
  gitState.branch = branch;
  let chip = escapeHtml(branch);
  if (d.ahead) chip += ` ↑${d.ahead}`;
  if (d.behind) chip += ` ↓${d.behind}`;
  stBranch.innerHTML = svgIcon("branch", 12) + `<span>${chip}</span>`;

  const staged = d.staged || [], unstaged = d.unstaged || [];
  gitState.staged = staged.length;
  commitLabel.textContent = staged.length ? `提交 (${branch})` : `提交所有更改 (${branch})`;

  // 徽标 = 改动文件总数
  const total = d.changed || 0;
  if (total) { badge.textContent = total; badge.classList.remove("hidden"); }
  else badge.classList.add("hidden");

  // 暂存的更改
  if (staged.length) {
    stagedSec.classList.remove("hidden");
    stagedCount.textContent = staged.length;
    stagedEl.innerHTML = "";
    staged.forEach(f => stagedEl.appendChild(renderFileRow(f, "staged")));
  } else {
    stagedSec.classList.add("hidden");
    stagedEl.innerHTML = "";
  }

  // 更改（未暂存）
  if (unstaged.length) {
    changesCount.textContent = unstaged.length;
    changesCount.classList.remove("hidden");
    filesEl.innerHTML = "";
    unstaged.forEach(f => filesEl.appendChild(renderFileRow(f, "unstaged")));
  } else {
    changesCount.classList.add("hidden");
    filesEl.innerHTML = staged.length ? "" : `<div class="scm-empty">✓ 没有更改</div>`;
  }

  // 侧栏提交图
  populateBranches(branch);
  renderSidebarGraph();
}

function renderFileRow(f, group) {
  const repoPath = f.repoPath;
  const slash = repoPath.lastIndexOf("/");
  const name = slash >= 0 ? repoPath.slice(slash + 1) : repoPath;
  const dir = slash >= 0 ? repoPath.slice(0, slash) : "";
  const [iconName, iconCls] = gitIconFor(name);
  const [letter, letterCls] = statusLetter(f.status);

  const row = document.createElement("div");
  row.className = "scm-file";
  row.title = repoPath;
  const acts = group === "staged"
    ? `<button class="scm-act" data-act="unstage" title="取消暂存">${svgIcon("minus", 15)}</button>`
    : `<button class="scm-act" data-act="discard" title="丢弃更改">${svgIcon("discard", 14)}</button>
       <button class="scm-act" data-act="stage" title="暂存更改">${svgIcon("plus", 15)}</button>`;
  row.innerHTML = `
    <span class="scm-file-ico ${iconCls}">${svgIcon(iconName, 15)}</span>
    <span class="scm-file-name">${escapeHtml(name)}</span>
    <span class="scm-file-dir">${escapeHtml(dir)}</span>
    <span class="scm-file-actions">
      <button class="scm-act" data-act="open" title="打开文件">${svgIcon("file", 14)}</button>
      ${acts}
    </span>
    <span class="scm-file-status ${letterCls}">${letter}</span>`;

  row.querySelectorAll(".scm-act").forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === "open") { if (f.path && window.openFile) window.openFile(f.path); return; }
      if (act === "stage") await gpost("/api/git/stage", { path: f.path });
      else if (act === "unstage") await gpost("/api/git/unstage", { path: f.path });
      else if (act === "discard") {
        const msg = f.status === "?"
          ? `删除未跟踪文件 ${name}？此操作不可撤销。`
          : `丢弃对 ${name} 的更改？此操作不可撤销。`;
        if (!confirm(msg)) return;
        await gpost("/api/git/discard", { path: f.path, untracked: f.status === "?" });
      }
      refreshGit();
    };
  });
  row.onclick = async () => {
    document.querySelectorAll(".scm-file.active").forEach(e => e.classList.remove("active"));
    row.classList.add("active");
    if (!f.path) return;
    const dd = await gjson(`/api/git/diff?path=${encodeURIComponent(f.path)}`);
    window.showDiffView(repoPath, dd.diff || "(无文本差异 / 二进制文件)");
  };
  return row;
}

/* ============ 提交图（侧栏紧凑图形，仿 Cursor 源代码管理「图形」区） ============ */
const ROW_H = 26, LANE_W = 13, PAD_X = 11, NODE_R = 4;
const LANE_COLORS = ["#2f81f7", "#3fb950", "#d29922", "#a371f7",
  "#ec6a5e", "#56b6c2", "#e879f9", "#fb923c"];

function computeLanes(commits) {
  const rowOf = {};
  commits.forEach((c, i) => { rowOf[c.hash] = i; });
  const lanes = [];          // 每条 lane 当前期待的下一个提交 hash（或 null）
  const nodeLane = {};
  let maxLane = 0;
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) { lane = lanes.length; lanes.push(null); }
    }
    nodeLane[c.hash] = lane;
    for (let k = 0; k < lanes.length; k++) if (lanes[k] === c.hash) lanes[k] = null;
    const ps = c.parents || [];
    if (ps.length) {
      lanes[lane] = ps[0];
      for (let p = 1; p < ps.length; p++) {
        let nl = lanes.indexOf(ps[p]);
        if (nl === -1) { nl = lanes.indexOf(null); if (nl === -1) { nl = lanes.length; lanes.push(null); } }
        lanes[nl] = ps[p];
      }
    } else {
      lanes[lane] = null;
    }
    maxLane = Math.max(maxLane, lanes.length - 1, lane);
  }
  return { nodeLane, rowOf, maxLane };
}

function edgePath(x1, y1, x2, y2, color) {
  const d = x1 === x2
    ? `M${x1} ${y1} L${x2} ${y2}`
    : `M${x1} ${y1} C ${x1} ${y1 + ROW_H * 0.5} ${x2} ${y2 - ROW_H * 0.5} ${x2} ${y2}`;
  return `<path d="${d}" stroke="${color}" stroke-width="1.6" fill="none"/>`;
}

function buildGraphSvg(commits, lay) {
  const { nodeLane, rowOf, maxLane } = lay;
  const laneX = l => PAD_X + l * LANE_W;
  const rowY = i => i * ROW_H + ROW_H / 2;
  const w = PAD_X * 2 + maxLane * LANE_W;
  const h = commits.length * ROW_H;
  const hasHead = commits.some(c => (c.refs || []).some(r => r.kind === "head"));
  let paths = "", nodes = "";
  commits.forEach((c, i) => {
    const x1 = laneX(nodeLane[c.hash]), y1 = rowY(i);
    (c.parents || []).forEach(p => {
      const color = LANE_COLORS[(p in rowOf ? nodeLane[p] : nodeLane[c.hash]) % LANE_COLORS.length];
      if (p in rowOf) paths += edgePath(x1, y1, laneX(nodeLane[p]), rowY(rowOf[p]), color);
      else paths += edgePath(x1, y1, x1, h, color);   // 父提交在加载范围外 → 画到底部
    });
    const col = LANE_COLORS[nodeLane[c.hash] % LANE_COLORS.length];
    // 空心环只标真正的 HEAD（带 head 引用）；查看非当前分支时无 HEAD，则标该分支提示(第0行)
    const isHead = (c.refs || []).some(r => r.kind === "head") || (!hasHead && i === 0);
    nodes += isHead
      ? `<circle cx="${x1}" cy="${y1}" r="${NODE_R + 1}" fill="var(--bg2)" stroke="${col}" stroke-width="2.5"/>`
      : `<circle cx="${x1}" cy="${y1}" r="${NODE_R}" fill="${col}"/>`;
  });
  return { svg: `<svg class="ggraph-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${paths}${nodes}</svg>`, w };
}

let branchesLoaded = "";   // 已填充的分支列表签名，避免重复重建 <select>
async function populateBranches(current) {
  const sel = document.querySelector("#git-branch-sel");
  if (!sel) return;
  const d = await gjson(`/api/git/branches?path=${encodeURIComponent(gitCurPath())}`);
  const branches = d.branches || [];
  const sig = (d.current || "") + "|" + branches.join(",");
  if (sig === branchesLoaded) return;   // 列表没变，保留当前选择
  branchesLoaded = sig;
  if (!gitState.ref) gitState.ref = d.current || "";
  let html = `<option value="__all__">所有分支</option>`;
  for (const b of branches) {
    html += `<option value="${escapeHtml(b)}">${escapeHtml(b)}${b === d.current ? " ✓" : ""}</option>`;
  }
  sel.innerHTML = html;
  sel.value = gitState.ref || d.current || "__all__";
}

async function renderSidebarGraph() {
  const logEl = document.querySelector("#git-log");
  if (!logEl) return;
  const ref = gitState.ref && gitState.ref !== "__all__" ? gitState.ref : (gitState.ref || "");
  const d = await gjson(`/api/git/log?path=${encodeURIComponent(gitCurPath())}&ref=${encodeURIComponent(ref)}`);
  const commits = d.commits || [];
  if (!commits.length) { logEl.innerHTML = `<div class="scm-empty">暂无提交</div>`; return; }
  const lay = computeLanes(commits);
  const { svg, w } = buildGraphSvg(commits, lay);

  let rows = "";
  commits.forEach(c => {
    const refsHTML = (c.refs || []).map(r =>
      `<span class="ggraph-ref ${r.kind}">${escapeHtml(r.name)}</span>`).join("");
    rows += `<div class="ggraph-row" data-hash="${c.hash}" style="height:${ROW_H}px" title="${escapeHtml(c.subject)}">`
      + `<span class="ggraph-msg">${escapeHtml(c.subject)}</span>${refsHTML}</div>`;
  });
  logEl.innerHTML =
    `<div class="ggraph-col" style="width:${w}px">${svg}</div><div class="ggraph-rows">${rows}</div>`;

  logEl.querySelectorAll(".ggraph-row").forEach(row => attachCommitHover(row));
}

/* ===== 提交悬浮详情卡（鼠标停在某条提交上弹出） ===== */
const commitCache = {};
let popEl = null, popShowTimer = null, popHideTimer = null;

function ensurePopover() {
  if (popEl) return popEl;
  popEl = document.createElement("div");
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
  const rect = row.getBoundingClientRect(), pop = popEl;
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
    }, 300);
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

  const autosize = () => { msg.style.height = "auto"; msg.style.height = Math.min(msg.scrollHeight, 160) + "px"; };
  msg.addEventListener("input", autosize);

  document.querySelector("#git-commit").onclick = async () => {
    const m = msg.value.trim();
    if (!m) { setGitOut("请填写提交信息", false); msg.focus(); return; }
    setGitOut("提交中…");
    // 有暂存内容 → 只提交暂存；否则提交所有更改
    const r = await gpost("/api/git/commit", {
      path: gitCurPath(), message: m, stageAll: gitState.staged === 0,
    });
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

  // 组级批量动作（暂存全部 / 取消全部）
  document.querySelectorAll(".scm-gact").forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      const d = await gjson(`/api/git/status?path=${encodeURIComponent(gitCurPath())}`);
      const list = act === "stage-all" ? (d.unstaged || []) : (d.staged || []);
      const ep = act === "stage-all" ? "/api/git/stage" : "/api/git/unstage";
      for (const f of list) if (f.path) await gpost(ep, { path: f.path });
      refreshGit();
    };
  });

  // 分区折叠（点头部空白处折叠，点动作/选择器不折叠）
  document.querySelectorAll("#view-git .scm-section-head").forEach(head => {
    head.onclick = (e) => {
      if (e.target.closest(".scm-group-actions") || e.target.closest(".scm-head-extra")) return;
      head.parentElement.classList.toggle("collapsed");
    };
  });

  // 分支选择 → 切换图形显示的分支
  const sel = document.querySelector("#git-branch-sel");
  if (sel) sel.onchange = () => { gitState.ref = sel.value; renderSidebarGraph(); };
}
