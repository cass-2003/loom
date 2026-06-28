/* Workbench 源代码管理 (Git) —— 仿 VS Code：侧栏只放提交+暂存/更改，提交图独立宽幅视图 */
const gjson = (url, opts) => fetch(url, opts).then(r => r.json());
const gpost = (url, obj) => gjson(url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

function gitCurPath() { return (window.state && window.state.current) || ""; }

const gitState = {
  repo: false,
  staged: 0,
  changed: 0,
  branch: null,
  ref: "",
  branchItems: [],
  branchFilterOpen: false,
  hasHead: false,
  stagedFiles: [],
  unstagedFiles: [],
};
window.gitState = gitState;
let gitRefreshSeq = 0;
const gitBusyActions = new Set();

function setButtonDisabled(el, disabled, reason) {
  if (!el) return;
  if (el.dataset.enabledTitle === undefined) el.dataset.enabledTitle = el.title || "";
  el.disabled = !!disabled;
  el.setAttribute("aria-disabled", disabled ? "true" : "false");
  el.title = disabled ? reason : el.dataset.enabledTitle;
}

function setStatusBranchState(stateInfo) {
  const el = document.querySelector("#status-branch");
  if (!el) return;
  const enabled = !!(stateInfo && stateInfo.enabled);
  el.classList.toggle("status-clickable", enabled);
  el.classList.toggle("disabled", !enabled);
  el.setAttribute("aria-disabled", enabled ? "false" : "true");
  el.title = enabled ? "筛选 Git 历史分支" : ((stateInfo && stateInfo.reason) || "Git 分支不可用");
}

function gitActionState(action) {
  if (gitBusyActions.has(action)) return { enabled: false, reason: "操作正在进行中" };
  if (action === "refresh") {
    if (!window.currentRoot) return { enabled: false, reason: "请先打开工作区" };
    return { enabled: true, reason: "" };
  }
  if (action === "init") {
    if (!window.currentRoot) return { enabled: false, reason: "请先打开工作区" };
    return { enabled: true, reason: "" };
  }
  if (!gitState.repo) return { enabled: false, reason: "当前目录不在 Git 仓库内" };
  if (action === "commit") {
    if (gitState.changed === 0) return { enabled: false, reason: "没有可提交的更改" };
    const msg = document.querySelector("#git-msg");
    if (!msg || !msg.value.trim()) return { enabled: false, reason: "请填写提交信息" };
  }
  if (action === "stageAll") {
    if (!gitState.unstagedFiles.length) return { enabled: false, reason: "没有可暂存的更改" };
  }
  if (action === "unstageAll") {
    if (!gitState.stagedFiles.length) return { enabled: false, reason: "没有可取消暂存的更改" };
  }
  if (action === "push" && !gitState.hasHead) {
    return { enabled: false, reason: "仓库还没有提交历史" };
  }
  if ((action === "branchOps" || action === "branchFilter") && !gitState.hasHead) {
    return { enabled: false, reason: "仓库还没有提交历史" };
  }
  if (action === "stash" && gitState.changed === 0) {
    return { enabled: false, reason: "没有可储藏的更改" };
  }
  return { enabled: true, reason: "" };
}

function setGitBusy(action, busy) {
  if (busy) gitBusyActions.add(action);
  else gitBusyActions.delete(action);
  applyGitActionState();
}

function applyGitActionState() {
  const commitState = gitActionState("commit");
  const pushState = gitActionState("push");
  const stashState = gitActionState("stash");
  const filterState = gitActionState("branchFilter");
  const branchState = gitActionState("branchOps");
  const refreshState = gitActionState("refresh");
  const stageAllState = gitActionState("stageAll");
  const unstageAllState = gitActionState("unstageAll");
  setButtonDisabled(document.querySelector("#git-commit"), !commitState.enabled, commitState.reason || "提交当前更改");
  setButtonDisabled(document.querySelector("#git-push"), !pushState.enabled, pushState.reason || "推送");
  setButtonDisabled(document.querySelector("#git-stash-save"), !stashState.enabled, stashState.reason || "储藏当前更改");
  setButtonDisabled(document.querySelector("#git-branch-filter"), !filterState.enabled, filterState.reason || "筛选 Git 历史分支");
  setButtonDisabled(document.querySelector("#git-branch-ops"), !branchState.enabled, branchState.reason || "分支操作");
  setButtonDisabled(document.querySelector("#git-refresh"), !refreshState.enabled, refreshState.reason || "刷新");
  setStatusBranchState(filterState);
  document.querySelectorAll(".scm-gact[data-act]").forEach(btn => {
    if (btn.id === "git-stash-save") return;
    const st = btn.dataset.act === "stage-all" ? stageAllState : unstageAllState;
    setButtonDisabled(btn, !st.enabled, st.reason || btn.dataset.enabledTitle || "");
  });
}

async function withGitBusy(action, fn) {
  const st = gitActionState(action);
  if (!st.enabled) {
    setGitOut(st.reason || "当前不可用", false);
    if (action === "commit") document.querySelector("#git-msg")?.focus();
    return false;
  }
  setGitBusy(action, true);
  try {
    return await fn();
  } finally {
    setGitBusy(action, false);
  }
}

async function runGitRefresh() {
  return withGitBusy("refresh", async () => {
    await refreshGit();
    return true;
  });
}

async function runGitInit() {
  return withGitBusy("init", async () => {
    setGitOut("初始化仓库中…");
    const r = await gpost("/api/git/init", { path: gitCurPath() });
    setGitOut(r.output || r.error || "", r.ok);
    await refreshGit();
    return !!r.ok;
  });
}

async function runGitCommit() {
  return withGitBusy("commit", async () => {
    const msg = document.querySelector("#git-msg");
    const m = msg ? msg.value.trim() : "";
    setGitOut("提交中…");
    const r = await gpost("/api/git/commit", {
      path: gitCurPath(), message: m, stageAll: gitState.staged === 0,
    });
    setGitOut(r.output || r.error || "", r.ok);
    if (r.ok && msg) {
      msg.value = "";
      autosizeGitMessage();
    }
    await refreshGit();
    return !!r.ok;
  });
}

async function runGitPush() {
  return withGitBusy("push", async () => {
    setGitOut("推送中…");
    const r = await gpost("/api/git/push", { path: gitCurPath() });
    setGitOut(r.output || "", r.ok);
    await refreshGit();
    return !!r.ok;
  });
}

async function runGitStashSave() {
  const msg = prompt("储藏说明（可留空）：", "");
  if (msg === null) return false;
  return withGitBusy("stash", async () => {
    setGitOut("储藏中…");
    const r = await gpost("/api/git/stash-save", { path: gitCurPath(), message: msg.trim() });
    setGitOut(r.output || r.error || "", r.ok);
    await refreshGit();
    return !!r.ok;
  });
}

async function runGitStashPop(ref) {
  return withGitBusy("stashPop", async () => {
    setGitOut("应用储藏中…");
    const r = await gpost("/api/git/stash-pop", { path: gitCurPath(), ref });
    setGitOut(r.output || r.error || "", r.ok);
    await refreshGit();
    return !!r.ok;
  });
}

async function runGitGroupAction(action) {
  const stateAction = action === "stage-all" ? "stageAll" : "unstageAll";
  return withGitBusy(stateAction, async () => {
    const list = stateAction === "stageAll" ? gitState.unstagedFiles.slice() : gitState.stagedFiles.slice();
    const ep = stateAction === "stageAll" ? "/api/git/stage" : "/api/git/unstage";
    setGitOut(stateAction === "stageAll" ? "暂存全部更改中…" : "取消全部暂存中…");
    let ok = true;
    let output = "";
    for (const f of list) {
      if (!f.path) continue;
      const r = await gpost(ep, { path: f.path });
      if (!r.ok) ok = false;
      if (r.output || r.error) output += (output ? "\n" : "") + (r.output || r.error);
    }
    setGitOut(output || (ok ? "操作完成" : "操作失败"), ok);
    await refreshGit();
    return ok;
  });
}

function runGitBranchOps(anchor) {
  const st = gitActionState("branchOps");
  if (!st.enabled) {
    setGitOut(st.reason || "当前不可用", false);
    return false;
  }
  showBranchOps(anchor || document.querySelector("#git-branch-ops") || document.body);
  return true;
}

function runGitBranchFilter(anchor) {
  const st = gitActionState("branchFilter");
  if (!st.enabled) {
    setGitOut(st.reason || "当前不可用", false);
    return false;
  }
  const target = anchor || document.querySelector("#git-branch-filter") || document.querySelector("#status-branch");
  if (gitState.branchFilterOpen) closeBranchFilterMenu();
  else renderBranchFilterMenu(target);
  return true;
}

async function runGitAction(action) {
  const st = gitActionState(action);
  if (!st.enabled) {
    if (typeof setGitOut === "function") setGitOut(st.reason || "当前不可用", false);
    return false;
  }
  if (action === "refresh") {
    return runGitRefresh();
  }
  if (action === "init") {
    return runGitInit();
  }
  if (action === "commit") {
    return runGitCommit();
  }
  if (action === "stageAll") {
    return runGitGroupAction("stage-all");
  }
  if (action === "unstageAll") {
    return runGitGroupAction("unstage-all");
  }
  if (action === "push") {
    return runGitPush();
  }
  if (action === "branchOps") {
    return runGitBranchOps();
  }
  if (action === "branchFilter") {
    return runGitBranchFilter();
  }
  if (action === "stash") {
    return runGitStashSave();
  }
  if (action === "stashPop") {
    return runGitStashPop(arguments[1]);
  }
  return false;
}

window.wbGitActions = {
  actionState: gitActionState,
  run: runGitAction,
};

function setGitControls(repo, d = {}) {
  const staged = d.staged || [];
  const unstaged = d.unstaged || [];
  const changed = repo ? (d.changed || staged.length + unstaged.length) : 0;
  const hasHead = !!(repo && d.hasHead);
  gitState.repo = !!repo;
  gitState.hasHead = hasHead;
  gitState.staged = staged.length;
  gitState.changed = changed;
  gitState.stagedFiles = staged.slice();
  gitState.unstagedFiles = unstaged.slice();
  const noRepo = "当前目录不在 Git 仓库内";
  applyGitActionState();
  if (!repo) {
    setButtonDisabled(document.querySelector("#git-commit"), true, noRepo);
  }
}

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
  const token = ++gitRefreshSeq;
  applyGitActionState();
  const stagedSec = document.querySelector("#scm-staged");
  const stagedEl = document.querySelector("#git-staged");
  const stagedCount = document.querySelector("#git-staged-count");
  const filesEl = document.querySelector("#git-files");
  const changesCount = document.querySelector("#git-changes-count");
  const commitLabel = document.querySelector("#git-commit-label");
  const badge = document.querySelector("#git-badge");
  const stBranch = document.querySelector("#status-branch");

  const d = await gjson(`/api/git/status?path=${encodeURIComponent(gitCurPath())}`);
  if (token !== gitRefreshSeq) return;

  if (d.repo === null || d.repo === undefined) {
    setGitControls(false);
    closeBranchFilterMenu();
    const hasWorkspace = !!window.currentRoot;
    stagedSec.classList.add("hidden");
    changesCount.classList.add("hidden");
    commitLabel.textContent = "提交";
    filesEl.innerHTML = hasWorkspace
      ? `<div class="scm-empty">不在 Git 仓库内<button class="btn ghost" id="git-init" style="margin-top:10px">初始化仓库</button></div>`
      : `<div class="scm-empty">未打开工作区，打开文件夹后可使用 Git</div>`;
    badge.classList.add("hidden");
    stBranch.textContent = "";
    setStatusBranchState({ enabled: false, reason: hasWorkspace ? "当前目录不在 Git 仓库内" : "请先打开工作区" });
    document.querySelector("#git-log").innerHTML = `<div class="scm-empty">${hasWorkspace ? "初始化仓库后显示提交图" : "未打开工作区"}</div>`;
    document.querySelector("#scm-stash").classList.add("hidden");
    const ib = document.querySelector("#git-init");
    if (ib) ib.onclick = async () => {
      await window.wbGitActions.run("init");
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
  setGitControls(true, d);
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
    stagedCount.textContent = "0";
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
  populateBranches(branch, token);
  renderSidebarGraph(token);
  renderStashList(token);
}
window.refreshGit = refreshGit;

/* ============ Stash（储藏）侧栏 ============ */
async function renderStashList(token) {
  const listEl = document.querySelector("#git-stash-list");
  const sec = document.querySelector("#scm-stash");
  const cnt = document.querySelector("#git-stash-count");
  if (!listEl) return;
  const d = await gjson(`/api/git/stash-list?path=${encodeURIComponent(gitCurPath())}`);
  if (token && token !== gitRefreshSeq) return;
  const stashes = d.stashes || [];
  if (cnt) {
    if (stashes.length) { cnt.textContent = stashes.length; cnt.classList.remove("hidden"); }
    else cnt.classList.add("hidden");
  }
  if (!stashes.length) { sec.classList.add("hidden"); listEl.innerHTML = ""; return; }
  sec.classList.remove("hidden");
  listEl.innerHTML = "";
  stashes.forEach(s => {
    const row = document.createElement("div");
    row.className = "scm-file";
    row.innerHTML =
      `<span class="scm-file-ico ic-text">${svgIcon("git", 14)}</span>`
      + `<span class="scm-file-name">${escapeHtml(s.ref)}</span>`
      + `<span class="scm-file-dir">${escapeHtml(s.subject)}</span>`
      + `<span class="scm-file-actions">`
      + `<button class="scm-act" data-act="pop" title="弹出（应用并删除）">${svgIcon("download", 14)}</button>`
      + `</span>`;
    row.querySelector(".scm-act").onclick = async (e) => {
      e.stopPropagation();
      await window.wbGitActions.run("stashPop", s.ref);
    };
    listEl.appendChild(row);
  });
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
const ROW_H = 28, LANE_W = 17, PAD_X = 12, NODE_R = 4.4;
const LANE_COLORS = ["#2f81f7", "#3fb950", "#d29922", "#a371f7",
  "#ec6a5e", "#56b6c2", "#e879f9", "#fb923c"];

function computeLanes(commits) {
  const rowOf = {};
  commits.forEach((c, i) => { rowOf[c.hash] = i; });
  const lanes = [];          // 每条 lane 当前期待的下一个提交 hash（或 null）
  const nodeLane = {};
  const activeByRow = {};
  let maxLane = 0;
  const nextEmptyLane = (start = 0) => {
    let idx = Math.max(0, start);
    while (lanes[idx]) idx++;
    if (idx >= lanes.length) lanes.length = idx + 1;
    return idx;
  };
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) {
      lane = nextEmptyLane(0);
    }
    nodeLane[c.hash] = lane;
    for (let k = 0; k < lanes.length; k++) if (lanes[k] === c.hash) lanes[k] = null;
    const ps = c.parents || [];
    if (ps.length) {
      lanes[lane] = ps[0];
      for (let p = 1; p < ps.length; p++) {
        let nl = lanes.indexOf(ps[p]);
        if (nl === -1) nl = nextEmptyLane(lane + 1);
        lanes[nl] = ps[p];
      }
    } else {
      lanes[lane] = null;
    }
    activeByRow[i] = lanes
      .map((hash, idx) => hash || idx === lane ? idx : null)
      .filter(idx => idx !== null);
    maxLane = Math.max(maxLane, lanes.length - 1, lane);
  }
  return { nodeLane, rowOf, activeByRow, maxLane };
}

function graphPath(d, color, crossLane = false, cls = "") {
  const stroke = crossLane ? 2 : 2.15;
  const opacity = crossLane ? .82 : .92;
  return `<path class="${cls}" d="${d}" stroke="${color}" stroke-width="${stroke}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`;
}

function edgePath(x1, y1, x2, y2, color, crossLane = false) {
  if (x1 === x2) {
    return graphPath(`M${x1} ${y1} L${x2} ${y2}`, color, false, "ggraph-edge vertical");
  }
  const midY = Math.round((y1 + y2) / 2);
  const d = `M${x1} ${y1} L${x1} ${midY} L${x2} ${y2}`;
  return graphPath(d, color, crossLane, "ggraph-edge cross");
}

function activeLanePath(lane, fromRow, toRow, laneX, rowY) {
  if (toRow <= fromRow) return "";
  const x = laneX(lane);
  const y1 = rowY(fromRow) + NODE_R + 1.5;
  const y2 = rowY(toRow) - NODE_R - 1.5;
  if (y2 <= y1) return "";
  const color = LANE_COLORS[lane % LANE_COLORS.length];
  return graphPath(`M${x} ${y1} L${x} ${y2}`, color, false, "ggraph-edge rail");
}

function buildGraphSvg(commits, lay) {
  const { nodeLane, rowOf, activeByRow, maxLane } = lay;
  const laneX = l => PAD_X + l * LANE_W;
  const rowY = i => i * ROW_H + ROW_H / 2;
  const w = PAD_X * 2 + maxLane * LANE_W + 10;
  const h = commits.length * ROW_H;
  const hasHead = commits.some(c => (c.refs || []).some(r => r.kind === "head"));
  let rails = "", backPaths = "", mergePaths = "", nodes = "";
  const openRail = new Map();
  for (let i = 0; i < commits.length; i++) {
    const active = new Set(activeByRow[i] || []);
    active.forEach(lane => {
      if (!openRail.has(lane)) openRail.set(lane, i);
    });
    Array.from(openRail.keys()).forEach(lane => {
      if (!active.has(lane) || i === commits.length - 1) {
        const from = openRail.get(lane);
        const to = active.has(lane) && i === commits.length - 1 ? i : i - 1;
        rails += activeLanePath(lane, from, to, laneX, rowY);
        openRail.delete(lane);
      }
    });
  }
  commits.forEach((c, i) => {
    const x1 = laneX(nodeLane[c.hash]), y1 = rowY(i);
    const childLane = nodeLane[c.hash];
    const childColor = LANE_COLORS[childLane % LANE_COLORS.length];
    (c.parents || []).forEach(p => {
      if (p in rowOf) {
        const parentLane = nodeLane[p];
        const seg = edgePath(x1, y1, laneX(parentLane), rowY(rowOf[p]), childColor, parentLane !== childLane);
        if (parentLane === childLane) backPaths += seg;
        else mergePaths += seg;
      } else backPaths += edgePath(x1, y1, x1, h, childColor);   // 父提交在加载范围外 → 画到底部
    });
    const col = childColor;
    // 空心环只标真正的 HEAD（带 head 引用）；查看非当前分支时无 HEAD，则标该分支提示(第0行)
    const isHead = (c.refs || []).some(r => r.kind === "head") || (!hasHead && i === 0);
    nodes += isHead
      ? `<circle cx="${x1}" cy="${y1}" r="${NODE_R + 2}" fill="var(--bg2)" stroke="${col}" stroke-width="2.8"/>`
      : `<circle cx="${x1}" cy="${y1}" r="${NODE_R + .5}" fill="${col}" stroke="rgba(255,255,255,.18)" stroke-width=".8"/>`;
  });
  return { svg: `<svg class="ggraph-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${rails}${mergePaths}${backPaths}${nodes}</svg>`, w };
}

let branchesLoaded = "";   // 已填充的分支列表签名，避免重复重建 <select>
async function populateBranches(current, token) {
  const sel = document.querySelector("#git-branch-sel");
  if (!sel) return;
  const d = await gjson(`/api/git/branches?path=${encodeURIComponent(gitCurPath())}`);
  if (token && token !== gitRefreshSeq) return;
  const branches = d.branches || [];
  const sig = (d.current || "") + "|" + branches.join(",");
  if (sig === branchesLoaded) return;   // 列表没变，保留当前选择
  branchesLoaded = sig;
  if (!d.hasHead) {
    gitState.ref = "__all__";
    gitState.branchItems = [];
    sel.innerHTML = `<option value="__all__">暂无历史</option>`;
    renderBranchFilterButton();
    return;
  }
  if (!gitState.ref) gitState.ref = "__all__";
  gitState.branchItems = [
    { value: "__all__", label: "全部历史记录", kind: "all", current: false },
    { value: d.current || "", label: d.current || "当前分支", kind: "head", current: true },
    ...branches
      .filter(b => b && b !== d.current)
      .map(b => ({ value: b, label: b, kind: "branch", current: false }))
  ].filter((item, idx, arr) => item.value || item.kind === "all" ? arr.findIndex(x => x.value === item.value && x.kind === item.kind) === idx : false);
  let html = `<option value="__all__">所有分支</option>`;
  for (const b of branches) {
    html += `<option value="${escapeHtml(b)}">${escapeHtml(b)}${b === d.current ? " ✓" : ""}</option>`;
  }
  sel.innerHTML = html;
  sel.value = gitState.ref || "__all__";
  renderBranchFilterButton();
}

function branchLabelForValue(value) {
  const item = (gitState.branchItems || []).find(x => x.value === value);
  return item ? item.label : (value === "__all__" ? "全部" : (value || "全部"));
}

function renderBranchFilterButton() {
  const btn = document.querySelector("#git-branch-filter");
  if (!btn) return;
  const label = btn.querySelector(".gbf-label");
  if (label) label.textContent = branchLabelForValue(gitState.ref || "__all__");
  btn.classList.toggle("active", !!gitState.branchFilterOpen);
}

function closeBranchFilterMenu() {
  gitState.branchFilterOpen = false;
  document.querySelectorAll(".branch-filter-pop").forEach(p => p.remove());
  renderBranchFilterButton();
}

function renderBranchFilterMenu(anchor) {
  if (!gitState.hasHead || !(gitState.branchItems || []).length) {
    setGitOut("仓库还没有提交历史，首次提交后才能筛选分支历史", false);
    return;
  }
  closeBranchFilterMenu();
  gitState.branchFilterOpen = true;
  renderBranchFilterButton();
  const pop = document.createElement("div");
  pop.className = "branch-filter-pop";
  const items = gitState.branchItems || [];
  let html = `<div class="bfp-head">选择要查看的历史记录</div>`;
  html += `<div class="bfp-list">`;
  for (const item of items) {
    const checked = (gitState.ref || "__all__") === item.value;
    const icon = item.kind === "all" ? "list" : "branch";
    html += `<button class="bfp-item${checked ? " checked" : ""}" data-value="${escapeHtml(item.value)}">`
      + `<span class="bfp-mark">${checked ? svgIcon("check", 13) : ""}</span>`
      + `<span class="bfp-ico">${svgIcon(icon, 13)}</span>`
      + `<span class="bfp-text">${escapeHtml(item.label)}</span>`
      + `${item.current ? `<span class="bfp-kind">当前</span>` : ""}`
      + `</button>`;
  }
  html += `</div>`;
  pop.innerHTML = html;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  let left = r.right - 300;
  if (left < 8) left = 8;
  let top = r.bottom + 6;
  if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 6);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  pop.querySelectorAll(".bfp-item").forEach(btn => {
    btn.onclick = () => {
      gitState.ref = btn.dataset.value || "__all__";
      const sel = document.querySelector("#git-branch-sel");
      if (sel) sel.value = gitState.ref;
      closeBranchFilterMenu();
      renderSidebarGraph();
    };
  });
  setTimeout(() => {
    const off = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) {
        closeBranchFilterMenu();
        document.removeEventListener("mousedown", off);
      }
    };
    document.addEventListener("mousedown", off);
  }, 0);
}

