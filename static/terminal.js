/* Workbench 集成终端 / 运行文件 / 任务运行器
   命令仅在服务器本机（127.0.0.1）执行，复用 fsPost 的 CSRF。 */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 可运行的扩展名（与后端 RUN_INTERPRETERS 对应的常用集合）
  const RUNNABLE = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".bash", ".ps1"]);
  const extOf = (name) => {
    const i = (name || "").lastIndexOf(".");
    return i >= 0 ? name.slice(i).toLowerCase() : "";
  };
  window.wbIsRunnable = (path) => RUNNABLE.has(extOf(path || ""));

  const history = [];
  let histIdx = -1;      // -1 表示在最新（输入行）
  let busy = false;
  let collapsed = true;

  function panel() { return $("#terminal-panel"); }
  function isCollapsed() { return panel().classList.contains("collapsed"); }

  function setCollapsed(v) {
    collapsed = v;
    panel().classList.toggle("collapsed", v);
    const tw = $("#term-collapse");
    if (tw) tw.classList.toggle("up", !v);
    const st = $("#status-term");
    if (st) st.classList.toggle("active", !v);
    if (!v) {
      // 展开时聚焦输入并滚到底
      const inp = $("#term-input");
      if (inp) setTimeout(() => inp.focus(), 0);
      scrollBottom();
    }
  }
  function expand() { if (isCollapsed()) setCollapsed(false); }
  function toggle() { setCollapsed(!isCollapsed()); }
  window.toggleTerminal = toggle;
  window.openTerminal = expand;

  function scrollBottom() {
    const out = $("#term-out");
    if (out) out.scrollTop = out.scrollHeight;
  }

  // 往输出区追加一个块。stderr 标红。
  function appendBlock({ cmd, stdout, stderr, code, note, kind }) {
    const out = $("#term-out");
    const block = document.createElement("div");
    block.className = "term-block";
    let html = "";
    if (cmd) {
      html += `<div class="term-cmd"><span class="term-cmd-prompt">$</span>`
        + `<span class="term-cmd-text">${esc(cmd)}</span></div>`;
    }
    if (note) html += `<div class="term-note">${esc(note)}</div>`;
    if (stdout) html += `<pre class="term-stdout">${esc(stdout)}</pre>`;
    if (stderr) html += `<pre class="term-stderr">${esc(stderr)}</pre>`;
    if (typeof code === "number") {
      const ok = code === 0;
      html += `<div class="term-exit ${ok ? "ok" : "bad"}">`
        + `退出码 ${code}${ok ? "" : " ✗"}</div>`;
    }
    block.innerHTML = html || `<div class="term-note">（无输出）</div>`;
    out.appendChild(block);
    scrollBottom();
  }
  window.termAppend = appendBlock;

  function setCwdLabel(cwd) {
    const el = $("#term-cwd");
    if (el) el.textContent = cwd ? "/" + cwd : "/";
  }

  // 执行一条 shell 命令
  async function runCmd(cmd) {
    if (busy) return;
    cmd = (cmd || "").trim();
    if (!cmd) return;
    history.push(cmd);
    histIdx = -1;
    busy = true;
    const inp = $("#term-input");
    if (inp) inp.disabled = true;
    appendBlock({ cmd });
    // 占位“运行中”
    const out = $("#term-out");
    const pending = document.createElement("div");
    pending.className = "term-pending";
    pending.textContent = "运行中…";
    out.appendChild(pending);
    scrollBottom();
    try {
      const res = await fsPost("/api/exec", { cmd });
      pending.remove();
      if (res.error) {
        appendBlock({ stderr: res.error });
      } else {
        if (res.cwd != null) setCwdLabel(res.cwd);
        appendBlock({ stdout: res.stdout, stderr: res.stderr, code: res.code });
      }
    } catch (e) {
      pending.remove();
      appendBlock({ stderr: "请求失败: " + (e && e.message ? e.message : e) });
    } finally {
      busy = false;
      if (inp) { inp.disabled = false; inp.value = ""; inp.focus(); }
    }
  }

  // 运行当前文件（被运行按钮 / 命令面板调用）
  async function runFile(path) {
    path = path || (window.state && state.current);
    if (!path) { if (window.setMsg) setMsg("没有可运行的文件", "err"); return; }
    if (!window.wbIsRunnable(path)) {
      if (window.setMsg) setMsg("该文件类型不支持运行", "err");
      return;
    }
    expand();
    appendBlock({ cmd: "▶ 运行文件: " + path });
    const out = $("#term-out");
    const pending = document.createElement("div");
    pending.className = "term-pending";
    pending.textContent = "运行中…";
    out.appendChild(pending);
    scrollBottom();
    try {
      const res = await fsPost("/api/run-file", { path });
      pending.remove();
      if (res.error) {
        appendBlock({ stderr: res.error });
      } else {
        appendBlock({
          note: res.interpreter ? "解释器: " + res.interpreter : "",
          stdout: res.stdout, stderr: res.stderr, code: res.code,
        });
      }
    } catch (e) {
      pending.remove();
      appendBlock({ stderr: "请求失败: " + (e && e.message ? e.message : e) });
    }
  }
  window.runCurrentFile = runFile;

  // 运行任务（npm/make）
  async function runTask(name, kind) {
    if (!name) return;
    expand();
    appendBlock({ cmd: (kind === "make" ? "make " : "npm run ") + name });
    const out = $("#term-out");
    const pending = document.createElement("div");
    pending.className = "term-pending";
    pending.textContent = "运行中…";
    out.appendChild(pending);
    scrollBottom();
    try {
      const res = await fsPost("/api/run-task", { name, kind });
      pending.remove();
      if (res.error) appendBlock({ stderr: res.error });
      else appendBlock({ stdout: res.stdout, stderr: res.stderr, code: res.code });
    } catch (e) {
      pending.remove();
      appendBlock({ stderr: "请求失败: " + (e && e.message ? e.message : e) });
    }
  }

  // 加载任务列表填充下拉
  let tasksLoaded = false;
  async function loadTasks(force) {
    if (tasksLoaded && !force) return;
    const sel = $("#term-task-sel");
    if (!sel) return;
    try {
      const data = await fetch("/api/tasks").then(r => r.json());
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

  // 运行当前下拉选中的任务
  function runSelectedTask() {
    const sel = $("#term-task-sel");
    if (!sel || !sel.value) return;
    const [kind, name] = sel.value.split(/:(.+)/);
    if (name) runTask(name, kind);
  }

  // 在 #tabbar 上注入“运行此文件”按钮（随激活标签动态显隐）
  function ensureRunButton() {
    let btn = $("#tab-run-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "tab-run-btn";
      btn.className = "tab-run-btn hidden";
      btn.title = "运行此文件（在服务器本机执行）";
      btn.innerHTML = svgIcon("play", 14) + "<span>运行</span>";
      btn.onclick = () => runFile(window.state && state.current);
      // 放到 tabbar 末尾右侧
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

  // ---------- 事件绑定 ----------
  function init() {
    setCwdLabel("");
    // 输入框
    const inp = $("#term-input");
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runCmd(inp.value);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!history.length) return;
        if (histIdx === -1) histIdx = history.length - 1;
        else if (histIdx > 0) histIdx--;
        inp.value = history[histIdx] || "";
        inp.setSelectionRange(inp.value.length, inp.value.length);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (histIdx === -1) return;
        if (histIdx < history.length - 1) { histIdx++; inp.value = history[histIdx]; }
        else { histIdx = -1; inp.value = ""; }
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    });
    $("#term-clear").onclick = () => { $("#term-out").innerHTML = ""; };
    $("#term-collapse").onclick = toggle;
    $("#term-head").addEventListener("click", (e) => {
      // 点击标题空白区也可折叠/展开，但避开按钮与下拉
      if (e.target.closest("button") || e.target.closest("select")) return;
      toggle();
    });
    $("#term-task-run").onclick = runSelectedTask;
    $("#term-task-sel").addEventListener("change", () => { /* 选择后由按钮运行 */ });
    const st = $("#status-term");
    if (st) st.onclick = toggle;

    // Ctrl+` 切换终端
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "`" || e.key === "~")) {
        e.preventDefault();
        toggle();
      }
    });

    // 命令面板动作
    if (window.registerAction) {
      registerAction({ name: "切换终端面板", hint: "Ctrl+`", icon: "terminal", run: toggle });
      registerAction({ name: "运行当前文件", hint: "", icon: "play",
                       run: () => runFile(window.state && state.current) });
    }

    loadTasks();
    updateRunButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
