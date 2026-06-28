/* Workbench 集成终端（xterm.js + 后端持久 shell，VS Code 风格多终端 + 拆分）
   —— 模型：groups[] / panes ——
   - 每个「组(group)」对应右侧列表的一行；组内含 1+ 个「窗格(pane)」。
   - 每个窗格是一个独立 xterm + 一个独立后端 shell 会话（/api/term/open 起的会话）。
   - 单窗格组 = 普通终端；拆分(Split) = 给活动组加一个并排窗格（独立进程）。
   - 同一时刻只显示「活动组」，组内多窗格在挂载区横向并排、可拖拽竖直分隔条调宽。
   - 右侧列表点击行 → 切组；hover 行出 × → 关组。工具栏分裂按钮新建组、拆分按钮加窗格。
   命令仅在服务器本机（127.0.0.1）执行，写操作复用 fsPost 的 CSRF。
   消费后端协议 /api/term/*（后端本就支持多会话，拆分=多开会话并存）。 */
(function () {
  const $ = (s) => document.querySelector(s);

  // 可运行的扩展名（与后端 RUN_INTERPRETERS 对应的常用集合）
  const RUNNABLE = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".bash", ".ps1"]);
  const extOf = (name) => {
    const i = (name || "").lastIndexOf(".");
    return i >= 0 ? name.slice(i).toLowerCase() : "";
  };
  window.wbIsRunnable = (path) => RUNNABLE.has(extOf(path || ""));

  // ---------- 状态：组 / 窗格 ----------
  // pane:  {pid, shell, term, fit, host, offset, poll, alive, reading, opening,
  //         ro, lastCols, lastRows}
  //   pid = 后端会话 id（/api/term/open 返回）。
  // group: {gid, num, panes:[pane], activePid, host(.term-group), basis:{pid:flex}}
  const groups = [];        // 组数组（顺序即列表顺序）
  let activeGid = null;     // 当前活动组本地 id
  let gseq = 0;             // 组编号（列表行显示 "1: PowerShell"）
  let localSeq = 0;         // 本地唯一 id 生成器（组/窗格用）
  let shells = [];          // /api/term/shells 结果
  let shellsLoaded = false;
  let defaultShellId = null; // 工具栏 + 主体默认 shell（最近一次新建/选择的）
  let listForced = false;    // 用户是否手动开了列表（即使只剩 1 个组也保持显示）
  let workspaceOpen = typeof window.hasOpenWorkspace === "function" ? window.hasOpenWorkspace() : true;

  function panel() { return $("#terminal-panel"); }
  function isCollapsed() { return panel().classList.contains("collapsed"); }
  function hasWorkspace() {
    return typeof window.hasOpenWorkspace === "function" ? window.hasOpenWorkspace() : workspaceOpen;
  }
  function requireWorkspace(action) {
    if (hasWorkspace()) return true;
    if (window.setMsg) setMsg((action ? action + "需要" : "请先打开") + "工作区", "warn");
    return false;
  }
  function activeGroup() { return groups.find(g => g.gid === activeGid) || null; }
  function groupById(gid) { return groups.find(g => g.gid === gid) || null; }
  function activePane() {
    const g = activeGroup();
    if (!g) return null;
    return g.panes.find(p => p.pid === g.activePid) || g.panes[0] || null;
  }
  function allPanes() { const a = []; groups.forEach(g => g.panes.forEach(p => a.push(p))); return a; }

  function terminalActionState(action) {
    const needsWorkspace = ["new", "split", "runCurrentFile", "createTask", "runTask"];
    if ((needsWorkspace.includes(action) || (action === "toggle" && isCollapsed())) && !hasWorkspace()) {
      return { enabled: false, reason: "请先打开工作区" };
    }
    if ((action === "new" || action === "split") && !hasXterm()) {
      return { enabled: false, reason: "终端组件尚未加载" };
    }
    if (action === "runCurrentFile") {
      const path = window.state && state.current;
      if (!path) return { enabled: false, reason: "当前没有打开文件" };
      if (window.state && state.kind !== "text") return { enabled: false, reason: "当前文件不是可运行文本文件" };
      if (!window.wbIsRunnable(path)) return { enabled: false, reason: "该文件类型不支持运行" };
    }
    if (action === "runTask") {
      if (tasksLoaded && !hasTerminalTasks()) return { enabled: false, reason: "无可运行任务" };
      if (!selectedTerminalTask()) return { enabled: false, reason: "请先选择一个终端任务" };
    }
    if (action === "createTask" && !window.addWorkflowTask) {
      return { enabled: false, reason: "任务面板尚未就绪" };
    }
    return { enabled: true, reason: "" };
  }

  function setTerminalButtonState(btn, state, enabledTitle) {
    if (!btn) return;
    btn.disabled = !state.enabled;
    btn.setAttribute("aria-disabled", state.enabled ? "false" : "true");
    btn.classList.toggle("disabled", !state.enabled);
    btn.title = state.enabled ? enabledTitle : (state.reason || "当前不可用");
  }

  async function runTerminalAction(action) {
    if (action === "runTask" && !tasksLoaded) await loadTasks(false);
    const st = terminalActionState(action);
    if (!st.enabled) {
      if (window.setMsg) setMsg(st.reason || "当前不可用", "warn");
      return false;
    }
    if (action === "toggle") { toggle(); return true; }
    if (action === "new") {
      hideShellMenu();
      expand();
      await newGroup(selectedShellId());
      return true;
    }
    if (action === "split") { await splitActive(); return true; }
    if (action === "runCurrentFile") { await runFile(window.state && state.current); return true; }
    if (action === "runTask") {
      const task = selectedTerminalTask();
      if (task) await runTask(task.name, task.kind);
      return true;
    }
    if (action === "createTask") { await createTerminalWorkflowTask(); return true; }
    return false;
  }

  window.wbTerminalActions = {
    actionState: terminalActionState,
    run: runTerminalAction,
    summary: () => ({
      hasWorkspace: hasWorkspace(),
      collapsed: isCollapsed(),
      groups: groups.length,
      activeGroup: activeGid,
      activePane: activePane() ? activePane().pid : null,
      selectedTask: selectedTerminalTask(),
    }),
  };

  // ---------- base64 解码为字节 ----------
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------- 主题取色（读 style.css 的 CSS 变量） ----------
  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch { return fallback; }
  }
  function termTheme() {
    return {
      background: cssVar("--bg", "#0d0d0f"),
      foreground: cssVar("--text", "#ececee"),
      cursor: cssVar("--accent", "#3fb96f"),
      cursorAccent: cssVar("--bg", "#0d0d0f"),
      selectionBackground: cssVar("--sel", "#26262b"),
      black: cssVar("--bg3", "#050506"),
      red: cssVar("--danger", "#f0606d"),
      green: cssVar("--accent", "#3fb96f"),
      yellow: cssVar("--warn", "#e0a93c"),
      blue: cssVar("--cyan", "#4db8c4"),
      magenta: cssVar("--purple", "#b48ead"),
      cyan: cssVar("--cyan", "#4db8c4"),
      white: cssVar("--text-dim", "#c2c2c6"),
      brightBlack: cssVar("--muted", "#6c6c74"),
      brightRed: cssVar("--danger", "#f0606d"),
      brightGreen: cssVar("--accent2", "#4ec479"),
      brightYellow: cssVar("--warn", "#e0a93c"),
      brightBlue: cssVar("--cyan", "#4db8c4"),
      brightMagenta: cssVar("--purple", "#b48ead"),
      brightCyan: cssVar("--cyan", "#4db8c4"),
      brightWhite: cssVar("--text", "#ececee"),
    };
  }

  // ---------- xterm 是否可用 ----------
  function hasXterm() { return typeof window.Terminal === "function"; }
  function getFitAddon() {
    const F = window.FitAddon;
    if (!F) return null;
    return F.FitAddon || F;
  }

  // shell → 图标名（沿用 icons.js 现有图标）
  function shellIcon(id) {
    switch (id) {
      case "powershell": return "terminal";
      case "cmd": return "terminal";
      case "gitbash": return "git";
      case "wsl": return "terminal";
      default: return "terminal";
    }
  }

  // ---------- 折叠/展开 ----------
  function setCollapsed(v) {
    panel().classList.toggle("collapsed", v);
    const tw = $("#term-collapse");
    if (tw) tw.classList.toggle("up", !v);
    const st = $("#status-term");
    if (st) st.classList.toggle("active", !v);
    if (!v) {
      // 展开：按停靠偏好应用「底部/右侧」，再确保有终端 + fit + 聚焦 + 续轮询
      applyDock(dockPrefRight());
      updateDockBtn(dockPrefRight());
      ensureSession().then(() => {
        const g = activeGroup();
        relayoutGroup(g);
        const p = activePane();
        if (p && p.term) setTimeout(() => { try { p.term.focus(); } catch {} }, 0);
        startGroupPoll(g);
      });
    } else {
      // 折叠：退出"铺满"、回到底部细条（去掉右停靠类与内联宽度），暂停所有窗格轮询
      setMaxed(false);
      termContent()?.classList.remove("term-dock-right");
      const pn = $("#terminal-panel"); if (pn) pn.style.width = "";
      allPanes().forEach(stopPoll);
    }
  }
  function expand() { if (isCollapsed()) setCollapsed(false); }
  function toggle() {
    if (isCollapsed() && !requireWorkspace("打开终端")) return;
    setCollapsed(!isCollapsed());
  }
  window.toggleTerminal = toggle;
  window.openTerminal = expand;

  // ---------- 铺满文件区（终端向上占满 #content，文件区暂时隐藏）----------
  function termContent() { return document.getElementById("content"); }
  function isMaxed() { const c = termContent(); return !!(c && c.classList.contains("term-maxed")); }
  function setMaxed(v) {
    const c = termContent();
    if (!c) return;
    if (v) expand();                       // 铺满前先确保展开
    c.classList.toggle("term-maxed", v);
    const b = $("#term-maximize");
    if (b) {
      const ic = b.querySelector(".i");
      if (ic && window.svgIcon) ic.innerHTML = window.svgIcon(v ? "winRestore" : "winMax", 16);
      b.title = v ? "还原终端高度" : "向上铺满文件区";
      b.classList.toggle("active", v);
    }
    if (typeof window.termRefit === "function") { try { window.termRefit(); } catch {} }
  }
  // 经 applyDockZone 路由，保证「铺满」与「靠右停靠」互斥（不再共存出坏布局）
  function toggleMaxed() { applyDockZone(isMaxed() ? "bottom" : "fill"); }
  window.toggleTerminalMax = toggleMaxed;

  // ---------- 停靠位置：底部 / 右侧（与文件区并排）----------
  function dockPrefRight() { try { return localStorage.getItem("wb-term-dock") === "right"; } catch (_) { return false; } }
  function applyDock(v) {
    const c = termContent(); const panel = $("#terminal-panel");
    if (!c) return;
    if (panel) { panel.style.height = ""; panel.style.width = ""; }   // 清掉另一方向的内联尺寸
    c.classList.toggle("term-dock-right", v);
    if (panel) {
      // clamp 持久化尺寸到当前视口：跨分辨率恢复时别把终端铺到超出屏幕、挤没编辑区
      if (v) {
        let w = parseInt(localStorage.getItem("wb-term-w") || "", 10);
        if (w) { w = Math.max(120, Math.min(w, Math.round(window.innerWidth * 0.85))); panel.style.width = w + "px"; }
      } else {
        let h = parseInt(localStorage.getItem("wb-term-h") || "", 10);
        if (h) { h = Math.max(80, Math.min(h, Math.round(window.innerHeight * 0.85))); panel.style.height = h + "px"; }
      }
    }
    if (typeof window.termRefit === "function") { try { window.termRefit(); } catch {} }
  }
  function updateDockBtn(v) {
    const b = $("#term-dock");
    if (b) { b.classList.toggle("active", v); b.title = v ? "终端停靠：右侧（点击回到底部）" : "终端停靠：底部（点击移到右侧）"; }
  }
  function setDockRight(v) {
    try { localStorage.setItem("wb-term-dock", v ? "right" : "bottom"); } catch (_) {}
    updateDockBtn(v);
    if (isCollapsed()) { expand(); return; }   // 折叠态：展开（展开过程里按 pref 应用靠右）
    applyDock(v);
  }
  function toggleDock() { applyDockZone(dockPrefRight() ? "bottom" : "right"); }   // 同样经 applyDockZone 保证与铺满互斥
  window.toggleTerminalDock = toggleDock;

  // ---------- 拖终端头 → 拖到编辑区铺满 / 并排 / 回底部（仿 VS Code 拖拽停靠）----------
  function applyDockZone(z) {
    if (z === "fill")       { setDockRight(false); setMaxed(true); }   // 铺满编辑区
    else if (z === "right") { setMaxed(false); setDockRight(true); }   // 并排到右侧
    else                    { setMaxed(false); setDockRight(false); }  // 回到底部
  }
  function attachHeadDockDrag() {
    const head = $("#term-head");
    if (!head) return;
    head.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // 工具栏/按钮/下拉/任务区/输入框 等交给各自处理，不当拖动
      if (e.target.closest("button") || e.target.closest("select") ||
          e.target.closest(".term-toolbar") || e.target.closest(".term-shell-menu") ||
          e.target.closest(".term-task-wrap") || e.target.closest("input")) return;
      if (isCollapsed()) return;
      const content = termContent();
      if (!content) return;
      const sx = e.clientX, sy = e.clientY;
      let dragging = false, overlay = null, hint = null, label = null, zone = "bottom";
      function ensureOverlay() {
        overlay = document.createElement("div");
        overlay.id = "term-dock-overlay";
        hint = document.createElement("div");
        hint.className = "term-dock-hint";
        label = document.createElement("div");
        label.className = "term-dock-hint-label";
        hint.appendChild(label);
        overlay.appendChild(hint);
        document.body.appendChild(overlay);
      }
      function zoneFor(ev) {
        const r = content.getBoundingClientRect();
        const fx = (ev.clientX - r.left) / r.width;
        const fy = (ev.clientY - r.top) / r.height;
        if (fy > 0.78) return "bottom";
        if (fx > 0.62) return "right";
        return "fill";
      }
      function placeHint(z) {
        const r = content.getBoundingClientRect();
        let x = r.left, y = r.top, w = r.width, h = r.height, text = "铺满编辑区";
        if (z === "right") { x = r.left + r.width * 0.5; w = r.width * 0.5; text = "并排到右侧"; }
        else if (z === "bottom") { y = r.top + r.height * 0.7; h = r.height * 0.3; text = "停靠到底部"; }
        hint.style.left = x + "px"; hint.style.top = y + "px";
        hint.style.width = w + "px"; hint.style.height = h + "px";
        label.textContent = text;
      }
      function onMove(ev) {
        if (!dragging) {
          if (Math.abs(ev.clientX - sx) < 6 && Math.abs(ev.clientY - sy) < 6) return;
          dragging = true; ensureOverlay(); document.body.style.cursor = "grabbing";
        }
        ev.preventDefault();
        zone = zoneFor(ev);
        placeHint(zone);
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        document.body.style.cursor = "";
        if (overlay) overlay.remove();
        if (dragging) {
          const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
          document.addEventListener("click", swallow, { capture: true, once: true });
          setTimeout(() => { try { document.removeEventListener("click", swallow, true); } catch (_) {} }, 80);
          applyDockZone(zone);
        }
      }
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });
  }

  // 兼容旧 API：把信息以一行文本写进当前聚焦窗格（不再渲染 HTML 块）
  function termAppend(info) {
    if (!info) return;
    const p = activePane();
    if (!p || !p.term) return;
    const parts = [];
    if (info.cmd) parts.push(info.cmd);
    if (info.note) parts.push(info.note);
    if (info.stdout) parts.push(info.stdout);
    if (info.stderr) parts.push(info.stderr);
    const text = parts.join("\r\n");
    if (text) p.term.write("\r\n" + text.replace(/\n/g, "\r\n") + "\r\n");
  }
  window.termAppend = termAppend;

  function setCwdLabel(cwd) {
    const el = $("#term-cwd");
    if (el) el.textContent = cwd ? "/" + cwd : "/";
  }

  // ---------- shell 列表 ----------
  async function loadShells(force) {
    if (shellsLoaded && !force) return shells;
    try {
      const data = await fetch("/api/term/shells", { cache: "no-store" }).then(r => r.json());
      shells = Array.isArray(data.shells) ? data.shells : [];
    } catch {
      shells = [];
    }
    shellsLoaded = true;
    if (!defaultShellId) {
      const first = shells.find(s => s.exists);
      defaultShellId = first ? first.id : "powershell";
    }
    renderShellMenu();
    return shells;
  }

  function selectedShellId() {
    if (defaultShellId) return defaultShellId;
    const first = shells.find(s => s.exists);
    return first ? first.id : "powershell";
  }
  function shellNameOf(id) {
    const sh = shells.find(s => s.id === id);
    return sh ? sh.name : (id || "Shell");
  }

  // shell 下拉菜单（点分裂按钮的下拉箭头弹出）
  function renderShellMenu() {
    const menu = $("#term-shell-menu");
    if (!menu) return;
    menu.innerHTML = "";
    if (!shells.length) {
      const o = document.createElement("div");
      o.className = "term-shell-item disabled";
      o.textContent = "无可用 Shell";
      menu.appendChild(o);
      return;
    }
    shells.forEach((sh) => {
      const it = document.createElement("div");
      it.className = "term-shell-item" + (sh.exists ? "" : " disabled");
      it.innerHTML = svgIcon(shellIcon(sh.id), 14) +
        "<span>" + (sh.exists ? sh.name : sh.name + "（未安装）") + "</span>";
      if (sh.exists) {
        it.onclick = () => {
          hideShellMenu();
          defaultShellId = sh.id;
          updateToolbar();
          expand();
          newGroup(sh.id);
        };
      }
      menu.appendChild(it);
    });
  }
  function showShellMenu() { const m = $("#term-shell-menu"); if (m) m.classList.remove("hidden"); }
  function hideShellMenu() { const m = $("#term-shell-menu"); if (m) m.classList.add("hidden"); }
  function toggleShellMenu() {
    const m = $("#term-shell-menu");
    if (!m) return;
    if (m.classList.contains("hidden")) showShellMenu(); else hideShellMenu();
  }

  // ---------- 工具栏：当前 shell 名 + 列表显隐态 ----------
  function updateToolbar() {
    const as = $("#term-active-shell");
    if (as) {
      const p = activePane();
      // 没有活动终端时清空（CSS :empty 隐藏），避免误显示一个并不存在的 shell
      if (!p) as.innerHTML = "";
      else as.innerHTML = svgIcon(shellIcon(p.shell), 14) + "<span>" + shellNameOf(p.shell) + "</span>";
    }
    const lt = $("#term-list-toggle");
    const list = $("#term-list");
    if (lt && list) lt.classList.toggle("on", !list.classList.contains("hidden"));
    const hasWs = hasWorkspace();
    const wsReason = "请先打开工作区";
    const setBtn = (sel, enabledTitle, enabled) => {
      const btn = $(sel);
      if (!btn) return;
      setTerminalButtonState(btn, {
        enabled: !!(hasWs && enabled),
        reason: hasWs ? "当前没有活动终端" : wsReason,
      }, enabledTitle);
    };
    const newState = terminalActionState("new");
    setTerminalButtonState($("#term-new"), newState, "新建终端");
    setTerminalButtonState($("#term-new-caret"), newState, "选择 Shell 新建终端");
    setBtn("#term-dock", "终端停靠：底部 / 右侧", true);
    setBtn("#term-maximize", "向上铺满文件区 / 还原", true);
    setBtn("#term-list-toggle", "切换终端列表", true);
    setBtn("#term-clear", "清屏（仅当前窗格）", !!activeGroup());
    const toggleState = terminalActionState("toggle");
    const collapse = $("#term-collapse");
    if (collapse) {
      setTerminalButtonState(collapse, toggleState, "折叠 / 展开");
    }
    const splitBtn = $("#term-split"), killBtn = $("#term-kill");
    if (splitBtn) {
      const splitState = terminalActionState("split");
      setTerminalButtonState(splitBtn, splitState, "拆分终端 (Ctrl+Shift+5)");
    }
    if (killBtn) {
      setTerminalButtonState(killBtn, {
        enabled: !!(hasWs && activeGroup()),
        reason: hasWs ? "当前没有活动终端" : wsReason,
      }, "关闭当前终端");
    }
    updateStatusTermState();
  }

  function updateStatusTermState() {
    const st = $("#status-term");
    if (!st) return;
    const actionState = terminalActionState("toggle");
    st.classList.toggle("status-clickable", actionState.enabled);
    st.classList.toggle("disabled", !actionState.enabled);
    st.setAttribute("role", "button");
    st.setAttribute("aria-disabled", actionState.enabled ? "false" : "true");
    st.tabIndex = actionState.enabled ? 0 : -1;
    st.title = actionState.enabled ? "切换终端面板" : (actionState.reason || "当前不可用");
  }

  // ---------- 右侧列表渲染 ----------
  function shouldShowList() {
    // ≥2 组 或 用户手动开启 → 显示
    return listForced || groups.length >= 2;
  }
  function applyListVisibility() {
    const list = $("#term-list");
    if (!list) return;
    list.classList.toggle("hidden", !shouldShowList());
    updateToolbar();
    // 列表显隐改变了挂载区宽度 → 重排活动组
    relayoutGroup(activeGroup());
  }
  // 终端默认名（num: shell）；自定义名存 g.customName
  function defaultGroupName(g) {
    const ap = g.panes.find(p => p.pid === g.activePid) || g.panes[0];
    return g.num + ": " + (ap ? shellNameOf(ap.shell) : "Shell");
  }
  function groupDisplayName(g) { return g.customName || defaultGroupName(g); }

  function renderList() {
    const list = $("#term-list");
    if (!list) return;
    list.innerHTML = "";
    groups.forEach((g) => {
      const ap = g.panes.find(p => p.pid === g.activePid) || g.panes[0];
      const allDead = g.panes.length > 0 && g.panes.every(p => !p.alive && !p.opening);
      const dispName = groupDisplayName(g);
      const row = document.createElement("div");
      row.className = "term-list-row" + (g.gid === activeGid ? " active" : "")
                    + (allDead ? " dead" : "");
      row.title = dispName
                + (g.panes.length > 1 ? "（已拆分 ×" + g.panes.length + "）" : "")
                + " · 双击重命名 · 可拖动重排";
      row.dataset.gid = String(g.gid);
      const ico = document.createElement("span");
      ico.className = "term-list-ico";
      ico.innerHTML = svgIcon(shellIcon(ap ? ap.shell : "powershell"), 14);
      const label = document.createElement("span");
      label.className = "term-list-label";
      label.textContent = dispName;
      label.addEventListener("dblclick", (e) => { e.stopPropagation(); startRenameRow(g, row, label); });
      row.appendChild(ico);
      row.appendChild(label);
      if (g.panes.length > 1) {
        const badge = document.createElement("span");
        badge.className = "term-list-split-badge";
        badge.textContent = "⊟" + g.panes.length;
        badge.title = "该终端已拆分为 " + g.panes.length + " 个窗格";
        row.appendChild(badge);
      }
      const x = document.createElement("button");
      x.className = "term-list-x";
      x.title = "关闭此终端";
      x.innerHTML = svgIcon("close", 13);
      x.onclick = (e) => { e.stopPropagation(); closeGroup(g.gid); };
      row.appendChild(x);
      row.onclick = () => switchToGroup(g.gid);
      attachRowDnd(g, row);
      list.appendChild(row);
    });
  }

  // ---- 双击重命名某终端 ----
  function startRenameRow(g, row, label) {
    row.draggable = false;                 // 编辑时禁拖，方便选字
    const input = document.createElement("input");
    input.className = "term-list-rename";
    input.value = groupDisplayName(g);
    input.spellcheck = false;
    row.replaceChild(input, label);
    input.focus(); input.select();
    let done = false;
    function commit(save) {
      if (done) return; done = true;
      if (save) {
        const v = input.value.trim();
        // 空 或 与默认名相同 → 清除自定义名，回到自动命名
        g.customName = (v && v !== defaultGroupName(g)) ? v : null;
      }
      renderList();
    }
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("dblclick", (e) => e.stopPropagation());
  }

  // ---- 指针拖动终端条重排顺序（用 mouse 事件；WebView2 下比 HTML5 原生拖放可靠得多）----
  function clearDropMarks() {
    const list = $("#term-list");
    if (list) list.querySelectorAll(".term-list-row").forEach(r => r.classList.remove("drop-before", "drop-after"));
  }
  function attachRowDnd(g, row) {
    row.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".term-list-x") || e.target.closest(".term-list-rename")) return;
      const startY = e.clientY;
      const list = $("#term-list");
      let dragging = false, dropTarget = null, dropAfter = false;
      function onMove(ev) {
        if (!dragging) {
          if (Math.abs(ev.clientY - startY) < 4) return;   // 超阈值才算拖动（保留单击切换）
          dragging = true;
          row.classList.add("dragging");
          document.body.style.cursor = "grabbing";
        }
        ev.preventDefault();
        clearDropMarks();
        dropTarget = null;
        const rows = [...list.querySelectorAll(".term-list-row")].filter(r => r !== row);
        for (const r of rows) {
          const rect = r.getBoundingClientRect();
          if (ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
            dropTarget = r; dropAfter = (ev.clientY - rect.top) > rect.height / 2; break;
          }
        }
        if (!dropTarget && rows.length) {   // 指针在列表上/下方 → 放到首/尾
          const first = rows[0].getBoundingClientRect(), last = rows[rows.length - 1].getBoundingClientRect();
          if (ev.clientY < first.top) { dropTarget = rows[0]; dropAfter = false; }
          else if (ev.clientY > last.bottom) { dropTarget = rows[rows.length - 1]; dropAfter = true; }
        }
        if (dropTarget) dropTarget.classList.add(dropAfter ? "drop-after" : "drop-before");
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        document.body.style.cursor = "";
        row.classList.remove("dragging");
        clearDropMarks();
        if (dragging) {
          // 吞掉拖动后紧跟的那次 click，避免误触切换组
          const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
          document.addEventListener("click", swallow, { capture: true, once: true });
          setTimeout(() => { try { document.removeEventListener("click", swallow, true); } catch (_) {} }, 80);
          if (dropTarget) {
            const toGid = Number(dropTarget.dataset.gid);
            if (!Number.isNaN(toGid)) reorderGroup(g.gid, toGid, dropAfter);
          }
        }
      }
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });
  }
  function reorderGroup(fromGid, toGid, after) {
    const fromIdx = groups.findIndex(x => x.gid === fromGid);
    if (fromIdx < 0) return;
    const [moved] = groups.splice(fromIdx, 1);
    let toIdx = groups.findIndex(x => x.gid === toGid);
    if (toIdx < 0) { groups.splice(fromIdx, 0, moved); return; }
    if (after) toIdx += 1;
    groups.splice(toIdx, 0, moved);
    renderList();
  }

  // ---------- 创建一个窗格（xterm + host + 后端会话） ----------
  function makePaneHost(group) {
    const host = document.createElement("div");
    host.className = "term-pane";
    group.host.appendChild(host);
    return host;
  }

  function dimsOf(p) {
    if (p && p.term && p.term.cols && p.term.rows) {
      return { cols: p.term.cols, rows: p.term.rows };
    }
    return { cols: 80, rows: 24 };
  }

  // 渲染活动组（横向并排窗格 + 窗格间分隔条），隐藏非活动组
  function showOnlyGroup(gid) {
    groups.forEach((g) => { g.host.classList.toggle("hidden", g.gid !== gid); });
  }

  // 重建某组挂载区内的「窗格 + 分隔条」DOM 顺序（窗格 host 已各自在 group.host 内）
  function relayoutPanes(group) {
    if (!group) return;
    // 清除旧分隔条
    Array.from(group.host.querySelectorAll(".term-pane-splitter")).forEach(s => s.remove());
    // 按 panes 顺序确保窗格在 host 内排好，并在相邻窗格间插分隔条
    group.panes.forEach((p, i) => {
      // 应用持久的 flex basis（拖拽宽度）
      if (group.basis && group.basis[p.pid] != null) {
        p.host.style.flex = "0 0 " + group.basis[p.pid] + "px";
      } else {
        p.host.style.flex = "1 1 0";
      }
      group.host.appendChild(p.host);
      if (i < group.panes.length - 1) {
        const sp = document.createElement("div");
        sp.className = "term-pane-splitter";
        bindPaneSplitter(sp, group, p);
        group.host.appendChild(sp);
      }
    });
    // 重新追加焦点高亮类
    updatePaneFocusClass(group);
  }

  function updatePaneFocusClass(group) {
    if (!group) return;
    group.panes.forEach((p) => {
      // p.pid != null：两个窗格同时开启时(都 pid=null, activePid=null) null===null 会误高亮两个，加此守卫
      if (p.host) p.host.classList.toggle("focused",
        group.panes.length > 1 && p.pid != null && p.pid === group.activePid);
    });
  }

  // 在指定组里新开一个窗格（独立后端会话）
  async function newPane(group, shellId) {
    if (!requireWorkspace("新建终端")) return null;
    if (!hasXterm()) return null;
    await loadShells();
    shellId = shellId || selectedShellId();

    const host = makePaneHost(group);
    const term = new window.Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.1,
      scrollback: 5000,
      theme: termTheme(),
      allowProposedApi: true,
    });
    const FitAddon = getFitAddon();
    let fit = null;
    if (FitAddon) { try { fit = new FitAddon(); term.loadAddon(fit); } catch { fit = null; } }
    term.open(host);

    const pane = {
      pid: null, shell: shellId, term, fit, host,
      offset: 0, poll: null, alive: false, reading: false, opening: false,
      ro: null, lastCols: 0, lastRows: 0, gid: group.gid,
    };
    term.onData((d) => {
      if (pane.pid != null) fsPost("/api/term/input", { id: pane.pid, data: d }).catch(() => {});
    });
    // 点击/聚焦该窗格 → 设为组内活动窗格
    host.addEventListener("mousedown", () => focusPane(group, pane));
    try { term.textarea && term.textarea.addEventListener("focus", () => focusPane(group, pane)); } catch {}

    group.panes.push(pane);
    group.activePid = pane.pid; // 临时（pid 还没拿到，先标记目标）
    relayoutPanes(group);
    try { if (fit) fit.fit(); } catch {}

    const { cols, rows } = dimsOf(pane);
    pane.opening = true;
    let ok = false;
    try {
      const res = await fsPost("/api/term/open", { shell: shellId, cols, rows });
      if (res && res.id != null && !res.error) {
        pane.pid = res.id; pane.offset = 0; pane.alive = true; ok = true;
      } else {
        const why = (res && res.error) ? res.error : "无法启动会话";
        term.write("\r\n\x1b[31m[启动失败] " + why + "\x1b[0m\r\n");
      }
    } catch (e) {
      term.write("\r\n\x1b[31m[启动失败] " + (e && e.message ? e.message : e) + "\x1b[0m\r\n");
    } finally {
      pane.opening = false;
    }

    if (!ok) {
      removePaneLocal(group, pane);
      return null;
    }
    // open 的 await 期间该窗格/组可能已被关闭：那时 pane.pid 还是 null，关闭逻辑没关后端会话。
    // 现在才拿到 pid → 主动补关后端会话，且不再起轮询，避免孤儿 shell + setInterval 泄漏。
    if (!groupById(group.gid) || group.panes.indexOf(pane) < 0) {
      fsPost("/api/term/close", { id: pane.pid }).catch(() => {});
      try { term.dispose(); } catch {}
      return null;
    }
    group.activePid = pane.pid;
    relayoutPanes(group);
    relayoutGroup(group);
    startPoll(pane);
    attachResizeObserver(pane);
    return pane;
  }

  // 新建一个组（默认含 1 个窗格），并设为活动
  async function newGroup(shellId) {
    if (!requireWorkspace("新建终端")) return null;
    if (!hasXterm()) {
      const host = $("#term-xterm");
      if (host && !groups.length) host.textContent = "终端组件未加载（xterm.js 缺失）";
      return null;
    }
    await loadShells();
    shellId = shellId || selectedShellId();
    defaultShellId = shellId;

    const gid = ++localSeq;
    const num = ++gseq;
    const ghost = document.createElement("div");
    ghost.className = "term-group";
    $("#term-xterm").appendChild(ghost);
    const group = { gid, num, customName: null, panes: [], activePid: null, host: ghost, basis: {} };
    groups.push(group);

    // 先激活并显示（即便后端还在开，UI 已就绪）
    activeGid = gid;
    showOnlyGroup(gid);

    const pane = await newPane(group, shellId);
    if (!pane) {
      // 开失败：移除该组
      removeGroupLocal(group);
      if (groups.length) { activeGid = groups[groups.length - 1].gid; switchToGroup(activeGid); }
      else { activeGid = null; renderList(); applyListVisibility(); updateToolbar(); }
      return null;
    }
    group.activePid = pane.pid;
    renderList();
    applyListVisibility();
    updateToolbar();
    relayoutGroup(group);
    setTimeout(() => { try { pane.term.focus(); } catch {} }, 0);
    return group;
  }

  // 拆分：给活动组加一个并排窗格
  async function splitActive() {
    if (!requireWorkspace("拆分终端")) return;
    expand();
    // 等首个组就绪（避免在初始化窗口内点拆分丢失活动组）
    await ensureSession();
    const g = activeGroup();
    if (!g) { await newGroup(selectedShellId()); return; }
    // 用活动窗格的 shell（贴合 VS Code：拆出来同 shell）
    const ap = g.panes.find(p => p.pid === g.activePid) || g.panes[0];
    const shellId = ap ? ap.shell : selectedShellId();
    const pane = await newPane(g, shellId);
    if (pane) {
      focusPane(g, pane);
      renderList();
      relayoutGroup(g);
      setTimeout(() => { try { pane.term.focus(); } catch {} }, 0);
    }
  }

  // 设组内活动窗格
  function focusPane(group, pane) {
    if (!group || !pane) return;
    if (group.activePid === pane.pid) { updatePaneFocusClass(group); return; }
    group.activePid = pane.pid;
    updatePaneFocusClass(group);
    updateToolbar();
  }

  // 本地销毁一个窗格（不通知后端）
  function removePaneLocal(group, pane) {
    stopPoll(pane);
    if (pane.ro) { try { pane.ro.disconnect(); } catch {} pane.ro = null; }
    if (pane.term) { try { pane.term.dispose(); } catch {} pane.term = null; }
    if (pane.host && pane.host.parentElement) pane.host.parentElement.removeChild(pane.host);
    if (group.basis) delete group.basis[pane.pid];
    const i = group.panes.indexOf(pane);
    if (i >= 0) group.panes.splice(i, 1);
  }

  // 关闭一个窗格（通知后端 + 本地移除）。若是组内最后一个 → 关整组。
  async function closePane(group, pane) {
    if (!group || !pane) return;
    if (group.panes.length <= 1) { return closeGroup(group.gid); }
    const idx = group.panes.indexOf(pane);
    if (pane.pid != null) { try { await fsPost("/api/term/close", { id: pane.pid }); } catch {} }
    removePaneLocal(group, pane);
    if (group.activePid === pane.pid || !group.panes.find(p => p.pid === group.activePid)) {
      const next = group.panes[idx] || group.panes[idx - 1] || group.panes[0];
      group.activePid = next ? next.pid : null;
    }
    relayoutPanes(group);
    relayoutGroup(group);
    renderList();
    updateToolbar();
    const np = group.panes.find(p => p.pid === group.activePid);
    if (np && np.term) setTimeout(() => { try { np.term.focus(); } catch {} }, 0);
  }

  // 本地销毁整组
  function removeGroupLocal(group) {
    group.panes.slice().forEach(p => removePaneLocal(group, p));
    if (group.host && group.host.parentElement) group.host.parentElement.removeChild(group.host);
    const i = groups.indexOf(group);
    if (i >= 0) groups.splice(i, 1);
  }

  // 切换到指定组
  function switchToGroup(gid) {
    const g = groupById(gid);
    if (!g) return;
    // 暂停其它组所有窗格轮询，只跑当前组
    groups.forEach((o) => { if (o.gid !== gid) o.panes.forEach(stopPoll); });
    activeGid = gid;
    showOnlyGroup(gid);
    renderList();
    updateToolbar();
    relayoutGroup(g);
    startGroupPoll(g);
    const p = g.panes.find(x => x.pid === g.activePid) || g.panes[0];
    if (p && p.term) setTimeout(() => { try { p.term.focus(); } catch {} }, 0);
  }

  // 关闭整组（通知后端关掉各窗格会话 + 本地移除 + 切到相邻）
  async function closeGroup(gid) {
    const g = groupById(gid);
    if (!g) return;
    // 用对象引用记住前后相邻组（按身份而非索引）：await 期间若 groups 被拖动重排/增删，
    // 陈旧的数字 idx 会选错相邻组，故改用仍在数组中的邻居引用，都不在则退回 groups[0]。
    const before = groups.indexOf(g);
    const nextRef = before >= 0 ? groups[before + 1] : null;
    const prevRef = before >= 0 ? groups[before - 1] : null;
    for (const p of g.panes.slice()) {
      if (p.pid != null) { try { await fsPost("/api/term/close", { id: p.pid }); } catch {} }
    }
    removeGroupLocal(g);
    if (activeGid === gid || !groupById(activeGid)) {
      let next = null;
      if (nextRef && groups.indexOf(nextRef) >= 0) next = nextRef;
      else if (prevRef && groups.indexOf(prevRef) >= 0) next = prevRef;
      else next = groups[0] || null;
      activeGid = next ? next.gid : null;
    }
    renderList();
    applyListVisibility();
    updateToolbar();
    if (activeGid) switchToGroup(activeGid);
  }

  // 杀掉当前活动组（垃圾桶按钮）
  // 垃圾桶：关掉当前聚焦窗格（贴合 VS Code）。组内多窗格时只移除该窗格，
  // 退化为单窗格；若已是组内唯一窗格 → 关掉整组。
  function killActive() {
    const g = activeGroup();
    if (!g) return;
    if (g.panes.length > 1) {
      const p = g.panes.find(x => x.pid === g.activePid) || g.panes[0];
      closePane(g, p);
    } else {
      closeGroup(g.gid);
    }
  }

  // 确保至少有一个活动组（首次展开 / 命令送入前调用）
  let ensuring = null;
  function ensureSession() {
    const p = activePane();
    if (p && p.alive && p.term) return Promise.resolve(true);
    if (ensuring) return ensuring;
    ensuring = (async () => {
      if (!hasXterm()) {
        const host = $("#term-xterm");
        if (host && !groups.length) host.textContent = "终端组件未加载（xterm.js 缺失）";
        return false;
      }
      // 若已有组但活动窗格已死，切到一个仍存活的组
      const aliveG = groups.find(g => g.panes.some(p => p.alive && p.term));
      if (aliveG) { switchToGroup(aliveG.gid); return true; }
      const g = await newGroup(selectedShellId());
      return !!g;
    })();
    const pr = ensuring;
    pr.finally(() => {
      if (ensuring === pr) ensuring = null;
      updateToolbar();
    });
    return pr;
  }

  // ---------- 读轮询（每窗格独立） ----------
  function startPoll(p) {
    if (!p || p.poll) return;
    if (p.pid == null) return;
    if (p.alive === false) return;   // 已知死会话别再起轮询(switchToGroup/展开会重入)，否则死窗格空转打后端
    p.poll = setInterval(() => pollRead(p), 60);
  }
  function stopPoll(p) {
    if (p && p.poll) { clearInterval(p.poll); p.poll = null; }
  }
  function startGroupPoll(g) { if (g) g.panes.forEach(startPoll); }
  async function pollRead(p) {
    if (!p || p.reading || p.pid == null || isCollapsed()) return;
    if (p.gid !== activeGid) return; // 仅轮询活动组的窗格
    p.reading = true;
    try {
      const url = "/api/term/read?id=" + encodeURIComponent(p.pid) +
                  "&offset=" + encodeURIComponent(p.offset);
      const res = await fetch(url, { cache: "no-store" }).then(r => r.json());
      if (res && res.error) {
        // 会话已被后端回收(404 {error:"会话不存在"})：必须停轮询，否则 60ms 间隔永久空转
        stopPoll(p);
        if (p.alive) {
          p.alive = false;
          if (p.term) p.term.write("\r\n\x1b[33m[进程已退出]\x1b[0m\r\n");
          renderList();
        }
      } else if (res) {
        if (res.data) {
          const bytes = b64ToBytes(res.data);
          if (bytes.length && p.term) p.term.write(bytes);
        }
        if (typeof res.offset === "number") p.offset = res.offset;
        if (res.alive === false && p.alive) {
          p.alive = false;
          stopPoll(p);
          if (p.term) p.term.write("\r\n\x1b[33m[进程已退出]\x1b[0m\r\n");
          renderList();
        }
      }
    } catch {
      /* 单次失败忽略，下个 tick 再试 */
    } finally {
      p.reading = false;
    }
  }

  // ---------- 尺寸：fit + 通知后端 ----------
  function relayoutPane(p) {
    if (!p || !p.term || !p.fit) return;
    if (isCollapsed()) return;
    if (p.gid !== activeGid) return; // 仅对可见组的窗格 fit
    try { p.fit.fit(); } catch {}
    const { cols, rows } = dimsOf(p);
    if (cols === p.lastCols && rows === p.lastRows) return;
    p.lastCols = cols; p.lastRows = rows;
    if (p.pid != null) {
      fsPost("/api/term/resize", { id: p.pid, cols, rows }).catch(() => {});
    }
  }
  function relayoutGroup(g) {
    g = g || activeGroup();
    if (!g) return;
    g.panes.forEach(relayoutPane);
  }

  // 外部（如分隔条拖拽）调用：立即对当前活动组重排 fit
  window.termRefit = function () { try { relayoutGroup(activeGroup()); } catch {} };

  function attachResizeObserver(p) {
    if (!p || !p.host || p.ro || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    p.ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; relayoutPane(p); });
    });
    try { p.ro.observe(p.host); } catch {}
  }

  // ---------- 窗格间竖直分隔条（自管拖拽，遮罩防 xterm 吞鼠标） ----------
  let paneOverlay = null;
  function showPaneOverlay() {
    if (!paneOverlay) {
      paneOverlay = document.createElement("div");
      paneOverlay.id = "wb-pane-drag-overlay";
      paneOverlay.style.cssText =
        "position:fixed;inset:0;z-index:9999;cursor:col-resize;";
      document.body.appendChild(paneOverlay);
    }
    paneOverlay.style.display = "block";
  }
  function hidePaneOverlay() { if (paneOverlay) paneOverlay.style.display = "none"; }

  // sp 分隔条紧跟在 pane(左侧窗格) 之后：拖动调整左侧窗格宽度（右侧窗格 flex:1 占余）
  function bindPaneSplitter(sp, group, pane) {
    let dragging = false;
    function move(e) {
      if (!dragging) return;
      const rect = pane.host.getBoundingClientRect();
      let w = e.clientX - rect.left;
      const total = group.host.getBoundingClientRect().width;
      w = Math.max(40, Math.min(w, total - 60));
      group.basis = group.basis || {};
      group.basis[pane.pid] = Math.round(w);
      pane.host.style.flex = "0 0 " + Math.round(w) + "px";
      relayoutPane(pane);
      // 右侧窗格也需要 refit
      const idx = group.panes.indexOf(pane);
      const right = group.panes[idx + 1];
      if (right) relayoutPane(right);
    }
    function up() {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove("dragging");
      hidePaneOverlay();
      window.removeEventListener("mousemove", move);   // 仅在拖动期间挂 window 监听，松手即摘
      window.removeEventListener("mouseup", up);
      relayoutGroup(group);
    }
    // 每次 relayout 会新建 sp 元素；监听只在按下→松手之间存在，避免随 relayout 无限累积泄漏
    sp.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      sp.classList.add("dragging");
      showPaneOverlay();
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  // ---------- 主题跟随：监听 data-theme 变化（所有窗格跟随） ----------
  function watchTheme() {
    try {
      const mo = new MutationObserver(() => {
        const th = termTheme();
        allPanes().forEach((p) => { if (p.term) { try { p.term.options.theme = th; } catch {} } });
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } catch {}
  }

  // ---------- 把命令送进当前聚焦窗格 ----------
  async function sendToSession(line) {
    if (!requireWorkspace("使用终端")) return false;
    expand();
    const ok = await ensureSession();
    const p = activePane();
    if (!ok || !p || p.pid == null) return false;
    await fsPost("/api/term/input", { id: p.pid, data: line + "\r" }).catch(() => {});
    if (p.term) setTimeout(() => { try { p.term.focus(); } catch {} }, 0);
    return true;
  }

  // ---------- 运行当前文件（送进当前聚焦窗格） ----------
  async function runFile(path) {
    if (!requireWorkspace("运行文件")) return;
    path = path || (window.state && state.current);
    if (!path) { if (window.setMsg) setMsg("没有可运行的文件", "err"); return; }
    if (!window.wbIsRunnable(path)) {
      if (window.setMsg) setMsg("该文件类型不支持运行", "err");
      return;
    }
    expand();
    const ok = await ensureSession();
    const p = activePane();
    if (ok && p && p.pid != null) {
      const cmd = buildRunCommand(path, p.shell);
      if (cmd) {
        await fsPost("/api/term/input", { id: p.pid, data: cmd + "\r" }).catch(() => {});
        if (p.term) setTimeout(() => { try { p.term.focus(); } catch {} }, 0);
        return;
      }
    }
    // 降级：旧的一次性运行（不影响功能）
    try {
      const res = await fsPost("/api/run-file", { path });
      if (res.error) termAppend({ stderr: res.error });
      else termAppend({
        note: res.interpreter ? "解释器: " + res.interpreter : "",
        stdout: res.stdout, stderr: res.stderr,
      });
    } catch (e) {
      termAppend({ stderr: "请求失败: " + (e && e.message ? e.message : e) });
    }
  }
  window.runCurrentFile = runFile;

  // 依据扩展名 + 当前 shell 拼一条运行命令行
  function buildRunCommand(path, sh) {
    const ext = extOf(path);
    sh = sh || selectedShellId();
    let q;
    if (sh === "gitbash" || sh === "wsl") {
      q = "'" + path.replace(/'/g, "'\\''") + "'";        // POSIX 单引号字面量
    } else if (sh === "powershell") {
      // PowerShell 单引号字面量：双引号内 $()/反引号/$var 仍会展开($、(、) 在 Windows 文件名合法)→命令注入；
      // 单引号字面串不做任何展开，内部单引号翻倍转义。
      q = "'" + path.replace(/'/g, "''") + "'";
    } else {
      // cmd：Windows 文件名不可含 "，双引号即可中和 & | < > ^ 等；cmd 无 $() 子表达式
      q = '"' + path.replace(/"/g, "") + '"';
    }
    const map = {
      ".py": "python " + q,
      ".js": "node " + q,
      ".mjs": "node " + q,
      ".cjs": "node " + q,
      ".ts": "node " + q,
      ".sh": "bash " + q,
      ".bash": "bash " + q,
      ".ps1": (sh === "powershell") ? "& " + q : 'powershell -NoLogo -File ' + q,
    };
    return map[ext] || "";
  }

  // ---------- 运行任务（送进当前聚焦窗格） ----------
  async function runTask(name, kind) {
    if (!name) return;
    if (!requireWorkspace("运行任务")) return;
    const line = (kind === "make" ? "make " : "npm run ") + name;
    const ok = await sendToSession(line);
    if (!ok) {
      try {
        const res = await fsPost("/api/run-task", { name, kind });
        if (res.error) termAppend({ stderr: res.error });
        else termAppend({ stdout: res.stdout, stderr: res.stderr });
      } catch (e) {
        termAppend({ stderr: "请求失败: " + (e && e.message ? e.message : e) });
      }
    }
  }

  // ---------- 任务列表 ----------
  let tasksLoaded = false;
  let terminalTaskCatalog = { npm: [], make: [] };
  function hasTerminalTasks() {
    return !!((terminalTaskCatalog.npm && terminalTaskCatalog.npm.length)
      || (terminalTaskCatalog.make && terminalTaskCatalog.make.length));
  }
  function refreshTerminalTaskActions(reasonOverride) {
    const runBtn = $("#term-task-run");
    const createBtn = $("#term-task-create");
    const runState = reasonOverride
      ? { enabled: false, reason: reasonOverride }
      : terminalActionState("runTask");
    setTerminalButtonState(runBtn, runState, "运行选中任务");
    setTerminalButtonState(createBtn, terminalActionState("createTask"), "从终端上下文创建任务");
  }
  async function loadTasks(force) {
    if (tasksLoaded && !force) return;
    const sel = $("#term-task-sel");
    if (!sel) return;
    if (!hasWorkspace()) {
      sel.innerHTML = `<option value="" disabled selected>请先打开工作区</option>`;
      sel.disabled = true;
      refreshTerminalTaskActions("请先打开工作区");
      tasksLoaded = true;
      return;
    }
    try {
      const data = await fetch("/api/tasks", { cache: "no-store" }).then(r => r.json());
      const npm = Array.isArray(data.npm) ? data.npm : [];
      const make = Array.isArray(data.make) ? data.make : [];
      terminalTaskCatalog = { npm: npm.slice(), make: make.slice() };
      sel.innerHTML = "";
      if (!npm.length && !make.length) {
        const o = document.createElement("option");
        o.value = ""; o.textContent = "无任务"; o.disabled = true; o.selected = true;
        sel.appendChild(o);
        sel.disabled = true;
        refreshTerminalTaskActions("无可运行任务");
      } else {
        sel.disabled = false;
        const ph = document.createElement("option");
        ph.value = ""; ph.textContent = "选择任务…"; ph.disabled = true; ph.selected = true;
        sel.appendChild(ph);
        if (npm.length) {
          const g = document.createElement("optgroup");
          g.label = "npm";
          npm.forEach(n => {
            const o = document.createElement("option");
            o.value = "npm:" + n; o.textContent = "npm run " + n;
            g.appendChild(o);
          });
          sel.appendChild(g);
        }
        if (make.length) {
          const g = document.createElement("optgroup");
          g.label = "make";
          make.forEach(n => {
            const o = document.createElement("option");
            o.value = "make:" + n; o.textContent = "make " + n;
            g.appendChild(o);
          });
          sel.appendChild(g);
        }
        refreshTerminalTaskActions();
      }
      refreshTerminalTaskActions();
      tasksLoaded = true;
    } catch {
      terminalTaskCatalog = { npm: [], make: [] };
      sel.innerHTML = `<option value="" disabled selected>任务加载失败</option>`;
      sel.disabled = true;
      refreshTerminalTaskActions("任务加载失败");
    }
  }
  window.reloadTasks = () => loadTasks(true);

  function runSelectedTask() {
    const sel = $("#term-task-sel");
    const task = selectedTerminalTask();
    if (task) runTask(task.name, task.kind);
  }

  function selectedTerminalTask() {
    const sel = $("#term-task-sel");
    if (!sel || !sel.value) return null;
    const [kind, name] = sel.value.split(/:(.+)/);
    if (!name) return null;
    return {
      kind,
      name,
      command: (kind === "make" ? "make " : "npm run ") + name,
    };
  }

  function terminalContextSeed() {
    const p = activePane();
    const g = activeGroup();
    const task = selectedTerminalTask();
    const cwd = ($("#term-cwd") && $("#term-cwd").textContent || "/").trim() || "/";
    const shell = p ? shellNameOf(p.shell) : shellNameOf(selectedShellId());
    const workspace = window.currentWorkspaceId || window.currentRoot || "current workspace";
    const knownTasks = []
      .concat((terminalTaskCatalog.npm || []).map(n => "npm run " + n))
      .concat((terminalTaskCatalog.make || []).map(n => "make " + n));
    const title = task ? `终端验证: ${task.command}` : `终端上下文验证: ${cwd}`;
    const plan = task ? [
      `确认任务命令: ${task.command}`,
      "按需在终端中手动运行该命令",
      "记录 stdout/stderr、退出码或截图作为 evidence",
      "把验证结果同步到 Project Memory",
    ] : [
      "确认当前终端工作目录和 shell",
      "选择要验证的 npm/make 任务或手动命令",
      "运行命令后记录输出、退出码或截图",
      "把验证结果同步到 Project Memory",
    ];
    const log = [
      "Created from terminal context",
      `Workspace: ${workspace}`,
      `Terminal cwd: ${cwd}`,
      `Shell: ${shell}`,
      `Active terminal group: ${g ? groupDisplayName(g) : "none"}`,
    ];
    if (task) log.push(`Selected task: ${task.command}`);
    if (!task && knownTasks.length) log.push("Available tasks: " + knownTasks.slice(0, 8).join(", "));
    if (!task && knownTasks.length > 8) log.push(`...and ${knownTasks.length - 8} more tasks`);
    return {
      title,
      goal: task
        ? `验证终端任务 ${task.command}，记录可回放的执行证据。`
        : "基于当前终端上下文创建验证任务，记录命令、输出和后续证据。",
      plan,
      evidence: [],
      log,
      next: task ? "Run the selected task manually when ready and attach output/evidence." : "Choose or type the command to validate, then attach output/evidence.",
    };
  }

  async function createTerminalWorkflowTask() {
    if (!requireWorkspace("创建终端任务")) return;
    if (!window.addWorkflowTask) {
      if (window.setMsg) setMsg("任务面板尚未就绪", "warn");
      return;
    }
    await loadTasks(false);
    await window.addWorkflowTask(terminalContextSeed());
  }

  // ---------- 运行此文件按钮 ----------
  function ensureRunButton() {
    let btn = $("#tab-run-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "tab-run-btn";
      btn.className = "tab-run-btn hidden";
      btn.title = "运行此文件（在服务器本机执行）";
      btn.innerHTML = svgIcon("play", 14) + "<span>运行</span>";
      btn.onclick = () => window.wbTerminalActions.run("runCurrentFile");
      const bar = $("#tabbar");
      if (bar && bar.parentElement) bar.parentElement.insertBefore(btn, bar.nextSibling);
    }
    return btn;
  }
  function updateRunButton() {
    const btn = ensureRunButton();
    const path = window.state && state.current;
    const show = !!(hasWorkspace() && path && window.state.kind === "text" && window.wbIsRunnable(path));
    btn.classList.toggle("hidden", !show);
  }
  window.updateRunButton = updateRunButton;

  // ---------- 列表显隐切换 ----------
  function toggleList() {
    const list = $("#term-list");
    if (!list) return;
    const nowHidden = list.classList.contains("hidden");
    if (nowHidden) {
      // 打开：手动强制显示
      listForced = true;
      list.classList.remove("hidden");
    } else {
      // 关闭：取消强制；若 ≥2 组按规则仍会显示，这里强制隐藏直到下次变化
      listForced = false;
      // 用户明确想隐藏 → 即使多组也隐藏（直到再次手动开或新建组）
      list.classList.add("hidden");
    }
    updateToolbar();
    relayoutGroup(activeGroup());
  }

  // ---------- 初始化 ----------
  function init() {
    setCwdLabel("");

    const clearBtn = $("#term-clear");
    if (clearBtn) clearBtn.onclick = (e) => {
      e.stopPropagation();
      const p = activePane(); if (p && p.term) p.term.clear();
    };

    const collapseBtn = $("#term-collapse");
    if (collapseBtn) collapseBtn.onclick = (e) => { e.stopPropagation(); window.wbTerminalActions.run("toggle"); };

    const maxBtn = $("#term-maximize");
    if (maxBtn) maxBtn.onclick = (e) => { e.stopPropagation(); toggleMaxed(); };

    const dockBtn = $("#term-dock");
    if (dockBtn) dockBtn.onclick = (e) => { e.stopPropagation(); toggleDock(); };
    updateDockBtn(dockPrefRight());   // 初始按钮态跟随持久化偏好
    attachHeadDockDrag();             // 拖终端头 → 编辑区停靠

    const head = $("#term-head");
    if (head) head.addEventListener("click", (e) => {
      // 点标题空白处折叠/展开，避开按钮、下拉、工具栏、列表
      if (e.target.closest("button") || e.target.closest("select") ||
          e.target.closest(".term-toolbar") || e.target.closest(".term-shell-menu")) return;
      window.wbTerminalActions.run("toggle");
    });

    const taskRun = $("#term-task-run");
    if (taskRun) taskRun.onclick = () => window.wbTerminalActions.run("runTask");
    const taskSel = $("#term-task-sel");
    if (taskSel) taskSel.onchange = () => refreshTerminalTaskActions();
    const taskCreate = $("#term-task-create");
    if (taskCreate) taskCreate.onclick = () => window.wbTerminalActions.run("createTask");

    // 分裂按钮：主体 = 用默认 shell 新建组
    const newBtn = $("#term-new");
    if (newBtn) newBtn.onclick = (e) => {
      e.stopPropagation();
      window.wbTerminalActions.run("new");
    };
    // 下拉箭头：弹 shell 菜单
    const caret = $("#term-new-caret");
    if (caret) caret.onclick = (e) => { e.stopPropagation(); toggleShellMenu(); };

    // 拆分按钮
    const splitBtn = $("#term-split");
    if (splitBtn) splitBtn.onclick = (e) => { e.stopPropagation(); window.wbTerminalActions.run("split"); };

    // 列表显隐
    const listToggle = $("#term-list-toggle");
    if (listToggle) listToggle.onclick = (e) => { e.stopPropagation(); toggleList(); };

    // 垃圾桶：杀掉当前活动组
    const killBtn = $("#term-kill");
    if (killBtn) killBtn.onclick = (e) => { e.stopPropagation(); killActive(); };

    // 点击别处关闭 shell 菜单
    document.addEventListener("mousedown", (e) => {
      const menu = $("#term-shell-menu");
      if (menu && !menu.classList.contains("hidden") &&
          !e.target.closest("#term-new-split")) hideShellMenu();
    });

    const st = $("#status-term");
    if (st) st.onclick = () => window.wbTerminalActions.run("toggle");
    if (st) st.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      window.wbTerminalActions.run("toggle");
    });

    // Ctrl+` 切换终端面板；Ctrl+Shift+5 拆分终端
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "`" || e.key === "~")) {
        e.preventDefault();
        window.wbTerminalActions.run("toggle");
        return;
      }
      // Ctrl+Shift+5 拆分（'5' 或 '%'）
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "5" || e.key === "%")) {
        e.preventDefault();
        window.wbTerminalActions.run("split");
      }
    });

    // 窗口尺寸变化 → 重排活动组
    window.addEventListener("resize", () => relayoutGroup(activeGroup()));

    // 命令面板动作
    if (window.registerAction) {
      registerAction({ id: "terminal.toggle", name: "切换终端面板", hint: "Ctrl+`", icon: "terminal",
                       requires: ["workspace"],
                       enabled: () => {
                         const st = window.wbTerminalActions.actionState("toggle");
                         return st.enabled ? true : st.reason;
                       },
                       run: () => window.wbTerminalActions.run("toggle") });
      registerAction({ id: "terminal.runCurrentFile", name: "运行当前文件", hint: "", icon: "play",
                       requires: ["workspace", "currentFile"], risk: "exec",
                       enabled: () => {
                         const st = window.wbTerminalActions.actionState("runCurrentFile");
                         return st.enabled ? true : st.reason;
                       },
                       run: () => window.wbTerminalActions.run("runCurrentFile") });
      registerAction({ id: "terminal.new", name: "新建终端", hint: "", icon: "plus",
                       requires: ["workspace"], risk: "exec",
                       enabled: () => {
                         const st = window.wbTerminalActions.actionState("new");
                         return st.enabled ? true : st.reason;
                       },
                       run: () => window.wbTerminalActions.run("new") });
      registerAction({ id: "terminal.split", name: "拆分终端", hint: "Ctrl+Shift+5", icon: "splitH",
                       requires: ["workspace"], risk: "exec",
                       enabled: () => {
                         const st = window.wbTerminalActions.actionState("split");
                         return st.enabled ? true : st.reason;
                       },
                       run: () => window.wbTerminalActions.run("split") });
      registerAction({ id: "terminal.runTask", name: "终端: 运行选中任务", hint: "npm/make", icon: "play",
                       requires: ["workspace"], risk: "exec",
                       enabled: () => {
                         const st = window.wbTerminalActions.actionState("runTask");
                         return st.enabled ? true : st.reason;
                       },
                       run: () => window.wbTerminalActions.run("runTask") });
      registerAction({ id: "task.fromTerminal", name: "任务: 从终端上下文创建", hint: "Terminal", icon: "terminal",
                       requires: ["workspace"], risk: "write",
                       enabled: () => {
                         const st = window.wbTerminalActions.actionState("createTask");
                         return st.enabled ? true : st.reason;
                       },
                       run: () => window.wbTerminalActions.run("createTask") });
    }

    window.addEventListener("wb:workspace-state", (e) => {
      workspaceOpen = !!(e.detail && e.detail.hasWorkspace);
      tasksLoaded = false;
      loadTasks(true);
      updateRunButton();
      updateToolbar();
      updateStatusTermState();
    });
    watchTheme();
    loadShells().then(updateToolbar);
    loadTasks();
    updateRunButton();
    updateToolbar();

    // 退出时尽量通知后端清理所有会话
    window.addEventListener("beforeunload", () => {
      if (!navigator.sendBeacon) return;
      allPanes().forEach((p) => {
        if (p.pid != null) {
          try {
            navigator.sendBeacon("/api/term/close",
              new Blob([JSON.stringify({ id: p.pid })], { type: "application/json" }));
          } catch {}
        }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