function formatRefChip(ref) {
  const label = ref.kind === "head" ? `HEAD · ${ref.name}` : ref.name;
  const icon = ref.kind === "tag" ? "tag" : "branch";
  return `<span class="ggraph-ref ${ref.kind}">${svgIcon(icon, 11)}<span>${escapeHtml(label)}</span></span>`;
}

async function renderSidebarGraph(token) {
  const logEl = document.querySelector("#git-log");
  if (!logEl) return;
  const ref = gitState.ref && gitState.ref !== "__all__" ? gitState.ref : "__all__";
  const d = await gjson(`/api/git/log?path=${encodeURIComponent(gitCurPath())}&ref=${encodeURIComponent(ref)}`);
  if (token && token !== gitRefreshSeq) return;
  const commits = d.commits || [];
  if (!commits.length) {
    const msg = gitState.repo && !gitState.hasHead
      ? "暂无提交。先暂存文件并完成首次提交后，这里会显示分支图。"
      : "暂无提交";
    logEl.innerHTML = `<div class="scm-empty">${escapeHtml(msg)}</div>`;
    return;
  }
  const lay = computeLanes(commits);
  const laneX = l => PAD_X + l * LANE_W;
  const { svg, w } = buildGraphSvg(commits, lay);

  let rows = "";
  commits.forEach(c => {
    const lane = lay.nodeLane[c.hash] || 0;
    const laneOffset = laneX(lane) + 14;
    const laneColor = LANE_COLORS[lane % LANE_COLORS.length];
    const refsHTML = (c.refs || []).map(formatRefChip).join("");
    rows += `<div class="ggraph-row" data-hash="${c.hash}" data-lane="${lane}" data-lane-offset="${laneOffset}" `
      + `style="height:${ROW_H}px; --lane-offset:${laneOffset}px; --lane-color:${laneColor}">`
      + `<div class="ggraph-main">`
      + `<div class="ggraph-top"><span class="ggraph-msg">${escapeHtml(c.subject)}</span>${refsHTML ? `<span class="ggraph-refs">${refsHTML}</span>` : ""}</div>`
      + `</div></div>`;
  });
  logEl.innerHTML =
    `<div class="ggraph-stage"><div class="ggraph-col" style="width:${w}px">${svg}</div><div class="ggraph-rows">${rows}</div></div>`;

  logEl.querySelectorAll(".ggraph-row").forEach(row => {
    attachCommitHover(row);
    row.addEventListener("click", () => toggleCommitFiles(row));
  });
}

