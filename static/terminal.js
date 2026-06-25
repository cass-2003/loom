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

  function panel() { return $("#terminal-panel"); }
  function isCollapsed() { return panel().classList.contains("collapsed"); }
  function activeGroup() { return groups.find(g => g.gid === activeGid) || null; }
  function groupById(gid) { return groups.find(g => g.gid === gid) || null; }
  function activePane() {
    const g = activeGroup();
    if (!g) return null;
    return g.panes.find(p => p.pid === g.activePid) || g.panes[0] || null;
  }
  function allPanes() { const a = []; groups.forEach(g => g.panes.forEach(p => a.push(p))); return a; }

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
      // 展开：首次确保有终端，随后 fit + 聚焦 + 续活动组各窗格轮询
      ensureSession().then(() => {
        const g = activeGroup();
        relayoutGroup(g);
        const p = activePane();
        if (p && p.term) setTimeout(() => { try { p.term.focus(); } catch {} }, 0);
        startGroupPoll(g);
      });
    } else {
      // 折叠：暂停所有窗格轮询
      allPanes().forEach(stopPoll);
    }
  }
  function expand() { if (isCollapsed()) setCollapsed(false); }
  function toggle() { setCollapsed(!isCollapsed()); }
  window.toggleTerminal = toggle;
  window.openTerminal = expand;

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
    // 拆分/关闭按钮可用性
    const splitBtn = $("#term-split"), killBtn = $("#term-kill");
    if (splitBtn) splitBtn.disabled = !activeGroup();
    if (killBtn) killBtn.disabled = !activeGroup();
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
  function renderList() {
    const list = $("#term-list");
    if (!list) return;
    list.innerHTML = "";
    groups.forEach((g) => {
      const ap = g.panes.find(p => p.pid === g.activePid) || g.panes[0];
      const allDead = g.panes.length > 0 && g.panes.every(p => !p.alive && !p.opening);
      const row = document.createElement("div");
      row.className = "term-list-row" + (g.gid === activeGid ? " active" : "")
                    + (allDead ? " dead" : "");
      row.title = g.num + ": " + (ap ? shellNameOf(ap.shell) : "")
                + (g.panes.length > 1 ? "（已拆分 ×" + g.panes.length + "）" : "");
      const ico = document.createElement("span");
      ico.className = "term-list-ico";
      ico.innerHTML = svgIcon(shellIcon(ap ? ap.shell : "powershell"), 14);
      const label = document.createElement("span");
      label.className = "term-list-label";
      label.textContent = g.num + ": " + (ap ? shellNameOf(ap.shell) : "Shell");
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
      list.appendChild(row);
    });
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
      if (p.host) p.host.classList.toggle("focused",
        group.panes.length > 1 && p.pid === group.activePid);
    });
  }

  // 在指定组里新开一个窗格（独立后端会话）
  async function newPane(group, shellId) {
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
    group.activePid = pane.pid;
    relayoutPanes(group);
    relayoutGroup(group);
    startPoll(pane);
    attachResizeObserver(pane);
    return pane;
  }

  // 新建一个组（默认含 1 个窗格），并设为活动
  async function newGroup(shellId) {
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
    const group = { gid, num, panes: [], activePid: null, host: ghost, basis: {} };
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
    const idx = groups.indexOf(g);
    for (const p of g.panes.slice()) {
      if (p.pid != null) { try { await fsPost("/api/term/close", { id: p.pid }); } catch {} }
    }
    removeGroupLocal(g);
    if (activeGid === gid || !groupById(activeGid)) {
      const next = groups[idx] || groups[idx - 1] || groups[0] || null;
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
    pr.finally(() => { if (ensuring === pr) ensuring = null; });
    return pr;
  }

  // ---------- 读轮询（每窗格独立） ----------
  function startPoll(p) {
    if (!p || p.poll) return;
    if (p.pid == null) return;
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
      if (res && !res.error) {
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
    sp.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      sp.classList.add("dragging");
      showPaneOverlay();
    });
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
      relayoutGroup(group);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
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
    const q = (sh === "gitbash" || sh === "wsl")
      ? "'" + path.replace(/'/g, "'\\''") + "'"
      : '"' + path.replace(/"/g, '\\"') + '"';
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
  async function loadTasks(force) {
    if (tasksLoaded && !force) return;
    const sel = $("#term-task-sel");
    if (!sel) return;
    try {
      const data = await fetch("/api/tasks", { cache: "no-store" }).then(r => r.json());
      const npm = Array.isArray(data.npm) ? data.npm : [];
      const make = Array.isArray(data.make) ? data.make : [];
      sel.innerHTML = "";
      if (!npm.length && !make.length) {
        const o = document.createElement("option");
        o.value = ""; o.textContent = "无任务"; o.disabled = true; o.selected = true;
        sel.appendChild(o);
        sel.disabled = true;
        $("#term-task-run").disabled = true;
      } else {
        sel.disabled = false;
        $("#term-task-run").disabled = false;
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
      }
      tasksLoaded = true;
    } catch {
      sel.innerHTML = `<option value="" disabled selected>任务加载失败</option>`;
      sel.disabled = true;
    }
  }
  window.reloadTasks = () => loadTasks(true);

  function runSelectedTask() {
    const sel = $("#term-task-sel");
    if (!sel || !sel.value) return;
    const [kind, name] = sel.value.split(/:(.+)/);
    if (name) runTask(name, kind);
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
      btn.onclick = () => runFile(window.state && state.current);
      const bar = $("#tabbar");
      if (bar && bar.parentElement) bar.parentElement.insertBefore(btn, bar.nextSibling);
    }
    return btn;
  }
  function updateRunButton() {
    const btn = ensureRunButton();
    const path = window.state && state.current;
    const show = !!(path && window.state.kind === "text" && window.wbIsRunnable(path));
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
    if (collapseBtn) collapseBtn.onclick = (e) => { e.stopPropagation(); toggle(); };

    const head = $("#term-head");
    if (head) head.addEventListener("click", (e) => {
      // 点标题空白处折叠/展开，避开按钮、下拉、工具栏、列表
      if (e.target.closest("button") || e.target.closest("select") ||
          e.target.closest(".term-toolbar") || e.target.closest(".term-shell-menu")) return;
      toggle();
    });

    const taskRun = $("#term-task-run");
    if (taskRun) taskRun.onclick = runSelectedTask;

    // 分裂按钮：主体 = 用默认 shell 新建组
    const newBtn = $("#term-new");
    if (newBtn) newBtn.onclick = (e) => {
      e.stopPropagation();
      hideShellMenu();
      expand();
      newGroup(selectedShellId());
    };
    // 下拉箭头：弹 shell 菜单
    const caret = $("#term-new-caret");
    if (caret) caret.onclick = (e) => { e.stopPropagation(); toggleShellMenu(); };

    // 拆分按钮
    const splitBtn = $("#term-split");
    if (splitBtn) splitBtn.onclick = (e) => { e.stopPropagation(); splitActive(); };

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
    if (st) st.onclick = toggle;

    // Ctrl+` 切换终端面板；Ctrl+Shift+5 拆分终端
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "`" || e.key === "~")) {
        e.preventDefault();
        toggle();
        return;
      }
      // Ctrl+Shift+5 拆分（'5' 或 '%'）
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "5" || e.key === "%")) {
        e.preventDefault();
        splitActive();
      }
    });

    // 窗口尺寸变化 → 重排活动组
    window.addEventListener("resize", () => relayoutGroup(activeGroup()));

    // 命令面板动作
    if (window.registerAction) {
      registerAction({ name: "切换终端面板", hint: "Ctrl+`", icon: "terminal", run: toggle });
      registerAction({ name: "运行当前文件", hint: "", icon: "play",
                       run: () => runFile(window.state && state.current) });
      registerAction({ name: "新建终端", hint: "", icon: "plus",
                       run: () => { expand(); newGroup(selectedShellId()); } });
      registerAction({ name: "拆分终端", hint: "Ctrl+Shift+5", icon: "splitH",
                       run: () => splitActive() });
    }

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
