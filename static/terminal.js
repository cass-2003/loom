/* Workbench 集成终端（xterm.js + ConPTY 真伪终端）
   每个会话对应后端一个持久 shell（ConPTY）。命令仅在服务器本机（127.0.0.1）执行，
   写操作复用 fsPost 的 CSRF。消费后端协议 /api/term/*。 */
(function () {
  const $ = (s) => document.querySelector(s);

  // 可运行的扩展名（与后端 RUN_INTERPRETERS 对应的常用集合）
  const RUNNABLE = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".bash", ".ps1"]);
  const extOf = (name) => {
    const i = (name || "").lastIndexOf(".");
    return i >= 0 ? name.slice(i).toLowerCase() : "";
  };
  window.wbIsRunnable = (path) => RUNNABLE.has(extOf(path || ""));

  // ---------- 会话状态 ----------
  const sess = {
    term: null,        // xterm Terminal 实例
    fit: null,         // FitAddon 实例
    id: null,          // 后端 sessionId
    shell: null,       // 当前 shell id
    offset: 0,         // 已读字节偏移
    alive: false,      // 进程是否存活
    poll: null,        // 读轮询 timer
    reading: false,    // 防重入：read 请求在途
    opening: false,    // 防重入：open 在途
    ro: null,          // ResizeObserver
    lastCols: 0,
    lastRows: 0,
  };
  let shells = [];     // /api/term/shells 结果
  let shellsLoaded = false;

  function panel() { return $("#terminal-panel"); }
  function isCollapsed() { return panel().classList.contains("collapsed"); }

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
  function hasXterm() {
    return typeof window.Terminal === "function";
  }
  function getFitAddon() {
    // UMD 暴露为 window.FitAddon = { FitAddon: class }
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
      // 展开：首次确保有会话，随后 fit + 聚焦 + 续轮询
      ensureSession().then(() => {
        relayout();
        if (sess.term) setTimeout(() => { try { sess.term.focus(); } catch {} }, 0);
        startPoll();
      });
    } else {
      stopPoll();
    }
  }
  function expand() { if (isCollapsed()) setCollapsed(false); }
  function toggle() { setCollapsed(!isCollapsed()); }
  window.toggleTerminal = toggle;
  window.openTerminal = expand;

  // 兼容旧 API：把信息以一行文本写进终端（不再渲染 HTML 块）
  function termAppend(info) {
    if (!info) return;
    const parts = [];
    if (info.cmd) parts.push(info.cmd);
    if (info.note) parts.push(info.note);
    if (info.stdout) parts.push(info.stdout);
    if (info.stderr) parts.push(info.stderr);
    const text = parts.join("\r\n");
    if (sess.term && text) sess.term.write("\r\n" + text.replace(/\n/g, "\r\n") + "\r\n");
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
        // 默认选中第一个存在的
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

  // ---------- xterm 创建/销毁 ----------
  function createTerm() {
    const host = $("#term-xterm");
    if (!host || !hasXterm()) return false;
    host.innerHTML = "";
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
    if (FitAddon) {
      try { fit = new FitAddon(); term.loadAddon(fit); } catch { fit = null; }
    }
    term.open(host);
    // 用户输入 → 送入会话
    term.onData((d) => {
      if (sess.id != null) {
        fsPost("/api/term/input", { id: sess.id, data: d }).catch(() => {});
      }
    });
    sess.term = term;
    sess.fit = fit;
    try { if (fit) fit.fit(); } catch {}
    return true;
  }

  function disposeTerm() {
    if (sess.ro) { try { sess.ro.disconnect(); } catch {} sess.ro = null; }
    if (sess.term) { try { sess.term.dispose(); } catch {} }
    sess.term = null;
    sess.fit = null;
  }

  // 当前终端的 cols/rows（无 term 时给个默认）
  function dims() {
    if (sess.term && sess.term.cols && sess.term.rows) {
      return { cols: sess.term.cols, rows: sess.term.rows };
    }
    return { cols: 80, rows: 24 };
  }

  // ---------- 打开后端会话 ----------
  async function openSession(shellId) {
    const { cols, rows } = dims();
    sess.opening = true;
    try {
      const res = await fsPost("/api/term/open", { shell: shellId, cols, rows });
      if (res && res.id != null && !res.error) {
        sess.id = res.id;
        sess.shell = shellId;
        sess.offset = 0;
        sess.alive = true;
        return true;
      }
      if (sess.term) {
        const why = (res && res.error) ? res.error : "无法启动会话";
        sess.term.write("\r\n\x1b[31m[启动失败] " + why + "\x1b[0m\r\n");
      }
      return false;
    } catch (e) {
      if (sess.term) sess.term.write("\r\n\x1b[31m[启动失败] " + (e && e.message ? e.message : e) + "\x1b[0m\r\n");
      return false;
    } finally {
      sess.opening = false;
    }
  }

  // 确保存在 xterm + 后端会话（首次展开或选择 shell 时调用）
  let ensuring = null;
  function ensureSession() {
    if (sess.id != null && sess.alive && sess.term) return Promise.resolve(true);
    if (ensuring) return ensuring;
    ensuring = (async () => {
      if (!hasXterm()) {
        const host = $("#term-xterm");
        if (host) host.textContent = "终端组件未加载（xterm.js 缺失）";
        return false;
      }
      await loadShells();
      if (!sess.term) createTerm();
      const shellId = sess.shell || selectedShellId();
      const ok = await openSession(shellId);
      if (ok) {
        relayout();
        startPoll();
      }
      return ok;
    })();
    const p = ensuring;
    p.finally(() => { if (ensuring === p) ensuring = null; });
    return p;
  }

  // 关闭当前后端会话（不销毁 xterm）
  async function closeSession() {
    stopPoll();
    const id = sess.id;
    sess.id = null;
    sess.alive = false;
    sess.offset = 0;
    if (id != null) {
      try { await fsPost("/api/term/close", { id }); } catch {}
    }
  }

  // 重启 / 切换 shell：关旧会话 + 重建 xterm + 开新会话
  async function restartSession(shellId) {
    await closeSession();
    disposeTerm();
    sess.shell = shellId || selectedShellId();
    if (!createTerm()) return;
    const ok = await openSession(sess.shell);
    if (ok) { relayout(); startPoll(); setTimeout(() => { try { sess.term.focus(); } catch {} }, 0); }
  }

  // ---------- 读轮询 ----------
  function startPoll() {
    if (sess.poll) return;
    if (sess.id == null) return;
    sess.poll = setInterval(pollRead, 60);
  }
  function stopPoll() {
    if (sess.poll) { clearInterval(sess.poll); sess.poll = null; }
  }
  async function pollRead() {
    if (sess.reading || sess.id == null || isCollapsed()) return;
    sess.reading = true;
    try {
      const url = "/api/term/read?id=" + encodeURIComponent(sess.id) +
                  "&offset=" + encodeURIComponent(sess.offset);
      const res = await fetch(url, { cache: "no-store" }).then(r => r.json());
      if (res && !res.error) {
        if (res.data) {
          const bytes = b64ToBytes(res.data);
          if (bytes.length && sess.term) sess.term.write(bytes);
        }
        if (typeof res.offset === "number") sess.offset = res.offset;
        if (res.alive === false && sess.alive) {
          sess.alive = false;
          stopPoll();
          if (sess.term) sess.term.write("\r\n\x1b[33m[进程已退出]\x1b[0m\r\n");
        }
      }
    } catch {
      /* 单次失败忽略，下个 tick 再试 */
    } finally {
      sess.reading = false;
    }
  }

  // ---------- 尺寸：fit + 通知后端 ----------
  function relayout() {
    if (!sess.term || !sess.fit) return;
    if (isCollapsed()) return;
    try { sess.fit.fit(); } catch {}
    const { cols, rows } = dims();
    if (cols === sess.lastCols && rows === sess.lastRows) return;
    sess.lastCols = cols; sess.lastRows = rows;
    if (sess.id != null) {
      fsPost("/api/term/resize", { id: sess.id, cols, rows }).catch(() => {});
    }
  }

  function attachResizeObserver() {
    const host = $("#term-xterm");
    if (!host || sess.ro || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    sess.ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; relayout(); });
    });
    try { sess.ro.observe(host); } catch {}
  }

  // ---------- 主题跟随：监听 data-theme 变化 ----------
  function watchTheme() {
    try {
      const mo = new MutationObserver(() => {
        if (sess.term) {
          try { sess.term.options.theme = termTheme(); } catch {}
        }
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } catch {}
  }

  // ---------- 把命令送进当前会话 ----------
  async function sendToSession(line) {
    expand();
    const ok = await ensureSession();
    if (!ok || sess.id == null) return false;
    await fsPost("/api/term/input", { id: sess.id, data: line + "\r" }).catch(() => {});
    if (sess.term) setTimeout(() => { try { sess.term.focus(); } catch {} }, 0);
    return true;
  }

  // ---------- 运行当前文件（送进终端会话） ----------
  async function runFile(path) {
    path = path || (window.state && state.current);
    if (!path) { if (window.setMsg) setMsg("没有可运行的文件", "err"); return; }
    if (!window.wbIsRunnable(path)) {
      if (window.setMsg) setMsg("该文件类型不支持运行", "err");
      return;
    }
    expand();
    // 优先：把"运行此文件"命令送进真终端
    const ok = await ensureSession();
    if (ok && sess.id != null) {
      const cmd = buildRunCommand(path);
      if (cmd) {
        await fsPost("/api/term/input", { id: sess.id, data: cmd + "\r" }).catch(() => {});
        if (sess.term) setTimeout(() => { try { sess.term.focus(); } catch {} }, 0);
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
  function buildRunCommand(path) {
    const ext = extOf(path);
    const sh = sess.shell || selectedShellId();
    // 用引号包裹相对路径，shell 内基于 ROOT（会话 cwd）执行
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
      ".ps1": (sh === "powershell")
        ? "& " + q
        : 'powershell -NoLogo -File ' + q,
    };
    return map[ext] || "";
  }

  // ---------- 运行任务（送进终端会话） ----------
  async function runTask(name, kind) {
    if (!name) return;
    const line = (kind === "make" ? "make " : "npm run ") + name;
    const ok = await sendToSession(line);
    if (!ok) {
      // 降级：一次性运行
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
    if (clearBtn) clearBtn.onclick = () => { if (sess.term) sess.term.clear(); };

    const collapseBtn = $("#term-collapse");
    if (collapseBtn) collapseBtn.onclick = toggle;

    const head = $("#term-head");
    if (head) head.addEventListener("click", (e) => {
      // 点标题空白处折叠/展开，避开按钮与下拉
      if (e.target.closest("button") || e.target.closest("select")) return;
      toggle();
    });

    const taskRun = $("#term-task-run");
    if (taskRun) taskRun.onclick = runSelectedTask;

    // shell 选择器切换 → 重启会话
    const shellSel = $("#term-shell-sel");
    if (shellSel) shellSel.addEventListener("change", () => {
      const id = shellSel.value;
      if (!id) return;
      if (isCollapsed()) { sess.shell = id; return; }  // 折叠时只记下，展开再起
      restartSession(id);
    });

    // 新建 / 重启会话
    const newBtn = $("#term-new");
    if (newBtn) newBtn.onclick = () => {
      expand();
      restartSession(selectedShellId());
    };

    const st = $("#status-term");
    if (st) st.onclick = toggle;

    // Ctrl+` 切换终端
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "`" || e.key === "~")) {
        e.preventDefault();
        toggle();
      }
    });

    // 窗口尺寸变化 → 重排
    window.addEventListener("resize", () => relayout());

    // 命令面板动作
    if (window.registerAction) {
      registerAction({ name: "切换终端面板", hint: "Ctrl+`", icon: "terminal", run: toggle });
      registerAction({ name: "运行当前文件", hint: "", icon: "play",
                       run: () => runFile(window.state && state.current) });
      registerAction({ name: "新建终端会话", hint: "", icon: "terminal",
                       run: () => { expand(); restartSession(selectedShellId()); } });
    }

    attachResizeObserver();
    watchTheme();
    loadShells();
    loadTasks();
    updateRunButton();

    // 退出时尽量通知后端清理会话
    window.addEventListener("beforeunload", () => {
      if (sess.id != null && navigator.sendBeacon) {
        try {
          navigator.sendBeacon("/api/term/close",
            new Blob([JSON.stringify({ id: sess.id })], { type: "application/json" }));
        } catch {}
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