/* ===== 点提交行 → 内联展开改动文件列表 ===== */
const commitFilesCache = {};

function statusLetterForCommit(code) {
  code = (code || "").trim().toUpperCase();
  if (code[0] === "A") return ["A", "g-add"];
  if (code[0] === "D") return ["D", "g-del"];
  if (code[0] === "R") return ["R", "g-mod"];
  if (code[0] === "C") return ["C", "g-add"];
  return ["M", "g-mod"];
}

async function toggleCommitFiles(row) {
  // 已展开 → 收起
  const next = row.nextElementSibling;
  if (next && next.classList.contains("ggraph-files")) {
    next.remove();
    row.classList.remove("expanded");
    return;
  }
  // 同一时间只展开一个：移除其它已展开面板
  document.querySelectorAll(".ggraph-files").forEach(e => e.remove());
  document.querySelectorAll(".ggraph-row.expanded").forEach(e => e.classList.remove("expanded"));

  const h = row.dataset.hash;
  row.classList.add("expanded");
  const panel = document.createElement("div");
  panel.className = "ggraph-files";
  const laneOffset = parseInt(row.dataset.laneOffset || "0", 10);
  if (laneOffset) panel.style.marginLeft = Math.max(18, laneOffset + 6) + "px";
  panel.innerHTML = `<div class="ggraph-files-loading">加载中…</div>`;
  row.after(panel);

  let d = commitFilesCache[h];
  if (!d) {
    d = await gjson(`/api/git/commit_files?path=${encodeURIComponent(gitCurPath())}&hash=${h}`);
    if (d.error) { panel.innerHTML = `<div class="ggraph-files-loading">${escapeHtml(d.error)}</div>`; return; }
    commitFilesCache[h] = d;
  }
  // 面板可能在请求期间被收起/替换
  if (!panel.isConnected) return;

  const files = d.files || [];
  if (!files.length) { panel.innerHTML = `<div class="ggraph-files-loading">无文件改动</div>`; return; }

  panel.innerHTML = "";
  files.forEach(f => {
    const slash = f.path.lastIndexOf("/");
    const name = slash >= 0 ? f.path.slice(slash + 1) : f.path;
    const dir = slash >= 0 ? f.path.slice(0, slash) : "";
    const [iconName, iconCls] = gitIconFor(name);
    const [letter, letterCls] = statusLetterForCommit(f.status);
    const item = document.createElement("div");
    item.className = "ggraph-file";
    item.title = f.path;
    item.innerHTML =
      `<span class="ggraph-file-ico ${iconCls}">${svgIcon(iconName, 14)}</span>`
      + `<span class="ggraph-file-name">${escapeHtml(name)}</span>`
      + `<span class="ggraph-file-dir">${escapeHtml(dir)}</span>`
      + `<span class="ggraph-file-status ${letterCls}">${letter}</span>`;
    item.onclick = async (e) => {
      e.stopPropagation();
      panel.querySelectorAll(".ggraph-file.active").forEach(x => x.classList.remove("active"));
      item.classList.add("active");
      const dd = await gjson(
        `/api/git/commit_diff?path=${encodeURIComponent(gitCurPath())}&hash=${h}&file=${encodeURIComponent(f.path)}`);
      const title = `${f.path} @ ${h.slice(0, 7)}`;
      window.showDiffView(title, dd.diff || "(无文本差异 / 二进制文件)");
    };
    panel.appendChild(item);
  });
}

