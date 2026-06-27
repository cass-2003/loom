/* Workbench 黏合层：命令面板 + 设置 + 工作区记忆 + 快捷键帮助 + 状态栏 */
(function () {
  const $ = (s) => document.querySelector(s);
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ================= 设置 =================
  const SET_KEY = "wb-settings";
  const ACCENTS = [
    { name: "绿", v: "#3fb96f", press: "#34a361" },
    { name: "蓝", v: "#4d8df6", press: "#3f78d8" },
    { name: "青", v: "#37b6c4", press: "#2f9aa6" },
    { name: "紫", v: "#9a7cf0", press: "#8366d8" },
    { name: "粉", v: "#e26aa6", press: "#cc578f" },
    { name: "橙", v: "#e0913c", press: "#c97c2c" },
  ];
  const DEFAULTS = {
    fontSize: 13,
    tabWidth: "2",   // "2" | "4" | "tab"
    accent: "#3fb96f",
    wrap: false,
    autoSave: false,
  };
  let settings = loadSettings();

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SET_KEY) || "{}") || {}; } catch {}
    return Object.assign({}, DEFAULTS, s);
  }
  function persistSettings() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch {}
  }

  // 应用设置到 DOM（即时生效）
  function applySettings() {
    const ed = $("#editor"), gutter = $("#editor-gutter");
    const sideEd = $("#side-editor"), sideGutter = $("#side-gutter");   // 分屏副组同样跟随设置
    const md = document.querySelectorAll(".markdown-body");
    // 字号：损坏/越界的持久值(NaN/负/超大)会让编辑器不可用 → 钳到合理区间
    let fsNum = parseInt(settings.fontSize, 10);
    if (!Number.isFinite(fsNum)) fsNum = DEFAULTS.fontSize;
    fsNum = Math.max(8, Math.min(40, fsNum));
    const fs = fsNum + "px";
    if (ed) ed.style.fontSize = fs;
    if (gutter) gutter.style.fontSize = fs;
    if (sideEd) sideEd.style.fontSize = fs;
    if (sideGutter) sideGutter.style.fontSize = fs;
    md.forEach(m => m.style.fontSize = fs);
    // Tab 宽度
    const tw = settings.tabWidth === "tab" ? 4 : parseInt(settings.tabWidth, 10);
    if (ed) ed.style.tabSize = tw;
    if (gutter) gutter.style.tabSize = tw;
    if (sideEd) sideEd.style.tabSize = tw;
    if (sideGutter) sideGutter.style.tabSize = tw;
    // 自动换行
    const wrapVal = settings.wrap ? "pre-wrap" : "pre";
    if (ed) {
      ed.style.whiteSpace = wrapVal;
      ed.setAttribute("wrap", settings.wrap ? "soft" : "off");
    }
    if (sideEd) {
      sideEd.style.whiteSpace = wrapVal;
      sideEd.setAttribute("wrap", settings.wrap ? "soft" : "off");
    }
    // 强调色
    const ac = ACCENTS.find(a => a.v === settings.accent) || ACCENTS[0];
    document.documentElement.style.setProperty("--accent", ac.v);
    document.documentElement.style.setProperty("--accent2", ac.v);
    document.documentElement.style.setProperty("--accent-press", ac.press);
    updateStatusBar();
  }
  window.wbSettings = () => settings;

  // ---- 设置面板 UI ----
  function renderSettingsUI() {
    // 字号
    const fsInp = $("#set-fontsize"), fsVal = $("#set-fontsize-val");
    fsInp.value = settings.fontSize;
    fsVal.textContent = settings.fontSize + "px";
    // tab 宽度
    $("#set-tabwidth").querySelectorAll("button").forEach(b =>
      b.classList.toggle("on", b.dataset.v === settings.tabWidth));
    // accent swatches
    const sw = $("#set-accent");
    sw.innerHTML = ACCENTS.map(a =>
      `<button class="swatch${a.v === settings.accent ? " on" : ""}" `
      + `data-v="${a.v}" title="${esc(a.name)}" style="background:${a.v}"></button>`).join("");
    sw.querySelectorAll(".swatch").forEach(b => b.onclick = () => {
      settings.accent = b.dataset.v; persistSettings(); applySettings(); renderSettingsUI();
    });
    // toggles
    $("#set-wrap").classList.toggle("on", settings.wrap);
    $("#set-autosave").classList.toggle("on", settings.autoSave);
  }

  function initSettingsPanel() {
    const ov = $("#settings-overlay");
    const open = () => { ov.classList.remove("hidden"); renderSettingsUI(); };
    const close = () => ov.classList.add("hidden");
    window.openSettings = open;
    $("#btn-settings").onclick = open;
    $("#settings-close").onclick = close;
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });

    $("#set-fontsize").addEventListener("input", (e) => {
      settings.fontSize = parseInt(e.target.value, 10);
      $("#set-fontsize-val").textContent = settings.fontSize + "px";
      persistSettings(); applySettings();
    });
    $("#set-tabwidth").querySelectorAll("button").forEach(b => b.onclick = () => {
      settings.tabWidth = b.dataset.v; persistSettings(); applySettings(); renderSettingsUI();
    });
    $("#set-wrap").onclick = () => {
      settings.wrap = !settings.wrap; persistSettings(); applySettings(); renderSettingsUI();
    };
    $("#set-autosave").onclick = () => {
      settings.autoSave = !settings.autoSave; persistSettings(); renderSettingsUI();
    };
    $("#set-reset").onclick = () => {
      settings = Object.assign({}, DEFAULTS);
      persistSettings(); applySettings(); renderSettingsUI();
    };
  }

  // ---- 自动保存：监听编辑器输入，防抖后调 save ----
  let autoSaveTimer = null;
  function initAutoSave() {
    const ed = $("#editor");
    if (!ed) return;
    ed.addEventListener("input", () => {
      if (!settings.autoSave) return;
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        if (settings.autoSave && window.state && state.dirty
            && state.kind === "text" && typeof save === "function") {
          save();
        }
      }, 1200);
    });
  }

  // ================= 状态栏 =================
  const EXT_LANG = {
    js: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript",
    py: "Python", go: "Go", rs: "Rust", java: "Java", c: "C", cpp: "C++",
    h: "C/C++ Header", css: "CSS", scss: "SCSS", html: "HTML", htm: "HTML",
    xml: "XML", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
    md: "Markdown", markdown: "Markdown", sh: "Shell", bash: "Shell",
    ps1: "PowerShell", bat: "Batch", sql: "SQL", vue: "Vue", svelte: "Svelte",
    txt: "纯文本", ini: "INI", conf: "Config",
  };
  function langOf(path) {
    if (!path) return "";
    const ext = (path.split(".").pop() || "").toLowerCase();
    return EXT_LANG[ext] || (ext ? ext.toUpperCase() : "纯文本");
  }
  // 字数：中文按字计，英文按词计
  function countWords(text) {
    if (!text) return 0;
    const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
    const words = (text.match(/[A-Za-z0-9_]+/g) || []).length;
    return cjk + words;
  }

  function updateStatusBar() {
    const st = window.state || {};
    const posEl = $("#status-pos"), langEl = $("#status-lang"),
          wordsEl = $("#status-words"), encEl = $("#status-enc");
    if (!posEl) return;
    const isText = st.kind === "text" && !$("#editor-wrap").classList.contains("hidden");
    if (!isText) {
      [posEl, langEl, wordsEl, encEl].forEach(e => e.classList.add("hidden"));
      return;
    }
    const ed = $("#editor");
    const val = ed.value;
    const caret = ed.selectionStart;
    const before = val.slice(0, caret);
    const line = before.split("\n").length;
    const col = caret - before.lastIndexOf("\n");
    posEl.textContent = `行 ${line}, 列 ${col}`;
    langEl.textContent = langOf(st.current);
    wordsEl.textContent = countWords(val) + " 字";
    encEl.textContent = "UTF-8";
    [posEl, langEl, wordsEl, encEl].forEach(e => e.classList.remove("hidden"));
  }
  window.updateStatusBar = updateStatusBar;

  function initStatusBar() {
    const ed = $("#editor");
    if (!ed) return;
    ["keyup", "click", "input", "scroll", "select"].forEach(ev =>
      ed.addEventListener(ev, updateStatusBar));
    ed.addEventListener("focus", updateStatusBar);
    document.addEventListener("selectionchange", () => {
      if (document.activeElement === ed) updateStatusBar();
    });
  }

  // ================= 能力注册表 =================
  // Phase 1 生态底座：先把命令面板的动作升级为带元信息的 capability。
  // 旧模块仍可调用 registerAction；内部会被正规化为 capability。
  const capabilities = [];
  const capabilityById = new Map();

  const REQ_LABELS = {
    workspace: "需要打开工作区",
    currentFile: "需要打开文件",
    editableFile: "需要可编辑文件",
    markdown: "仅 Markdown 可用",
    gitRepo: "需要 Git 仓库",
    terminal: "需要终端组件",
  };

  function hasWorkspace() {
    return typeof window.hasOpenWorkspace === "function" ? window.hasOpenWorkspace() : !!window.currentRoot;
  }
  function activeTab() {
    return window.wb && window.state ? window.wb.tabByPath(window.state.activeTab) : null;
  }
  function isMarkdownTab() {
    const t = activeTab();
    return !!(t && (t.ext === ".md" || t.ext === ".markdown" || t.kind === "md"));
  }
  function isEditableFile() {
    return !!(window.state && (state.kind === "text" || state.kind === "md"));
  }
  function gitHasRepo() {
    return !!(window.gitState && window.gitState.repo);
  }
  function reqOk(req) {
    if (req === "workspace") return hasWorkspace();
    if (req === "currentFile") return !!(window.state && state.current);
    if (req === "editableFile") return isEditableFile();
    if (req === "markdown") return isMarkdownTab();
    if (req === "gitRepo") return gitHasRepo();
    if (req === "terminal") return !!window.Terminal;
    return true;
  }
  function capabilityState(cap) {
    if (typeof cap.enabled === "function") {
      try {
        const r = cap.enabled();
        if (r === false) return { enabled: false, reason: cap.disabledReason || "当前不可用" };
        if (typeof r === "string") return { enabled: false, reason: r };
      } catch {
        return { enabled: false, reason: "状态检查失败" };
      }
    }
    const missing = (cap.requires || []).filter(r => !reqOk(r));
    if (missing.length) return { enabled: false, reason: REQ_LABELS[missing[0]] || "当前不可用" };
    return { enabled: true, reason: "" };
  }

  function normalizeCapability(a) {
    const title = a.title || a.name || a.id || "未命名能力";
    const id = a.id || ("legacy." + title.toLowerCase().replace(/\s+/g, "-"));
    return Object.assign({
      id,
      title,
      name: title,
      kind: "command",
      surface: ["commandPalette"],
      requires: [],
      risk: "read",
      hint: "",
      icon: "command",
      description: "",
      run: () => {},
    }, a, { id, title, name: title });
  }
  function registerCapability(a) {
    const cap = normalizeCapability(a);
    if (capabilityById.has(cap.id)) {
      const idx = capabilities.findIndex(x => x.id === cap.id);
      if (idx >= 0) capabilities[idx] = cap;
    } else {
      capabilities.push(cap);
    }
    capabilityById.set(cap.id, cap);
    return cap;
  }
  function registerAction(a) { return registerCapability(a); }
  window.registerAction = registerAction;
  window.registerCapability = registerCapability;
  window.getCapabilities = () => capabilities.slice();

  function buildDefaultActions() {
    const A = registerAction;
    A({ id: "file.new", name: "新建文件", hint: "在根目录", icon: "filePlus",
        requires: ["workspace"], risk: "write",
        run: () => { typeof fsCreate === "function" && fsCreate("", document.querySelector("#tree")); } });
    A({ id: "file.newFolder", name: "新建文件夹", hint: "在根目录", icon: "folderPlus",
        requires: ["workspace"], risk: "write",
        run: () => { typeof fsCreateDir === "function" && fsCreateDir("", document.querySelector("#tree")); } });
    A({ id: "file.save", name: "保存文件", hint: "Ctrl+S", icon: "save",
        requires: ["editableFile"], risk: "write",
        run: () => { typeof save === "function" && save(); } });
    A({ id: "file.quickOpen", name: "快速打开文件", hint: "Ctrl+P", icon: "search",
        requires: ["workspace"],
        run: () => { typeof openQuickOpen === "function" && openQuickOpen(); } });
    A({ id: "workspace.open", name: "打开工作区", hint: "文件夹", icon: "folderOpen",
        run: () => {
          const btn = document.querySelector("#btn-open-folder");
          if (btn) btn.click();
        } });
    A({ id: "workspace.showEmpty", name: "显示工作区空状态", hint: "工作区", icon: "folder",
        requires: ["workspace"],
        run: () => { typeof showEmptyWorkspace === "function" && showEmptyWorkspace(window.currentRoot); } });
    A({ id: "editor.find", name: "在文件中查找/替换", hint: "Ctrl+F", icon: "search",
        requires: ["editableFile"],
        run: () => { typeof openFind === "function" && openFind(); } });
    A({ id: "theme.toggle", name: "切换深浅主题", hint: "", icon: "moon",
        run: () => { typeof toggleTheme === "function" && toggleTheme(); } });
    A({ id: "settings.open", name: "打开设置", hint: "", icon: "gear", run: () => window.openSettings && openSettings() });
    A({ id: "help.open", name: "快捷键帮助", hint: "?", icon: "help", run: () => openHelp() });
    // 视图切换
    [["资源管理器", "files", "folder"], ["源代码管理", "git", "git"],
     ["搜索", "search", "search"], ["便签 / Todo", "notes", "checkSquare"],
     ["工具箱", "tools", "tools"], ["项目记忆", "project", "notebook"]].forEach(([label, view, icon]) =>
      A({ id: "view." + view, name: "切换到：" + label, hint: "视图", icon,
          run: () => { typeof switchView === "function" && switchView(view); } }));
    // Markdown 导出
    A({ id: "markdown.exportHtml", name: "导出为 HTML", hint: "Markdown", icon: "download",
        requires: ["markdown"], risk: "write",
        run: () => {
          if (typeof exportHtml === "function") exportHtml();
        } });
    A({ id: "markdown.openToc", name: "Markdown: 打开大纲", hint: "Markdown", icon: "list",
        requires: ["markdown"],
        run: () => {
          const btn = document.querySelector("#btn-toc");
          if (btn) btn.click();
        } });
    A({ id: "markdown.openExportMenu", name: "Markdown: 打开导出菜单", hint: "Markdown", icon: "download",
        requires: ["markdown"],
        run: () => {
          const btn = document.querySelector("#btn-md-export");
          if (btn) btn.click();
        } });
    A({ id: "markdown.print", name: "打印 / 另存 PDF", hint: "Markdown", icon: "printer",
        requires: ["markdown"],
        run: () => {
          window.print();
        } });
    // 刷新文件树
    A({ id: "workspace.refreshTree", name: "刷新文件树", hint: "", icon: "refresh",
        requires: ["workspace"],
        run: () => { if (window.state) state.expanded.clear(); typeof initTree === "function" && initTree(); } });
    // 关闭当前标签
    A({ id: "tab.closeCurrent", name: "关闭当前标签", hint: "", icon: "close",
        requires: ["currentFile"],
        run: () => { if (window.state && state.activeTab && typeof closeTab === "function") closeTab(state.activeTab); } });
    // Git 提交（焦点到消息框）
    A({ id: "git.commit.focus", name: "Git: 提交", hint: "Ctrl+Enter", icon: "check",
        requires: ["workspace"],
        run: () => {
          typeof switchView === "function" && switchView("git");
          const m = document.querySelector("#git-msg"); if (m) m.focus();
        } });
    A({ id: "git.refresh", name: "Git: 刷新状态", hint: "SCM", icon: "refresh",
        requires: ["workspace"],
        run: () => { typeof switchView === "function" && switchView("git"); typeof refreshGit === "function" && refreshGit(); } });
    A({ id: "git.push", name: "Git: 推送", hint: "SCM", icon: "upload",
        requires: ["workspace", "gitRepo"], risk: "network",
        run: () => {
          const btn = document.querySelector("#git-push");
          if (btn) btn.click();
        } });
    A({ id: "git.branchOps", name: "Git: 分支操作", hint: "新建 / 检出 / 删除", icon: "branch",
        requires: ["workspace", "gitRepo"], risk: "write",
        run: () => {
          typeof switchView === "function" && switchView("git");
          const btn = document.querySelector("#git-branch-ops");
          if (btn) btn.click();
        } });
    A({ id: "git.stash", name: "Git: 储藏当前更改", hint: "Stash", icon: "download",
        requires: ["workspace", "gitRepo"], risk: "write",
        run: () => {
          const btn = document.querySelector("#git-stash-save");
          if (btn) btn.click();
        } });
    [
      ["requirements", "Requirements"],
      ["progress", "Progress"],
      ["log", "Log"],
      ["memory", "Memory"],
    ].forEach(([name, label]) => A({
      id: "project.open." + name,
      name: "项目记忆: " + label,
      hint: "Project",
      icon: "notebook",
      run: () => {
        typeof switchView === "function" && switchView("project");
        if (window.setProjectDoc) window.setProjectDoc(name);
      },
    }));
    [
      ["requirements", "Requirements"],
      ["progress", "Progress"],
      ["log", "Log"],
      ["memory", "Memory"],
    ].forEach(([name, label]) => A({
      id: "project.edit." + name,
      name: "项目记忆: 打开源文件 " + label,
      hint: "state/" + label.toUpperCase() + ".md",
      icon: "fileText",
      risk: "write",
      run: () => {
        if (window.openProjectStateFile) window.openProjectStateFile(name);
      },
    }));
    A({ id: "project.appendDecision", name: "项目记忆: 追加决策记录", hint: "Decision", icon: "check",
        risk: "write",
        run: () => {
          typeof switchView === "function" && switchView("project");
          if (window.appendProjectRecord) window.appendProjectRecord("decision");
        } });
    A({ id: "project.appendValidation", name: "项目记忆: 追加验证记录", hint: "Validation", icon: "play",
        risk: "write",
        run: () => {
          typeof switchView === "function" && switchView("project");
          if (window.appendProjectRecord) window.appendProjectRecord("validation");
        } });
  }

  // ================= 命令面板 =================
  let cpResults = [], cpSel = 0;
  function cpIsOpen() { return !$("#cmdpalette").classList.contains("hidden"); }
  function openCmdPalette() {
    if (cpIsOpen()) return;
    const inp = $("#cp-input");
    $("#cmdpalette").classList.remove("hidden");
    inp.value = "";
    inp.focus();
    cpRender("");
  }
  function closeCmdPalette() { $("#cmdpalette").classList.add("hidden"); }
  window.openCmdPalette = openCmdPalette;

  // 子序列模糊匹配（同 quickopen 思路，简化）
  function fuzzy(query, text) {
    const q = query.toLowerCase(), s = text.toLowerCase();
    if (!q) return { marks: [], score: 0 };
    const marks = []; let qi = 0, score = 0, prev = -2;
    for (let i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] === q[qi]) {
        marks.push(i);
        if (i === prev + 1) score += 5;
        score += 1; prev = i; qi++;
      }
    }
    if (qi < q.length) return null;
    score -= text.length * 0.02;
    return { marks, score };
  }

  function cpRender(query) {
    query = query.trim();
    let items;
    if (!query) {
      items = capabilities.map((a) => ({ a, marks: [] }));
    } else {
      const scored = [];
      capabilities.forEach(a => {
        const m = fuzzy(query, a.title || a.name);
        if (m) scored.push({ a, marks: m.marks, score: m.score });
      });
      scored.sort((x, y) => y.score - x.score);
      items = scored;
    }
    cpResults = items; cpSel = 0;
    const list = $("#cp-list");
    if (!items.length) {
      list.innerHTML = `<div class="cp-empty">无匹配命令</div>`;
      return;
    }
    list.innerHTML = items.map((it, idx) => {
      const capState = capabilityState(it.a);
      const title = it.a.title || it.a.name;
      const hlSet = new Set(it.marks);
      let nameHtml = "";
      for (let i = 0; i < title.length; i++) {
        const ch = esc(title[i]);
        nameHtml += hlSet.has(i) ? `<span class="cp-hl">${ch}</span>` : ch;
      }
      const meta = capState.enabled ? (it.a.hint || it.a.description || "") : capState.reason;
      const risk = it.a.risk && it.a.risk !== "read" ? `<span class="cp-risk">${esc(it.a.risk)}</span>` : "";
      return `<div class="cp-item${idx === 0 ? " sel" : ""}${capState.enabled ? "" : " disabled"}" data-idx="${idx}">`
        + `<span class="cp-ico">${svgIcon(it.a.icon || "command", 15)}</span>`
        + `<span class="cp-name">${nameHtml}</span>`
        + risk
        + (meta ? `<span class="cp-hint">${esc(meta)}</span>` : "")
        + `</div>`;
    }).join("");
    list.querySelectorAll(".cp-item").forEach(el => {
      el.addEventListener("click", () => cpChoose(parseInt(el.dataset.idx, 10)));
      el.addEventListener("mousemove", () => {
        const idx = parseInt(el.dataset.idx, 10);
        if (idx !== cpSel) cpSetSel(idx);
      });
    });
  }
  function cpSetSel(idx) {
    const items = $("#cp-list").querySelectorAll(".cp-item");
    if (!items.length) return;
    idx = Math.max(0, Math.min(items.length - 1, idx));
    items[cpSel]?.classList.remove("sel");
    cpSel = idx;
    items[cpSel].classList.add("sel");
    items[cpSel].scrollIntoView({ block: "nearest" });
  }
  function cpChoose(idx) {
    const it = cpResults[idx];
    if (!it) return;
    const capState = capabilityState(it.a);
    if (!capState.enabled) {
      if (window.setMsg) window.setMsg(capState.reason || "当前不可用", "warn");
      cpRender($("#cp-input").value || "");
      return;
    }
    closeCmdPalette();
    try { it.a.run(); } catch (e) { console.error("命令执行失败", e); }
  }

  function initCmdPalette() {
    $("#cp-input").addEventListener("input", (e) => cpRender(e.target.value));
    $("#cp-input").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); cpSetSel(cpSel + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cpSetSel(cpSel - 1); }
      else if (e.key === "Enter") { e.preventDefault(); cpChoose(cpSel); }
      else if (e.key === "Escape") { e.preventDefault(); closeCmdPalette(); }
    });
    $("#cmdpalette").addEventListener("mousedown", (e) => {
      if (e.target === $("#cmdpalette")) closeCmdPalette();
    });
    $("#btn-cmdpalette").onclick = openCmdPalette;
  }

  // ================= 快捷键帮助 =================
  const SHORTCUTS = [
    ["Ctrl + S", "保存当前文件"],
    ["Ctrl + P", "快速打开文件"],
    ["Ctrl + Shift + P", "命令面板"],
    ["Ctrl + F", "在文件中查找 / 替换"],
    ["Ctrl + Enter", "Git 提交（消息框内）"],
    ["Enter / Shift+Enter", "查找下一个 / 上一个"],
    ["Tab", "插入缩进"],
    ["?", "打开本帮助"],
    ["Esc", "关闭浮层 / 菜单"],
  ];
  function openHelp() {
    const body = $("#help-body");
    body.innerHTML = SHORTCUTS.map(([k, d]) => {
      const keys = k.split(" + ").map(x => `<kbd>${esc(x)}</kbd>`).join("<span class=\"help-plus\">+</span>");
      return `<div class="help-row"><span class="help-keys">${keys}</span>`
        + `<span class="help-desc">${esc(d)}</span></div>`;
    }).join("");
    $("#help-overlay").classList.remove("hidden");
  }
  function closeHelp() { $("#help-overlay").classList.add("hidden"); }
  window.openHelp = openHelp;
  function initHelp() {
    $("#btn-help").onclick = openHelp;
    $("#help-close").onclick = closeHelp;
    $("#help-overlay").addEventListener("mousedown", (e) => {
      if (e.target === $("#help-overlay")) closeHelp();
    });
  }

  // ================= 全局快捷键 =================
  function inField(e) {
    const t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  }
  function initKeys() {
    document.addEventListener("keydown", (e) => {
      // Ctrl+Shift+P 命令面板
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (cpIsOpen()) closeCmdPalette(); else openCmdPalette();
        return;
      }
      // ? 帮助（不在输入框内时）
      if (e.key === "?" && !inField(e) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        $("#help-overlay").classList.contains("hidden") ? openHelp() : closeHelp();
        return;
      }
      if (e.key === "Escape") {
        if (cpIsOpen()) { closeCmdPalette(); return; }
        if (!$("#settings-overlay").classList.contains("hidden")) { $("#settings-overlay").classList.add("hidden"); return; }
        if (!$("#help-overlay").classList.contains("hidden")) { closeHelp(); return; }
      }
    });
  }

  // ================= 初始化入口 =================
  function initWorkbench() {
    buildDefaultActions();
    initSettingsPanel();
    initAutoSave();
    initStatusBar();
    initCmdPalette();
    initHelp();
    initKeys();
    applySettings();   // 应用持久化设置（字号/换行/tab/强调色）
    updateStatusBar();
    if (window.hydrateIcons) hydrateIcons();
  }
  window.initWorkbench = initWorkbench;
})();
