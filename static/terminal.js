/* Workbench 集成终端（xterm.js + 后端持久 shell，IDE 式多终端）
   每个终端对应后端一个持久 shell 会话（首选 ConPTY，环境不支持时回退管道）。
   命令仅在服务器本机（127.0.0.1）执行，写操作复用 fsPost 的 CSRF。
   消费后端协议 /api/term/*。支持同时存在多个终端、标签切换、单独关闭，
   切换/新建/关闭某个不影响其它已开终端的进程。 */
(function () {
  const $ = (s) => document.querySelector(s);

  // 可运行的扩展名（与后端 RUN_INTERPRETERS 对应的常用集合）
  const RUNNABLE = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".bash", ".ps1"]);
  const extOf = (name) => {
    const i = (name || "").lastIndexOf(".");
    return i >= 0 ? name.slice(i).toLowerCase() : "";
  };
  window.wbIsRunnable = (path) => RUNNABLE.has(extOf(path || ""));

  // ---------- 多终端状态 ----------
  // 每个终端: {id, shell, shellName, term, fit, host, offset, poll, alive,
  //            reading, opening, ro, lastCols, lastRows, title, num}
  const terms = [];      // 终端实例数组（顺序即标签顺序）
  let activeId = null;   // 当前激活终端的后端 id
  let seq = 0;           // 终端编号（标签显示 "1: CMD"）
  let shells = [];       // /api/term/shells 结果
  let shellsLoaded = false;

  function panel() { return $("#terminal-panel"); }
  function isCollapsed() { return panel().classList.contains("collapsed"); }
  function active() { return terms.find(t => t.id === activeId) || null; }
  function byId(id) { return terms.find(t => t.id === id) || null; }

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

  // ---------- 折叠/展开 ----------
  function setCollapsed(v) {
    panel().classList.toggle("collapsed", v);
    const tw = $("#term-collapse");
    if (tw) tw.classList.toggle("up", !v);
    const st = $("#status-term");
    if (st) st.classList.toggle("active", !v);
    if (!v) {
      // 展开：首次确保有终端，随后 fit + 聚焦 + 续当前终端轮询
      ensureSession().then(() => {
        const t = active();
        relayout(t);
        if (t && t.term) setTimeout(() => { try { t.term.focus(); } catch {} }, 0);
        startPoll(t);
      });
    } else {
      // 折叠：暂停所有终端轮询
      terms.forEach(stopPoll);
    }
  }
  function expand() { if (isCollapsed()) setCollapsed(false); }
  function toggle() { setCollapsed(!isCollapsed()); }
  window.toggleTerminal = toggle;
  window.openTerminal = expand;

  // 兼容旧 API：把信息以一行文本写进当前终端（不再渲染 HTML 块）
  function termAppend(info) {
    if (!info) return;
    const t = active();
    if (!t || !t.term) return;
    const parts = [];
    if (info.cmd) parts.push(info.cmd);
    if (info.note) parts.push(info.note);
    if (info.stdout) parts.push(info.stdout);
    if (info.stderr) parts.push(info.stderr);
    const text = parts.join("\r\n");
    if (text) t.term.write("\r\n" + text.replace(/\n/g, "\r\n") + "\r\n");
  }
  window.termAppend = termAppend;

  function setCwdLabel(cwd) {
    const el = $("#term-cwd");
    if (el) el.textContent = cwd ? "/" + cwd : "/";
  }

  // ---------- shell 选择器 ----------
  async function loadShells(force) {
    if (shellsLoaded && !force) return shells;
    const sel = $("#term-shell-sel");
    try {
      const data = await fetch("/api/term/shells", { cache: "no-store" }).then(r => r.json());
      shells = Array.isArray(data.shells) ? data.shells : [];
    } catch {
      shells = [];
    }
    shellsLoaded = true;
    if (sel) {
      sel.innerHTML = "";
      if (!shells.length) {
        const o = document.createElement("option");
        o.value = ""; o.textContent = "无可用 Shell"; o.disabled = true; o.selected = true;
        sel.appendChild(o);
        sel.disabled = true;
      } else {
        sel.disabled = false;
        shells.forEach((sh) => {
          const o = document.createElement("option");
          o.value = sh.id;
          o.textContent = sh.exists ? sh.name : sh.name + "（未安装）";
          if (!sh.exists) o.disabled = true;
          sel.appendChild(o);
        });
        const first = shells.find(s => s.exists);
        if (first) sel.value = first.id;
      }
    }
    return shells;
  }

  function selectedShellId() {
    const sel = $("#term-shell-sel");
    if (sel && sel.value) return sel.value;
    const first = shells.find(s => s.exists);
    return first ? first.id : "powershell";
  }
  function shellNameOf(id) {
    const sh = shells.find(s => s.id === id);
    return sh ? sh.name : (id || "Shell");
  }

  // ---------- 标签条渲染 ----------
  function renderTabs() {
    const bar = $("#term-tabs");
    if (!bar) return;
    bar.innerHTML = "";
    terms.forEach((t) => {
      const tab = document.createElement("div");
      tab.className = "term-tab" + (t.id === activeId ? " active" : "")
                    + (t.alive ? "" : " dead");
      tab.title = t.title + (t.alive ? "" : "（已退出）");
      const label = document.createElement("span");
      label.className = "term-tab-label";
      label.textContent = t.title;
      label.onclick = () => switchTo(t.id);
      const x = document.createElement("button");
      x.className = "term-tab-x";
      x.title = "关闭此终端";
      x.textContent = "×";   // ×
      x.onclick = (e) => { e.stopPropagation(); closeTerm(t.id); };
      tab.appendChild(label);
      tab.appendChild(x);
      bar.appendChild(tab);
    });
  }

  // ---------- 创建一个终端实例（xterm + host + 后端会话） ----------
  function makeHost() {
    const wrap = $("#term-xterm");
    if (!wrap) return null;
    const host = document.createElement("div");
    host.className = "term-pane";
    wrap.appendChild(host);
    return host;
  }

  function dimsOf(t) {
    if (t && t.term && t.term.cols && t.term.rows) {
      return { cols: t.term.cols, rows: t.term.rows };
    }
    return { cols: 80, rows: 24 };
  }

  // 隐藏所有终端 pane，仅显示 id 对应的
  function showOnly(id) {
    terms.forEach((t) => {
      if (t.host) t.host.style.display = (t.id === id) ? "block" : "none";
    });
  }

  // 新建终端：建 host + xterm + 后端会话；成功后设为活动并切换显示
  async function newTerm(shellId) {
    if (!hasXterm()) {
      const host = $("#term-xterm");
      if (host && !terms.length) host.textContent = "终端组件未加载（xterm.js 缺失）";
      return null;
    }
    await loadShells();
    shellId = shellId || selectedShellId();

    const host = makeHost();
    if (!host) return null;
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

    const num = ++seq;
    const t = {
      id: null, shell: shellId, term, fit, host,
      offset: 0, poll: null, alive: false, reading: false, opening: false,
      ro: null, lastCols: 0, lastRows: 0,
      num, title: num + ": " + shellNameOf(shellId),
    };
    // 用户输入 → 送入该终端会话
    term.onData((d) => {
      if (t.id != null) fsPost("/api/term/input", { id: t.id, data: d }).catch(() => {});
    });
    terms.push(t);

    // 先显示+激活（即便后端还在开，UI 已就绪）
    activeId = null; // 临时
    showOnly(null);
    t.host.style.display = "block";
    try { if (fit) fit.fit(); } catch {}

    const { cols, rows } = dimsOf(t);
    t.opening = true;
    let ok = false;
    try {
      const res = await fsPost("/api/term/open", { shell: shellId, cols, rows });
      if (res && res.id != null && !res.error) {
        t.id = res.id; t.offset = 0; t.alive = true; ok = true;
      } else {
        const why = (res && res.error) ? res.error : "无法启动会话";
        term.write("\r\n\x1b[31m[启动失败] " + why + "\x1b[0m\r\n");
      }
    } catch (e) {
      term.write("\r\n\x1b[31m[启动失败] " + (e && e.message ? e.message : e) + "\x1b[0m\r\n");
    } finally {
      t.opening = false;
    }

    if (!ok) {
      // 开失败：移除该实例
      removeTermLocal(t);
      renderTabs();
      return null;
    }
    activeId = t.id;
    showOnly(activeId);
    renderTabs();
    relayout(t);
    startPoll(t);
    attachResizeObserver(t);
    setTimeout(() => { try { t.term.focus(); } catch {} }, 0);
    return t;
  }

  // 本地销毁一个终端实例（不通知后端）
  function removeTermLocal(t) {
    stopPoll(t);
    if (t.ro) { try { t.ro.disconnect(); } catch {} t.ro = null; }
    if (t.term) { try { t.term.dispose(); } catch {} t.term = null; }
    if (t.host && t.host.parentElement) t.host.parentElement.removeChild(t.host);
    const i = terms.indexOf(t);
    if (i >= 0) terms.splice(i, 1);
  }

  // 切换到指定终端
  function switchTo(id) {
    const t = byId(id);
    if (!t) return;
    // 暂停其它终端轮询，只跑当前的（降低开销，且避免后台无谓写入）
    terms.forEach((o) => { if (o.id !== id) stopPoll(o); });
    activeId = id;
    showOnly(id);
    renderTabs();
    relayout(t);
    startPoll(t);
    setTimeout(() => { try { t.term && t.term.focus(); } catch {} }, 0);
  }

  // 关闭某个终端（通知后端 + 本地移除 + 切到相邻）
  async function closeTerm(id) {
    const t = byId(id);
    if (!t) return;
    const idx = terms.indexOf(t);
    if (t.id != null) {
      try { await fsPost("/api/term/close", { id: t.id }); } catch {}
    }
    removeTermLocal(t);
    // 切到相邻终端（优先后一个，否则前一个）
    if (activeId === id || !byId(activeId)) {
      const next = terms[idx] || terms[idx - 1] || terms[0] || null;
      activeId = next ? next.id : null;
    }
    renderTabs();
    if (activeId) {
      switchTo(activeId);
    } else if (!isCollapsed()) {
      // 没有终端了：保持面板展开，下次 ensureSession 会新建
    }
  }

  // 确保至少有一个活动终端（首次展开 / 命令送入前调用）
  let ensuring = null;
  function ensureSession() {
    const a = active();
    if (a && a.alive && a.term) return Promise.resolve(true);
    if (ensuring) return ensuring;
    ensuring = (async () => {
      if (!hasXterm()) {
        const host = $("#term-xterm");
        if (host && !terms.length) host.textContent = "终端组件未加载（xterm.js 缺失）";
        return false;
      }
      // 若已有终端但当前活动的已死，切到一个仍存活的
      const aliveOne = terms.find(t => t.alive && t.term);
      if (aliveOne) { switchTo(aliveOne.id); return true; }
      const t = await newTerm(selectedShellId());
      return !!t;
    })();
    const p = ensuring;
    p.finally(() => { if (ensuring === p) ensuring = null; });
    return p;
  }

  // ---------- 读轮询（每终端独立） ----------
  function startPoll(t) {
    if (!t || t.poll) return;
    if (t.id == null) return;
    t.poll = setInterval(() => pollRead(t), 60);
  }
  function stopPoll(t) {
    if (t && t.poll) { clearInterval(t.poll); t.poll = null; }
  }
  async function pollRead(t) {
    if (!t || t.reading || t.id == null || isCollapsed()) return;
    if (t.id !== activeId) return; // 仅轮询当前终端
    t.reading = true;
    try {
      const url = "/api/term/read?id=" + encodeURIComponent(t.id) +
                  "&offset=" + encodeURIComponent(t.offset);
      const res = await fetch(url, { cache: "no-store" }).then(r => r.json());
      if (res && !res.error) {
        if (res.data) {
          const bytes = b64ToBytes(res.data);
          if (bytes.length && t.term) t.term.write(bytes);
        }
        if (typeof res.offset === "number") t.offset = res.offset;
        if (res.alive === false && t.alive) {
          t.alive = false;
          stopPoll(t);
          if (t.term) t.term.write("\r\n\x1b[33m[进程已退出]\x1b[0m\r\n");
          renderTabs();
        }
      }
    } catch {
      /* 单次失败忽略，下个 tick 再试 */
    } finally {
      t.reading = false;
    }
  }

  // ---------- 尺寸：fit + 通知后端 ----------
  function relayout(t) {
    t = t || active();
    if (!t || !t.term || !t.fit) return;
    if (isCollapsed()) return;
    if (t.id !== activeId) return; // 仅对可见终端 fit（隐藏的尺寸为 0）
    try { t.fit.fit(); } catch {}
    const { cols, rows } = dimsOf(t);
    if (cols === t.lastCols && rows === t.lastRows) return;
    t.lastCols = cols; t.lastRows = rows;
    if (t.id != null) {
      fsPost("/api/term/resize", { id: t.id, cols, rows }).catch(() => {});
    }
  }

  // 外部（如分隔条拖拽）调用：立即对当前可见终端重排 fit
  window.termRefit = function () { try { relayout(active()); } catch {} };

  function attachResizeObserver(t) {
    if (!t || !t.host || t.ro || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    t.ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; relayout(t); });
    });
    try { t.ro.observe(t.host); } catch {}
  }

  // ---------- 主题跟随：监听 data-theme 变化（所有终端跟随） ----------
  function watchTheme() {
    try {
      const mo = new MutationObserver(() => {
        const th = termTheme();
        terms.forEach((t) => { if (t.term) { try { t.term.options.theme = th; } catch {} } });
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } catch {}
  }

  // ---------- 把命令送进当前活动终端 ----------
  async function sendToSession(line) {
    expand();
    const ok = await ensureSession();
    const t = active();
    if (!ok || !t || t.id == null) return false;
    await fsPost("/api/term/input", { id: t.id, data: line + "\r" }).catch(() => {});
    if (t.term) setTimeout(() => { try { t.term.focus(); } catch {} }, 0);
    return true;
  }

  // ---------- 运行当前文件（送进当前活动终端） ----------
  async function runFile(path) {
    path = path || (window.state && state.current);
    if (!path) { if (window.setMsg) setMsg("没有可运行的文件", "err"); return; }
    if (!window.wbIsRunnable(path)) {
      if (window.setMsg) setMsg("该文件类型不支持运行", "err");
      return;
    }
    expand();
    const ok = await ensureSession();
    const t = active();
    if (ok && t && t.id != null) {
      const cmd = buildRunCommand(path, t.shell);
      if (cmd) {
        await fsPost("/api/term/input", { id: t.id, data: cmd + "\r" }).catch(() => {});
        if (t.term) setTimeout(() => { try { t.term.focus(); } catch {} }, 0);
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

  // ---------- 运行任务（送进当前活动终端） ----------
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

  // ---------- 初始化 ----------
  function init() {
    setCwdLabel("");

    const clearBtn = $("#term-clear");
    if (clearBtn) clearBtn.onclick = () => { const t = active(); if (t && t.term) t.term.clear(); };

    const collapseBtn = $("#term-collapse");
    if (collapseBtn) collapseBtn.onclick = toggle;

    const head = $("#term-head");
    if (head) head.addEventListener("click", (e) => {
      // 点标题空白处折叠/展开，避开按钮、下拉、标签条
      if (e.target.closest("button") || e.target.closest("select") ||
          e.target.closest("#term-tabs")) return;
      toggle();
    });

    const taskRun = $("#term-task-run");
    if (taskRun) taskRun.onclick = runSelectedTask;

    // shell 选择器：仅切换"新建终端用的 shell"，不动已开终端
    // （选择本身不新建；点 + 才用当前所选 shell 新建）

    // "+" 新建终端（用当前所选 shell）
    const newBtn = $("#term-new");
    if (newBtn) newBtn.onclick = (e) => {
      e.stopPropagation();
      expand();
      newTerm(selectedShellId());
    };

    const st = $("#status-term");
    if (st) st.onclick = toggle;

    // Ctrl+` 切换终端面板
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "`" || e.key === "~")) {
        e.preventDefault();
        toggle();
      }
    });

    // 窗口尺寸变化 → 重排当前终端
    window.addEventListener("resize", () => relayout(active()));

    // 命令面板动作
    if (window.registerAction) {
      registerAction({ name: "切换终端面板", hint: "Ctrl+`", icon: "terminal", run: toggle });
      registerAction({ name: "运行当前文件", hint: "", icon: "play",
                       run: () => runFile(window.state && state.current) });
      registerAction({ name: "新建终端", hint: "", icon: "plus",
                       run: () => { expand(); newTerm(selectedShellId()); } });
    }

    watchTheme();
    loadShells();
    loadTasks();
    updateRunButton();

    // 退出时尽量通知后端清理所有会话
    window.addEventListener("beforeunload", () => {
      if (!navigator.sendBeacon) return;
      terms.forEach((t) => {
        if (t.id != null) {
          try {
            navigator.sendBeacon("/api/term/close",
              new Blob([JSON.stringify({ id: t.id })], { type: "application/json" }));
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