/* ===== 提交悬浮详情卡（鼠标停在某条提交上弹出） ===== */
const commitCache = {};
let popEl = null, popShowTimer = null, popHideTimer = null, popHash = null;

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
    popHash = h;   // 标记"当前意图展示的提交"，await 后据此判断是否仍该展示
    popShowTimer = setTimeout(async () => {
      ensurePopover();
      let d = commitCache[h];
      if (!d) {
        d = await gjson(`/api/git/show?path=${encodeURIComponent(gitCurPath())}&hash=${h}`);
        if (d.error) return;
        commitCache[h] = d;
      }
      // await 期间鼠标可能已移开(popHash 变了/清空)或图重建(row 脱离文档)→ 别再弹卡
      if (popHash !== h || !row.isConnected) return;
      popEl.innerHTML = buildPopoverHTML(d);
      positionPopover(row);
    }, 300);
  });
  row.addEventListener("mouseleave", () => { popHash = null; hidePopover(); });
}

let gitOutTimer = null;
function setGitOut(text, ok) {
  const el = document.querySelector("#git-out");
  el.textContent = text;
  el.style.color = ok === undefined ? "" : (ok ? "var(--accent2)" : "var(--danger)");
  clearTimeout(gitOutTimer);
  if (text) gitOutTimer = setTimeout(() => { el.textContent = ""; }, 6000);
}

