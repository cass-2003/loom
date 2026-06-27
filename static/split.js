/* split.js — 编辑器分屏副组（VS Code 风格 "Open to the Side"）
 *
 * 设计：主编辑组（app.js 里的 #editor / Vditor / state.*）完全不动，本模块**附加**一个
 * 独立的「副组」#side-group：自带标签条 + textarea + 行号槽 + 脏标 + 保存。
 *   · 把主组标签拖到编辑区右半/下半 → 该文件**移动**到副组（move 语义，不复制，避免双开同文件冲突）
 *   · 副组标签可拖回主组标签条；可在副组内重排；可关闭
 *   · 焦点在哪个组，Ctrl+S / 状态栏就跟哪个组
 *   · 方向左右(h)/上下(v)可切；比例可拖；标签集+方向持久化到 wb-split
 * 副组只编辑「源码文本」（含 .md 以源码方式），不内嵌 Vditor，规避 Vditor×2 风险。
 */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const SIZE_KEY = "wb-split-size", ORIENT_KEY = "wb-split-orient";
  // 按根路径分区（同 app.js 的 wsKey），切根时旧副组标签不串到新根
  const WS_KEY = () => {
    const id = window.currentWorkspaceId;
    return id ? ("wb-split:" + id) : null;
  };
  const SIZE_WS_KEY = () => {
    const id = window.currentWorkspaceId;
    return id ? (SIZE_KEY + ":" + id) : SIZE_KEY;
  };

  const side = { tabs: [], active: null, dirty: false };
  let focus = "main";                                  // "main" | "side"
  let orient = localStorage.getItem(ORIENT_KEY) === "v" ? "v" : "h";  // h=左右, v=上下
  let restoring = false;
  let sideGutterN = -1;   // 行号槽行数缓存：行数不变就跳过重建（同主编辑器 gutterLineCount）

  const wb = () => window.wb || {};
  const isMd = (ext) => ext === ".md" || ext === ".markdown";
  function projectStateKey(path) {
    const m = String(path || "").match(/^project:\/\/(requirements|progress|log|memory)$/);
    return m ? m[1] : null;
  }
  function sideTabByPath(p) { return side.tabs.find(t => t.path === p) || null; }
  function hasSide() { return side.tabs.length > 0; }

  // ---------- 持久化 ----------
  function persist() {
    if (restoring) return;
    const key = WS_KEY();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({
        tabs: side.tabs.map(t => t.path), active: side.active, orient,
      }));
    } catch (_) {}
  }

  // ---------- 布局 ----------
  function applyLayout() {
    const cb = $("#content-body"), grp = $("#side-group"), rz = $("#side-resizer");
    if (!cb || !grp || !rz) return;
    if (!hasSide()) {
      cb.classList.remove("has-side", "split-v");
      grp.classList.add("hidden"); rz.classList.add("hidden");
      grp.style.flex = ""; grp.style.width = ""; grp.style.height = "";
      return;
    }
    cb.classList.add("has-side");
    cb.classList.toggle("split-v", orient === "v");
    grp.classList.remove("hidden"); rz.classList.remove("hidden");
    const avail = (orient === "v" ? cb.clientHeight : cb.clientWidth) || 0;
    const saved = parseInt(localStorage.getItem(SIZE_WS_KEY()) || localStorage.getItem(SIZE_KEY) || "", 10);
    let px = saved >= 120 ? saved : Math.round(avail * 0.42) || 480;
    // 始终钳制：上界给主编辑区留空间，防越界/损坏的 saved 值吃满布局把主编辑区挤出视口
    if (avail > 240) px = Math.max(120, Math.min(px, avail - 120));
    else if (avail > 0) px = Math.max(60, Math.min(px, Math.max(60, avail - 60)));  // 小窗口下也要钳制
    grp.style.flex = "0 0 " + px + "px";
    grp.style.width = ""; grp.style.height = "";
    refit();
  }
  function refit() {
    sideGutter();
    if (typeof window.termRefit === "function") { try { window.termRefit(); } catch (_) {} }
  }

  // ---------- 副组标签条 ----------
  function clearSideDrop() {
    document.querySelectorAll("#side-tabbar .tab").forEach(t =>
      t.classList.remove("tab-drop-before", "tab-drop-after"));
  }
  function renderSideTabs() {
    if (window.saveWorkspace) {} // 主组的工作区保存由 app 管，这里只管自己的 key
    persist();
    const bar = $("#side-tabbar");
    if (!bar) return;
    bar.innerHTML = "";
    if (!hasSide()) { applyLayout(); return; }
    for (const tab of side.tabs) {
      const isDirty = tab.dirty || (tab.path === side.active && side.dirty);
      const [iconName, iconCls] = window.tabIconFor ? window.tabIconFor(tab) : ["file", "ic-code"];
      const el = document.createElement("div");
      el.className = "tab" + (tab.path === side.active ? " active" : "") + (isDirty ? " dirty" : "");
      el.title = tab.path;
      el.dataset.path = tab.path;
      el.innerHTML =
        `<span class="tab-ico ${iconCls}">${window.svgIcon(iconName, 15)}</span>`
        + `<span class="tab-name">${window.escHtml ? window.escHtml(tab.name) : tab.name}</span>`
        + `<span class="tab-close" title="关闭">${window.svgIcon("close", 13)}</span>`;
      el.addEventListener("click", (e) => {
        if (e.target.closest(".tab-close")) { closeSide(tab.path); return; }
        activateSide(tab.path);
      });
      el.addEventListener("mousedown", (e) => {
        if (e.button === 1) { e.preventDefault(); closeSide(tab.path); }
      });
      attachSideTabDrag(el, tab);
      bar.appendChild(el);
    }
    // 右侧迷你工具栏：方向切换 + 关闭分屏
    const tools = document.createElement("div");
    tools.className = "side-tools";
    tools.innerHTML =
      `<button class="tb-btn" id="side-orient" title="切换分屏方向：左右 / 上下">`
      + `${window.svgIcon(orient === "v" ? "splitH" : "columns", 15)}</button>`
      + `<button class="tb-btn" id="side-close-all" title="关闭分屏（文件移回主组）">`
      + `${window.svgIcon("close", 15)}</button>`;
    bar.appendChild(tools);
    tools.querySelector("#side-orient").onclick = () => setOrient(orient === "v" ? "h" : "v");
    tools.querySelector("#side-close-all").onclick = () => collapseAll();
    applyLayout();
  }

  // ---------- 副组编辑器 ----------
  function stashSide() {
    const t = sideTabByPath(side.active);
    if (t) { t.draft = $("#side-editor").value; t.dirty = side.dirty; }
  }
  function activateSide(path, noFocus) {
    const tab = sideTabByPath(path);
    if (!tab) return;
    if (side.active === path) {   // 已是当前副组标签：别重置编辑器(否则丢未存编辑)，只聚焦
      if (!noFocus) { setFocus("side"); $("#side-editor").focus(); }
      return;
    }
    stashSide();                  // 切走前把上一个标签的实时内容存进草稿
    side.active = path;
    const ed = $("#side-editor");
    ed.value = tab.draft != null ? tab.draft : "";
    side.dirty = !!tab.dirty;
    if (!noFocus) setFocus("side");
    sideGutterN = -1;   // 换文件强制重建行号槽（即使行数相同也要刷）
    sideGutter();
    renderSideTabs();
    if (window.highlightTreeRow) window.highlightTreeRow(path);
    if (!noFocus) ed.focus();
  }
  async function loadFromDisk(path) {
    try {
      const pkey = projectStateKey(path);
      const url = pkey
        ? "/api/project-state/open?name=" + encodeURIComponent(pkey)
        : "/api/file?path=" + encodeURIComponent(path);
      const data = await fetch(url).then(r => r.json());
      if (!data || data.error || data.kind === "binary") return null;
      const name = data.name || path.split("/").pop();
      return { path, name, ext: data.ext || "", kind: "text", draft: data.content || "", dirty: false };
    } catch (_) { return null; }
  }
  function closeSide(path) {
    const tab = sideTabByPath(path);
    if (!tab) return;
    const dirty = tab.dirty || (tab.path === side.active && side.dirty);
    if (dirty && !confirm(`“${tab.name}” 有未保存的更改，确定关闭？`)) return;
    const idx = side.tabs.findIndex(t => t.path === path);
    side.tabs.splice(idx, 1);
    if (side.active === path) {
      side.active = null;
      const next = side.tabs[idx] || side.tabs[idx - 1] || null;
      if (next) activateSide(next.path);
      else { side.dirty = false; setFocus("main"); renderSideTabs(); }
    } else renderSideTabs();
  }

  // ---------- 主 ↔ 副 搬运（move 语义）----------
  function moveToSide(path, zone) {
    const st = wb().state;
    if (!st) return;
    const tab = wb().tabByPath(path);
    if (!tab) return;
    if (tab.kind !== "text" && tab.kind !== "md") {   // 图片/二进制/查看器不进副组
      if (window.setMsg) window.setMsg("该类型暂不支持分屏（仅文本/Markdown）", "warn");
      return;
    }
    if (st.activeTab === path) wb().stashActiveTab();   // 取最新草稿
    // 从主组移除
    const i = st.tabs.findIndex(t => t.path === path);
    if (i >= 0) st.tabs.splice(i, 1);
    const wasActive = st.activeTab === path;
    if (wasActive) {
      st.activeTab = null;
      const nx = st.tabs[i] || st.tabs[i - 1] || null;
      if (nx) wb().activateTab(nx.path);
      else { wb().closeCurrent(); }
    }
    wb().renderTabs();
    // 加入副组（始终以源码文本编辑）
    if (!sideTabByPath(path))
      side.tabs.push({ path, name: tab.name, ext: tab.ext, kind: "text",
                       draft: tab.draft != null ? tab.draft : "", dirty: !!tab.dirty,
                       projectStateKey: tab.projectStateKey || projectStateKey(path) || null });
    const prevOrient = orient;
    if (zone === "bottom") orient = "v";
    else if (zone === "right") orient = "h";
    if (orient !== prevOrient) localStorage.removeItem(SIZE_WS_KEY());  // 方向变了，旧比例(宽/高)不再适用
    localStorage.setItem(ORIENT_KEY, orient);
    renderSideTabs();
    activateSide(path);
  }
  function moveToMain(path) {
    const tab = sideTabByPath(path);
    if (!tab) return;
    stashSide();
    const i = side.tabs.findIndex(t => t.path === path);
    if (i >= 0) side.tabs.splice(i, 1);
    if (side.active === path) {
      side.active = null;
      const nx = side.tabs[i] || side.tabs[i - 1] || null;
      if (nx) { activateSide(nx.path); } else { side.dirty = false; renderSideTabs(); }
    } else renderSideTabs();
    // 放回主组：按扩展名还原 md/text，draft 即源码
    const ext = tab.ext || "";
    wb().addTab({ path, kind: isMd(ext) ? "md" : "text", name: tab.name, ext,
                  dirty: !!tab.dirty, draft: tab.draft != null ? tab.draft : "", viewMode: "split",
                  projectStateKey: tab.projectStateKey || projectStateKey(path) || null });
    wb().activateTab(path);
    setFocus("main");
  }
  function collapseAll() {
    // 关闭分屏：把副组所有文件移回主组
    const paths = side.tabs.map(t => t.path);
    for (const p of paths) moveToMain(p);
  }

  // ---------- 方向 / 比例 ----------
  function setOrient(o) {
    orient = (o === "v") ? "v" : "h";
    localStorage.setItem(ORIENT_KEY, orient);
    localStorage.removeItem(SIZE_WS_KEY());   // 换方向后比例重算
    renderSideTabs();
  }

  // ---------- 行号槽（轻量）----------
  function sideGutter() {
    const ed = $("#side-editor"), g = $("#side-gutter");
    if (!ed || !g) return;
    const n = (ed.value.match(/\n/g) || []).length + 1;
    if (n === sideGutterN) { g.scrollTop = ed.scrollTop; return; }  // 行数不变只同步滚动，免每次按键全量重建
    sideGutterN = n;
    let html = "";
    for (let i = 1; i <= n; i++) html += i + "\n";
    g.textContent = html;
    g.scrollTop = ed.scrollTop;
  }

  // ---------- 保存（副组）----------
  async function save() {
    const t = sideTabByPath(side.active);
    if (!t) return;
    const path = t.path;                       // await 前固定，防存盘往返中切换副组标签存错
    const content = $("#side-editor").value;
    const pkey = t.projectStateKey || projectStateKey(path);
    const url = pkey ? "/api/project-state/save" : "/api/save";
    const body = pkey ? { name: pkey, content } : { path, content };
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => r.json());
    if (res.error) { if (window.setMsg) window.setMsg("保存失败: " + res.error, "err"); return; }
    t.dirty = false; t.draft = content;
    if (side.active === path) side.dirty = false;   // 仅当仍是当前副组标签才清全局副组脏标
    renderSideTabs();
    if (window.setMsg) window.setMsg(`已保存 · ${window.fmtSize ? window.fmtSize(res.size) : res.size + "B"}`, "ok");
    if (pkey && window.reloadProjectMemory) window.reloadProjectMemory();
    if (window.refreshGit) window.refreshGit();     // 原 refreshGitIfActive 未定义
  }

  // ---------- 焦点 ----------
  function setFocus(g) {
    focus = g;
    const cb = $("#content-body");
    if (cb) cb.classList.toggle("side-focused", g === "side" && hasSide());
    if (g === "side") {
      const t = sideTabByPath(side.active);
      if (t && $("#status-file")) $("#status-file").textContent = t.path;
    } else if (wb().current && $("#status-file")) {
      $("#status-file").textContent = wb().current;
    }
    if (window.updateStatusFileAction) window.updateStatusFileAction();
  }

  // ---------- 拖拽分屏：主组标签拖到编辑区 → 落点提示 ----------
  let dropOverlay = null;
  function ensureDropOverlay() {
    if (dropOverlay) return dropOverlay;
    dropOverlay = document.createElement("div");
    dropOverlay.id = "split-drop-overlay";
    const hint = document.createElement("div");
    hint.className = "split-drop-hint";
    dropOverlay.appendChild(hint);
    document.body.appendChild(dropOverlay);
    dropOverlay._hint = hint;
    return dropOverlay;
  }
  function clearSplitHint() {
    if (dropOverlay) { dropOverlay.remove(); dropOverlay = null; }
  }
  // 返回 'right' | 'bottom' | null（指针在编辑区且足够靠边才算）
  function splitDragHint(ev) {
    const cb = $("#content-body");
    if (!cb) return null;
    const r = cb.getBoundingClientRect();
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) {
      clearSplitHint(); return null;
    }
    const fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
    let zone = null, hx = r.left, hy = r.top, hw = r.width, hh = r.height;
    if (fy > 0.62) { zone = "bottom"; hy = r.top + r.height * 0.5; hh = r.height * 0.5; }
    else if (fx > 0.55) { zone = "right"; hx = r.left + r.width * 0.5; hw = r.width * 0.5; }
    if (!zone) { clearSplitHint(); return null; }
    const ov = ensureDropOverlay(), h = ov._hint;
    h.style.left = hx + "px"; h.style.top = hy + "px"; h.style.width = hw + "px"; h.style.height = hh + "px";
    h.textContent = zone === "bottom" ? "在下方打开" : "在右侧打开";
    return zone;
  }
  function splitDrop(path, zone) { clearSplitHint(); moveToSide(path, zone); }

  // ---------- 副组标签拖动：组内重排 / 拖回主组 ----------
  function attachSideTabDrag(el, tab) {
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".tab-close")) return;
      const sx = e.clientX, sy = e.clientY;
      const bar = $("#side-tabbar");
      let dragging = false, dropTarget = null, dropAfter = false, toMain = false;
      function onMove(ev) {
        if (!dragging) {
          if (Math.abs(ev.clientX - sx) < 5 && Math.abs(ev.clientY - sy) < 5) return;
          dragging = true; el.classList.add("tab-dragging"); document.body.style.cursor = "grabbing";
        }
        ev.preventDefault();
        clearSideDrop();
        // 拖到主组标签条 → 移回主组
        const mainBar = $("#tabbar");
        const mr = mainBar ? mainBar.getBoundingClientRect() : null;
        toMain = !!(mr && ev.clientX >= mr.left && ev.clientX <= mr.right && ev.clientY >= mr.top && ev.clientY <= mr.bottom);
        if (mainBar) mainBar.classList.toggle("tab-drop-target", toMain);
        if (toMain) { dropTarget = null; return; }
        dropTarget = null;
        const tabs = [...bar.querySelectorAll(".tab")].filter(t => t !== el);
        for (const t of tabs) {
          const r = t.getBoundingClientRect();
          if (ev.clientX >= r.left && ev.clientX <= r.right) {
            dropTarget = t; dropAfter = (ev.clientX - r.left) > r.width / 2; break;
          }
        }
        if (dropTarget) dropTarget.classList.add(dropAfter ? "tab-drop-after" : "tab-drop-before");
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        document.body.style.cursor = "";
        el.classList.remove("tab-dragging");
        clearSideDrop();
        const mainBar = $("#tabbar"); if (mainBar) mainBar.classList.remove("tab-drop-target");
        if (dragging) {
          const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
          document.addEventListener("click", swallow, { capture: true, once: true });
          setTimeout(() => { try { document.removeEventListener("click", swallow, true); } catch (_) {} }, 80);
          if (toMain) { moveToMain(tab.path); return; }
          if (dropTarget) reorderSide(tab.path, dropTarget.dataset.path, dropAfter);
        }
      }
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });
  }
  function reorderSide(fromPath, toPath, after) {
    if (fromPath === toPath) return;
    const from = side.tabs.findIndex(t => t.path === fromPath);
    if (from < 0) return;
    const [moved] = side.tabs.splice(from, 1);
    let to = side.tabs.findIndex(t => t.path === toPath);
    if (to < 0) { side.tabs.splice(from, 0, moved); return; }
    if (after) to += 1;
    side.tabs.splice(to, 0, moved);
    renderSideTabs();
  }

  // ---------- 比例拖动条 ----------
  function initResizer() {
    const rz = $("#side-resizer");
    if (!rz) return;
    rz.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !hasSide()) return;
      e.preventDefault();
      const cb = $("#content-body"), grp = $("#side-group");
      const ov = document.createElement("div");
      ov.style.cssText = "position:fixed;inset:0;z-index:2147483000;cursor:" + (orient === "v" ? "row-resize" : "col-resize");
      document.body.appendChild(ov);
      function mv(ev) {
        const r = cb.getBoundingClientRect();
        let px = orient === "v" ? (r.bottom - ev.clientY) : (r.right - ev.clientX);
        const max = (orient === "v" ? r.height : r.width) - 120;
        px = Math.max(120, Math.min(px, max));
        grp.style.flex = "0 0 " + px + "px";
        refit();
      }
      function up() {
        ov.removeEventListener("mousemove", mv); window.removeEventListener("mousemove", mv);
        window.removeEventListener("mouseup", up); ov.remove();
        const px = parseInt(grp.style.flex.split(" ").pop(), 10);
        if (px) localStorage.setItem(SIZE_WS_KEY(), px);
        refit();
      }
      ov.addEventListener("mousemove", mv); window.addEventListener("mousemove", mv);
      window.addEventListener("mouseup", up);
    });
  }

  // ---------- 会话恢复 ----------
  async function restore() {
    let data;
    const key = WS_KEY();
    if (!key) return;
    try { data = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) { data = null; }
    if ((!data || !Array.isArray(data.tabs) || !data.tabs.length) && window.currentRoot) {
      try { data = JSON.parse(localStorage.getItem("wb-split:" + window.currentRoot) || "null"); } catch (_) { data = null; }
    }
    if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return;
    restoring = true;
    orient = data.orient === "v" ? "v" : "h";
    for (const p of data.tabs) {
      // 若该文件此刻在主组（app 的会话恢复也开了它）→ 先从主组撤掉，归副组
      const inMain = wb().tabByPath && wb().tabByPath(p);
      let t = null;
      if (inMain) {
        const st = wb().state;
        const i = st.tabs.findIndex(x => x.path === p);
        if (i >= 0) { t = st.tabs.splice(i, 1)[0]; if (st.activeTab === p) st.activeTab = null; }
      }
      const stab = t ? { path: p, name: t.name, ext: t.ext, kind: "text", draft: t.draft || "", dirty: !!t.dirty,
                         projectStateKey: t.projectStateKey || projectStateKey(p) || null }
                     : await loadFromDisk(p);
      if (stab) side.tabs.push(stab);
    }
    // 修复：若移到副组的文件原本是主组当前激活项，主编辑器仍显示它（脏数据）→ 改激活主组剩余标签
    const mst = wb().state;
    if (mst && mst.activeTab == null) {
      if (mst.tabs && mst.tabs.length && wb().activateTab) wb().activateTab(mst.tabs[mst.tabs.length - 1].path);
      else if (wb().closeCurrent) wb().closeCurrent();
    }
    if (wb().renderTabs) wb().renderTabs();
    restoring = false;
    renderSideTabs();
    const act = data.active && sideTabByPath(data.active) ? data.active : (side.tabs[0] && side.tabs[0].path);
    if (act) { activateSide(act, true); setFocus("main"); }  // 恢复后焦点默认主组
  }

  // ---------- 初始化 ----------
  function init() {
    const ed = $("#side-editor");
    if (ed) {
      ed.addEventListener("input", () => {
        if (!side.dirty) side.dirty = true;
        const t = sideTabByPath(side.active);
        if (t && !t.dirty) { t.dirty = true; }
        renderSideTabs();
        sideGutter();
      });
      ed.addEventListener("scroll", () => { const g = $("#side-gutter"); if (g) g.scrollTop = ed.scrollTop; });
      ed.addEventListener("focus", () => setFocus("side"));
      ed.addEventListener("keydown", (e) => {
        // Ctrl+S 由全局处理器按焦点路由（app.js saveRouted），这里不重复绑定，避免双存
        if (e.key === "Tab") {   // Tab 插入两空格，别跳焦点
          e.preventDefault();
          const s = ed.selectionStart, en = ed.selectionEnd;
          ed.value = ed.value.slice(0, s) + "  " + ed.value.slice(en);
          ed.selectionStart = ed.selectionEnd = s + 2;
          ed.dispatchEvent(new Event("input"));
        }
      });
    }
    const mainEd = $("#editor");
    if (mainEd) mainEd.addEventListener("focus", () => setFocus("main"));
    const mainTabbar = $("#tabbar");
    if (mainTabbar) mainTabbar.addEventListener("mousedown", () => setFocus("main"), true);
    initResizer();
    window.addEventListener("resize", () => { if (hasSide()) applyLayout(); });
    // 注意：restore() 不在此自动调用，改由 app.js 在主组 restoreWorkspace 之后显式驱动，
    // 避免两者并发时 renderTabs→saveWorkspace 把 wb-workspace 抢先清空（竞态）。
  }

  // ---------- 生命周期联动（被 app.js 的重命名/删除/切根目录调用）----------
  function hasUnsaved() { return side.dirty || side.tabs.some(t => t.dirty); }
  function snapshot() {
    return {
      tabs: side.tabs.map(t => ({
        path: t.path,
        name: t.name,
        kind: t.kind || "text",
        ext: t.ext || "",
        dirty: !!(t.dirty || (t.path === side.active && side.dirty)),
      })),
      active: side.active,
      orient,
      focus,
      hasSide: hasSide(),
      dirty: hasUnsaved(),
    };
  }
  // 文件/目录被重命名 → 同步副组里受影响的标签路径
  function remapPath(oldPath, newPath, isDir) {
    let changed = false;
    for (const t of side.tabs) {
      if (t.path === oldPath) { t.path = newPath; t.name = newPath.split("/").pop(); changed = true; }
      else if (isDir && t.path.startsWith(oldPath + "/")) {
        t.path = newPath + t.path.slice(oldPath.length); t.name = t.path.split("/").pop(); changed = true;
      }
    }
    if (side.active === oldPath) side.active = newPath;
    else if (isDir && side.active && side.active.startsWith(oldPath + "/"))
      side.active = newPath + side.active.slice(oldPath.length);
    if (changed) renderSideTabs();   // renderSideTabs 内部已 persist
  }
  // 文件/目录被删除 → 关掉副组里受影响的标签（含仅存在于副组的情况）
  function dropPath(path, isDir) {
    const affected = (p) => p === path || (isDir && p.startsWith(path + "/"));
    const before = side.tabs.length;
    const removingActive = side.active && affected(side.active);
    side.tabs = side.tabs.filter(t => !affected(t.path));
    if (side.tabs.length === before) return;   // 副组未受影响
    if (removingActive) {
      side.active = null; side.dirty = false;
      const nx = side.tabs[side.tabs.length - 1] || null;
      if (nx) activateSide(nx.path, true); else setFocus("main");
    }
    renderSideTabs();
  }
  // 切换工作根目录 → 整组清空（内存）。localStorage 的旧根分区保留不动，
  // 这样下次切回旧根还能 restore 出原来的副组标签（同主组 saveWorkspace 的语义）。
  function reset() {
    // 先把当前副组状态存到旧根 key（切根前留档），再清内存
    persist();
    side.tabs = []; side.active = null; side.dirty = false;
    const ed = $("#side-editor"); if (ed) ed.value = "";
    setFocus("main");
    sideGutterN = -1;
    sideGutter();
    // 不调 renderSideTabs（它会 persist 空数组覆盖刚留的档）；直接收起布局
    applyLayout();
  }

  // ---------- 对外接口 ----------
  window.split = {
    splitDragHint, clearSplitHint, splitDrop, moveToSide, moveToMain, restore,
    isSideFocused: () => focus === "side" && hasSide(),
    hasSide, save, focus: () => focus,
    has: (p) => !!sideTabByPath(p),       // 该文件是否在副组
    activate: (p) => activateSide(p),      // 切到副组里的该文件
    remapPath, dropPath, reset, hasUnsaved, snapshot,   // 生命周期联动
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