function autosizeGitMessage() {
  const msg = document.querySelector("#git-msg");
  if (!msg) return;
  msg.style.height = "auto";
  msg.style.height = Math.min(msg.scrollHeight, 160) + "px";
}

function initGit() {
  document.querySelector("#git-refresh").onclick = () => window.wbGitActions.run("refresh");
  const msg = document.querySelector("#git-msg");

  msg.addEventListener("input", () => {
    autosizeGitMessage();
    applyGitActionState();
  });

  document.querySelector("#git-commit").onclick = async () => {
    await window.wbGitActions.run("commit");
  };
  document.querySelector("#git-push").onclick = async () => {
    await window.wbGitActions.run("push");
  };
  msg.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault(); window.wbGitActions.run("commit");
    }
  });

  // 组级批量动作（暂存全部 / 取消全部）
  document.querySelectorAll(".scm-gact").forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (btn.id === "git-stash-save") return;
      if (btn.disabled) return;
      await window.wbGitActions.run(btn.dataset.act === "stage-all" ? "stageAll" : "unstageAll");
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
  const filterBtn = document.querySelector("#git-branch-filter");
  if (filterBtn) filterBtn.onclick = (e) => {
    e.stopPropagation();
    runGitBranchFilter(filterBtn);
  };
  const statusBranch = document.querySelector("#status-branch");
  if (statusBranch) statusBranch.onclick = (e) => {
    e.stopPropagation();
    runGitBranchFilter(statusBranch);
  };

  // 储藏（保存当前更改）
  const stashSave = document.querySelector("#git-stash-save");
  if (stashSave) stashSave.onclick = async (e) => {
    e.stopPropagation();
    await window.wbGitActions.run("stash");
  };

  // 分支操作菜单
  const branchOps = document.querySelector("#git-branch-ops");
  if (branchOps) branchOps.onclick = (e) => {
    e.stopPropagation();
    window.wbGitActions.run("branchOps");
  };
}

/* ============ 分支操作（新建 / 检出 / 删除） ============ */
async function showBranchOps(anchor) {
  document.querySelectorAll(".branch-pop").forEach(p => p.remove());
  const d = await gjson(`/api/git/branches?path=${encodeURIComponent(gitCurPath())}`);
  const branches = d.branches || [];
  const cur = d.current || "";
  const pop = document.createElement("div");
  pop.className = "branch-pop";
  let html = `<div class="bp-head">分支操作</div>`;
  html += `<button class="bp-item" data-act="new">${svgIcon("plus", 14)}<span>新建分支…</span></button>`;
  html += `<div class="bp-sep"></div>`;
  html += `<div class="bp-label">检出 / 删除</div>`;
  for (const b of branches) {
    const isCur = b === cur;
    html += `<div class="bp-branch${isCur ? " current" : ""}" data-branch="${escapeHtml(b)}">`
      + `<button class="bp-checkout" data-act="checkout" data-branch="${escapeHtml(b)}" title="检出">`
      + svgIcon("branch", 13) + `<span>${escapeHtml(b)}${isCur ? " ✓" : ""}</span></button>`
      + (isCur ? "" : `<button class="bp-del" data-act="delete" data-branch="${escapeHtml(b)}" title="删除分支">${svgIcon("trash", 13)}</button>`)
      + `</div>`;
  }
  pop.innerHTML = html;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  let left = r.right - 220;
  if (left < 8) left = 8;
  pop.style.left = left + "px";
  pop.style.top = (r.bottom + 4) + "px";

  const close = () => pop.remove();
  pop.querySelector('[data-act="new"]').onclick = async () => {
    close();
    const name = prompt("新分支名（基于当前分支创建并切换）：", "");
    if (!name) return;
    const rr = await gpost("/api/git/branch-create", { path: gitCurPath(), name: name.trim() });
    setGitOut(rr.output || rr.error || "", rr.ok);
    gitState.ref = ""; branchesLoaded = "";
    refreshGit();
  };
  pop.querySelectorAll('[data-act="checkout"]').forEach(b => {
    b.onclick = async () => {
      close();
      setGitOut("检出中…");
      const rr = await gpost("/api/git/checkout", { path: gitCurPath(), ref: b.dataset.branch });
      setGitOut(rr.output || rr.error || "", rr.ok);
      gitState.ref = ""; branchesLoaded = "";
      refreshGit();
    };
  });
  pop.querySelectorAll('[data-act="delete"]').forEach(b => {
    b.onclick = async () => {
      const name = b.dataset.branch;
      close();
      if (!confirm(`删除分支 ${name}？`)) return;
      let rr = await gpost("/api/git/branch-delete", { path: gitCurPath(), name });
      if (!rr.ok && /not fully merged/i.test(rr.output || "")) {
        if (confirm(`分支 ${name} 未完全合并，强制删除？`))
          rr = await gpost("/api/git/branch-delete", { path: gitCurPath(), name, force: true });
        else return;
      }
      setGitOut(rr.output || rr.error || "", rr.ok);
      branchesLoaded = "";
      refreshGit();
    };
  });
  setTimeout(() => {
    const off = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchor) { close(); document.removeEventListener("mousedown", off); }
    };
    document.addEventListener("mousedown", off);
  }, 0);
}

/* ============ 单文件历史（提交列表 → 点击看该文件 diff） ============ */
window.showFileHistory = async function (path) {
  document.querySelector("#activitybar .act[data-view='git']")?.click?.();
  const view = document.querySelector("#filehist-view");
  const head = document.querySelector("#filehist-head");
  const body = document.querySelector("#filehist-body");
  if (!view) return;
  window.hideAllViews && window.hideAllViews();
  view.classList.remove("hidden");
  head.innerHTML = svgIcon("history", 14) + `<span>文件历史: ${escapeHtml(path)}</span>`;
  body.innerHTML = `<div class="scm-empty">加载中…</div>`;
  document.querySelector("#crumb").textContent = "历史: " + path;
  const d = await gjson(`/api/git/file-log?path=${encodeURIComponent(path)}`);
  if (d.error) { body.innerHTML = `<div class="scm-empty">${escapeHtml(d.error)}</div>`; return; }
  const commits = d.commits || [];
  if (!commits.length) { body.innerHTML = `<div class="scm-empty">该文件暂无提交历史</div>`; return; }
  body.innerHTML = "";
  commits.forEach(c => {
    const row = document.createElement("div");
    row.className = "fh-row";
    row.innerHTML =
      `<span class="fh-hash">${escapeHtml(c.hash)}</span>`
      + `<span class="fh-subject">${escapeHtml(c.subject)}</span>`
      + `<span class="fh-meta">${escapeHtml(c.author)} · ${escapeHtml(c.when)}</span>`;
    row.onclick = async () => {
      body.querySelectorAll(".fh-row.active").forEach(x => x.classList.remove("active"));
      row.classList.add("active");
      const dd = await gjson(
        `/api/git/commit_diff?path=${encodeURIComponent(path)}&hash=${c.hash}&file=${encodeURIComponent(d.path)}`);
      window.showDiffView(`${path} @ ${c.hash}`, dd.diff || "(无文本差异 / 二进制文件)");
    };
    body.appendChild(row);
  });
};

/* ============ Blame（逐行作者 + 短 hash） ============ */
window.showBlame = async function (path) {
  document.querySelector("#activitybar .act[data-view='git']")?.click?.();
  const view = document.querySelector("#blame-view");
  const head = document.querySelector("#blame-head");
  const body = document.querySelector("#blame-body");
  if (!view) return;
  window.hideAllViews && window.hideAllViews();
  view.classList.remove("hidden");
  head.innerHTML = svgIcon("list", 14) + `<span>Blame: ${escapeHtml(path)}</span>`;
  body.innerHTML = `<div class="scm-empty">加载中…</div>`;
  document.querySelector("#crumb").textContent = "blame: " + path;
  const d = await gjson(`/api/git/blame?path=${encodeURIComponent(path)}`);
  if (d.error) { body.innerHTML = `<div class="scm-empty">${escapeHtml(d.error)}</div>`; return; }
  const lines = d.lines || [];
  if (!lines.length) { body.innerHTML = `<div class="scm-empty">无内容</div>`; return; }
  // 给每个 commit 配一个稳定的淡色，便于视觉分组
  const colorOf = (h) => {
    let n = 0; for (const ch of h) n = (n * 31 + ch.charCodeAt(0)) % 360;
    return `hsla(${n}, 60%, 50%, .14)`;
  };
  let html = "";
  lines.forEach((ln, i) => {
    html += `<div class="bl-row" style="background:${colorOf(ln.hash)}">`
      + `<span class="bl-author" title="${escapeHtml(ln.summary)}">${escapeHtml(ln.author)}</span>`
      + `<span class="bl-hash">${escapeHtml(ln.hash)}</span>`
      + `<span class="bl-num">${i + 1}</span>`
      + `<span class="bl-code">${escapeHtml(ln.text) || "&nbsp;"}</span>`
      + `</div>`;
  });
  body.innerHTML = html;
};
