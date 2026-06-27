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
    viewer: "需要打开查看器文件",
    gitRepo: "需要 Git 仓库",
    gitChanges: "需要 Git 变更",
    terminal: "需要终端组件",
  };
  const RISK_LABELS = {
    read: "只读",
    write: "写入",
    exec: "执行",
    network: "网络",
  };
  const RISK_DESCRIPTIONS = {
    read: "只读取或展示信息，不写入工作区。",
    write: "会写入文件、任务、记忆或本地状态。",
    exec: "可能执行本机命令，必须有确认和日志。",
    network: "可能访问网络或远端服务。",
  };
  window.describeWorkbenchRisk = (risk) => ({
    key: risk || "read",
    label: RISK_LABELS[risk || "read"] || String(risk || "read"),
    description: RISK_DESCRIPTIONS[risk || "read"] || "自定义风险等级",
  });

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
  function isViewerFile() {
    return !!(window.state && state.kind === "viewer");
  }
  function gitHasRepo() {
    return !!(window.gitState && window.gitState.repo);
  }
  function gitChangedFiles() {
    if (!window.gitState) return [];
    const all = (gitState.stagedFiles || []).concat(gitState.unstagedFiles || []);
    const seen = new Set();
    return all.filter(f => {
      const key = f.repoPath || f.path || "";
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function gitHasChanges() {
    return gitHasRepo() && gitChangedFiles().length > 0;
  }
  function reqOk(req) {
    if (req === "workspace") return hasWorkspace();
    if (req === "currentFile") return !!(window.state && state.current);
    if (req === "editableFile") return isEditableFile();
    if (req === "markdown") return isMarkdownTab();
    if (req === "viewer") return isViewerFile();
    if (req === "gitRepo") return gitHasRepo();
    if (req === "gitChanges") return gitHasChanges();
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
      source: "builtin",
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

  async function createTaskFromSeed(seed, fallbackMsg) {
    if (!window.addWorkflowTask) {
      if (window.setMsg) window.setMsg(fallbackMsg || "任务面板尚未就绪", "warn");
      return;
    }
    await window.addWorkflowTask(seed);
  }

  function workspaceLayoutBrief() {
    if (window.getWorkspaceLayoutSnapshot && window.formatWorkspaceLayoutBrief) {
      return window.formatWorkspaceLayoutBrief(window.getWorkspaceLayoutSnapshot());
    }
    const roots = Array.isArray(window.currentWorkspaceRoots) ? window.currentWorkspaceRoots : [];
    return [
      "# Workspace Layout Snapshot",
      "",
      `- workspaceId: ${window.currentWorkspaceId || "none"}`,
      `- activeFile: ${window.state && state.current ? state.current : "none"}`,
      "",
      "## Roots",
      ...(roots.length ? roots.map((r, i) => `- root[${i}]: ${r}`) : ["- root: none"]),
    ].join("\n");
  }

  function layoutLogLines() {
    const text = workspaceLayoutBrief();
    return text.split("\n").filter(line =>
      /^- (workspaceId|activeFile|activeGroup|sidebarCollapsed|sideOrient):/.test(line));
  }

  function workspaceLayoutTaskSeed() {
    const snapshot = window.getWorkspaceLayoutSnapshot ? window.getWorkspaceLayoutSnapshot() : null;
    const mainCount = snapshot && snapshot.main && snapshot.main.tabs ? snapshot.main.tabs.length : 0;
    const sideCount = snapshot && snapshot.side && snapshot.side.tabs ? snapshot.side.tabs.length : 0;
    return {
      title: "工作区布局交接: 当前上下文",
      goal: "记录当前工作区根目录、打开文件、分栏和 UI 状态，用于后续审计、Agent handoff 或恢复工作上下文。",
      plan: [
        "确认工作区根目录与当前活动文件是否正确",
        "检查主编辑组和副分栏打开的文件是否符合当前任务",
        "把布局 brief 复制给外部 Agent / CLI 或写入 Project Memory",
        "后续改动完成后更新任务证据和验证记录",
      ],
      evidence: [],
      log: [
        `Created from workspace layout snapshot`,
        `Main tabs: ${mainCount}`,
        `Side tabs: ${sideCount}`,
        ...workspaceLayoutBrief().split("\n"),
      ],
      next: "Use the layout snapshot as the handoff context before making the next change.",
    };
  }

  async function copyWorkspaceLayoutBrief() {
    const text = workspaceLayoutBrief();
    try {
      await navigator.clipboard.writeText(text);
      if (window.setMsg) window.setMsg("已复制工作区布局 brief", "ok");
    } catch {
      prompt("复制下面的工作区布局 brief：", text);
    }
  }

  function currentFileTaskSeed(kind) {
    const st = window.state || {};
    const tab = activeTab();
    const path = st.current || (tab && tab.path) || "";
    const name = (tab && tab.name) || (path ? path.split("/").pop() : "当前文件");
    const lang = (tab && (tab.ext || tab.kind)) || st.kind || "file";
    const workspace = window.currentWorkspaceId || window.currentRoot || "current workspace";
    const isMd = kind === "markdown";
    return {
      title: isMd ? `Markdown 验证: ${name}` : `文件审计: ${name}`,
      goal: isMd
        ? `验证 Markdown 文档 ${path} 的编辑、预览、导出和保存链路。`
        : `基于当前文件 ${path} 创建上下文任务，完成审计、修改或验证闭环。`,
      plan: isMd ? [
        "确认文档能以 Vditor/Markdown 视图正常打开",
        "检查大纲、图片、代码块、表格或 Mermaid 等关键内容",
        "执行保存或导出验证，并记录产物路径",
        "把验证结果同步到任务证据或 Project Memory",
      ] : [
        "阅读当前文件和相关上下文",
        "明确要修复或验证的行为",
        "实施最小安全变更",
        "运行相关语法、单元或浏览器烟测",
        "记录验证结果和后续事项",
      ],
      evidence: [],
      log: [
        `Created from current file: ${path}`,
        `Workspace: ${workspace}`,
        `Kind: ${lang}`,
        ...layoutLogLines(),
      ],
      next: isMd ? "Run Markdown smoke/export checks and attach evidence." : "Inspect the file and choose the narrowest validation path.",
    };
  }

  function gitTaskSeed() {
    const files = gitChangedFiles();
    const branch = window.gitState && gitState.branch ? gitState.branch : "(unknown branch)";
    const limit = 12;
    const fileLines = files.slice(0, limit).map(f =>
      `${f.status || "M"} ${f.repoPath || f.path || "(unknown)"}`);
    if (files.length > limit) fileLines.push(`...and ${files.length - limit} more files`);
    return {
      title: `Git 变更审计: ${branch}`,
      goal: `审计当前 Git 工作区变更，确认行为正确、风险可控，并形成可提交的验证记录。`,
      plan: [
        "查看 Git diff 和 staged/unstaged 文件列表",
        "识别可能的行为回归、安全风险和缺失验证",
        "修复必要问题或拆分不相关变更",
        "运行语法检查、相关 smoke 或打包验证",
        "记录证据并准备原子提交",
      ],
      evidence: [],
      log: [
        `Created from Git changes on ${branch}`,
        `Changed files: ${files.length}`,
        ...fileLines,
        ...layoutLogLines(),
      ],
      next: "Open Source Control, inspect diffs, and attach validation output.",
    };
  }

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
    A({ id: "workspace.copyLayoutBrief", name: "工作区: 复制布局 brief", hint: "Layout", icon: "copy",
        requires: ["workspace"], risk: "read",
        run: () => copyWorkspaceLayoutBrief() });
    A({ id: "task.fromWorkspaceLayout", name: "任务: 从工作区布局创建交接任务", hint: "Layout", icon: "columns",
        requires: ["workspace"], risk: "write",
        run: () => createTaskFromSeed(workspaceLayoutTaskSeed()) });
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
     ["工具箱", "tools", "tools"], ["项目记忆", "project", "notebook"],
     ["任务 / Agent", "tasks", "listChecks"], ["Skills / Playbooks", "ecosystem", "blocks"]].forEach(([label, view, icon]) =>
      A({ id: "view." + view, name: "切换到：" + label, hint: "视图", icon,
          run: () => { typeof switchView === "function" && switchView(view); } }));
    // Markdown 导出
    A({ id: "markdown.exportHtml", name: "导出为 HTML", hint: "Markdown", icon: "download",
        requires: ["markdown"], risk: "write",
        enabled: () => {
          const api = window.wbMarkdownExport;
          if (!api || !api.actionState) return "Markdown 导出状态尚未就绪";
          const st = api.actionState("html");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          if (window.wbMarkdownExport && window.wbMarkdownExport.run) window.wbMarkdownExport.run("html");
        } });
    A({ id: "markdown.openToc", name: "Markdown: 打开大纲", hint: "Markdown", icon: "list",
        requires: ["markdown"],
        enabled: () => {
          const api = window.wbMarkdownOutline;
          if (!api || !api.actionState) return "Markdown 大纲状态尚未就绪";
          const st = api.actionState("menu");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          if (window.wbMarkdownOutline && window.wbMarkdownOutline.run) window.wbMarkdownOutline.run("menu");
        } });
    A({ id: "markdown.openExportMenu", name: "Markdown: 打开导出菜单", hint: "Markdown", icon: "download",
        requires: ["markdown"],
        enabled: () => {
          const api = window.wbMarkdownExport;
          if (!api || !api.actionState) return "Markdown 导出状态尚未就绪";
          const st = api.actionState("menu");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          if (window.wbMarkdownExport && window.wbMarkdownExport.run) window.wbMarkdownExport.run("menu");
        } });
    A({ id: "markdown.print", name: "打印 / 另存 PDF", hint: "Markdown", icon: "printer",
        requires: ["markdown"],
        enabled: () => {
          const api = window.wbMarkdownExport;
          if (!api || !api.actionState) return "Markdown 打印状态尚未就绪";
          const st = api.actionState("print");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          if (window.wbMarkdownExport && window.wbMarkdownExport.run) window.wbMarkdownExport.run("print");
        } });
    // 刷新文件树
    A({ id: "workspace.refreshTree", name: "刷新文件树", hint: "", icon: "refresh",
        requires: ["workspace"],
        run: () => { if (window.state) state.expanded.clear(); typeof initTree === "function" && initTree(); } });
    A({ id: "file.revealInExplorer", name: "文件: 在资源管理器中定位当前文件", hint: "Status Bar", icon: "folder",
        requires: ["workspace", "currentFile"],
        enabled: () => {
          const api = window.wbCurrentFile;
          if (!api || !api.actionState) return "当前文件状态尚未就绪";
          const st = api.actionState("revealInExplorer");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          if (window.wbCurrentFile && window.wbCurrentFile.revealInExplorer) {
            window.wbCurrentFile.revealInExplorer();
          }
        } });
    [
      ["explorer.newFileInSelection", "资源管理器: 在所选文件夹中新建文件", "filePlus", "newFile", "write"],
      ["explorer.newFolderInSelection", "资源管理器: 在所选文件夹中新建文件夹", "folderPlus", "newFolder", "write"],
      ["explorer.renameSelection", "资源管理器: 重命名所选项", "pencil", "rename", "write"],
      ["explorer.deleteSelection", "资源管理器: 删除所选项", "trash", "delete", "write"],
      ["explorer.fileHistory", "资源管理器: 所选文件历史", "history", "history", "read"],
      ["explorer.blame", "资源管理器: 所选文件 Blame", "list", "blame", "read"],
    ].forEach(([id, name, icon, action, risk]) => A({
      id, name, icon, risk, hint: "Explorer", requires: ["workspace"],
      enabled: () => {
        const api = window.wbExplorer;
        if (!api || !api.actionState) return "资源管理器尚未就绪";
        const st = api.actionState(action);
        return st.enabled ? true : st.reason;
      },
      run: () => {
        const api = window.wbExplorer;
        if (api && api.run) api.run(action);
      },
    }));
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
        enabled: () => {
          const api = window.wbGitActions;
          if (!api || !api.actionState) return "Git 状态尚未就绪";
          const st = api.actionState("push");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          typeof switchView === "function" && switchView("git");
          if (window.wbGitActions && window.wbGitActions.run) window.wbGitActions.run("push");
        } });
    A({ id: "git.branchOps", name: "Git: 分支操作", hint: "新建 / 检出 / 删除", icon: "branch",
        requires: ["workspace", "gitRepo"], risk: "write",
        enabled: () => {
          const api = window.wbGitActions;
          if (!api || !api.actionState) return "Git 状态尚未就绪";
          const st = api.actionState("branchOps");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          typeof switchView === "function" && switchView("git");
          if (window.wbGitActions && window.wbGitActions.run) window.wbGitActions.run("branchOps");
        } });
    A({ id: "git.stash", name: "Git: 储藏当前更改", hint: "Stash", icon: "download",
        requires: ["workspace", "gitRepo"], risk: "write",
        enabled: () => {
          const api = window.wbGitActions;
          if (!api || !api.actionState) return "Git 状态尚未就绪";
          const st = api.actionState("stash");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          typeof switchView === "function" && switchView("git");
          if (window.wbGitActions && window.wbGitActions.run) window.wbGitActions.run("stash");
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
      enabled: () => {
        const api = window.wbProjectActions;
        if (!api || !api.actionState) return "项目记忆尚未就绪";
        const st = api.actionState("open", name);
        return st.enabled ? true : st.reason;
      },
      run: () => {
        typeof switchView === "function" && switchView("project");
        if (window.wbProjectActions && window.wbProjectActions.run) window.wbProjectActions.run("open", name);
      },
    }));
    A({ id: "project.open.roadmap", name: "项目记忆: 下一阶段路线", hint: "Roadmap", icon: "notebook",
        risk: "read",
        enabled: () => {
          const api = window.wbProjectActions;
          if (!api || !api.actionState) return "项目记忆尚未就绪";
          const st = api.actionState("open", "roadmap");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          typeof switchView === "function" && switchView("project");
          if (window.wbProjectActions && window.wbProjectActions.run) window.wbProjectActions.run("open", "roadmap");
        } });
    A({ id: "project.copyRoadmap", name: "项目记忆: 复制下一阶段路线", hint: "Roadmap", icon: "copy",
        risk: "read",
        enabled: () => {
          const api = window.wbProjectActions;
          if (!api || !api.actionState) return "项目记忆尚未就绪";
          const st = api.actionState("copyRoadmap");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          typeof switchView === "function" && switchView("project");
          if (window.wbProjectActions && window.wbProjectActions.run) window.wbProjectActions.run("copyRoadmap");
        } });
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
      enabled: () => {
        const api = window.wbProjectActions;
        if (!api || !api.actionState) return "项目记忆尚未就绪";
        const st = api.actionState("edit", name);
        return st.enabled ? true : st.reason;
      },
      run: () => {
        if (window.wbProjectActions && window.wbProjectActions.run) window.wbProjectActions.run("edit", name);
      },
    }));
    A({ id: "project.appendDecision", name: "项目记忆: 追加决策记录", hint: "Decision", icon: "check",
        risk: "write",
        enabled: () => {
          const api = window.wbProjectActions;
          if (!api || !api.actionState) return "项目记忆尚未就绪";
          const st = api.actionState("append", "decision");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          typeof switchView === "function" && switchView("project");
          if (window.wbProjectActions && window.wbProjectActions.run) window.wbProjectActions.run("append", "decision");
        } });
    A({ id: "project.appendValidation", name: "项目记忆: 追加验证记录", hint: "Validation", icon: "play",
        risk: "write",
        enabled: () => {
          const api = window.wbProjectActions;
          if (!api || !api.actionState) return "项目记忆尚未就绪";
          const st = api.actionState("append", "validation");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          typeof switchView === "function" && switchView("project");
          if (window.wbProjectActions && window.wbProjectActions.run) window.wbProjectActions.run("append", "validation");
        } });
    A({ id: "task.create", name: "任务: 新建工作流任务", hint: "Agent", icon: "listChecks",
        risk: "write",
        run: () => {
          typeof switchView === "function" && switchView("tasks");
          if (window.createWorkflowTask) window.createWorkflowTask();
        } });
    A({ id: "task.fromCurrentFile", name: "任务: 从当前文件创建", hint: "Context", icon: "fileText",
        requires: ["workspace", "currentFile"], risk: "write",
        run: () => createTaskFromSeed(currentFileTaskSeed("file")) });
    A({ id: "task.fromMarkdown", name: "任务: 从当前 Markdown 创建验证任务", hint: "Markdown", icon: "markdown",
        requires: ["workspace", "markdown"], risk: "write",
        run: () => createTaskFromSeed(currentFileTaskSeed("markdown")) });
    A({ id: "task.fromViewer", name: "任务: 从当前查看器创建验证任务", hint: "Viewer", icon: "listChecks",
        requires: ["workspace", "viewer"], risk: "write",
        enabled: () => {
          const api = window.wbViewer;
          if (!api || !api.actionState) return "查看器尚未就绪";
          const st = api.actionState("createTask");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          if (window.wbViewer && window.wbViewer.run) window.wbViewer.run("createTask");
          else if (window.createViewerTaskFromCurrent) window.createViewerTaskFromCurrent();
        } });
    A({ id: "task.fromGitChanges", name: "任务: 从 Git 变更创建审计任务", hint: "SCM", icon: "git",
        requires: ["workspace", "gitRepo", "gitChanges"], risk: "write",
        run: () => createTaskFromSeed(gitTaskSeed(), "没有可记录的 Git 变更") });
    A({ id: "task.refresh", name: "任务: 刷新任务列表", hint: "Agent", icon: "refresh",
        run: () => {
          typeof switchView === "function" && switchView("tasks");
          if (window.reloadWorkflowTasks) window.reloadWorkflowTasks();
        } });
    A({ id: "task.appendMemory", name: "任务: 写入项目记忆", hint: "Progress", icon: "notebook",
        risk: "write",
        enabled: () => {
          const api = window.wbTaskActions;
          if (!api || !api.actionState) return "任务面板尚未就绪";
          const st = api.actionState("appendMemory");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          typeof switchView === "function" && switchView("tasks");
          if (window.wbTaskActions && window.wbTaskActions.run) window.wbTaskActions.run("appendMemory");
        } });
    A({ id: "session.createFromTask", name: "Agent: 从当前任务创建会话", hint: "Session", icon: "listChecks",
        risk: "write",
        enabled: () => {
          const api = window.wbTaskActions;
          if (!api || !api.actionState) return "任务面板尚未就绪";
          const st = api.actionState("createSession");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          typeof switchView === "function" && switchView("tasks");
          if (window.wbTaskActions && window.wbTaskActions.run) window.wbTaskActions.run("createSession");
        } });
    A({ id: "session.copyBrief", name: "Agent: 复制当前任务会话 brief", hint: "Session", icon: "copy",
        risk: "read",
        enabled: () => {
          const api = window.wbTaskActions;
          if (!api || !api.actionState) return "任务面板尚未就绪";
          const st = api.actionState("copySessionBrief");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          typeof switchView === "function" && switchView("tasks");
          if (window.wbTaskActions && window.wbTaskActions.run) window.wbTaskActions.run("copySessionBrief");
        } });
    A({ id: "session.importResult", name: "Agent: 导入会话结果", hint: "Session", icon: "download",
        risk: "write",
        enabled: () => {
          const api = window.wbTaskActions;
          if (!api || !api.actionState) return "任务面板尚未就绪";
          const st = api.actionState("importSessionResult");
          return st.enabled ? true : st.reason;
        },
        run: () => {
          typeof switchView === "function" && switchView("tasks");
          if (window.wbTaskActions && window.wbTaskActions.run) window.wbTaskActions.run("importSessionResult");
        } });
    A({ id: "ecosystem.refresh", name: "生态: 刷新 Skills / Playbooks", hint: ".workbench", icon: "blocks",
        run: () => {
          typeof switchView === "function" && switchView("ecosystem");
          if (window.reloadEcosystem) window.reloadEcosystem();
        } });
  }

  // ================= 命令面板 =================
  let cpResults = [], cpSel = 0;
  const cpFilters = { risk: "all", kind: "all", source: "all" };
  function cpIsOpen() { return !$("#cmdpalette").classList.contains("hidden"); }
  function openCmdPalette() {
    if (cpIsOpen()) return;
    const inp = $("#cp-input");
    $("#cmdpalette").classList.remove("hidden");
    inp.value = "";
    syncCpFilters();
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

  function cpFilterOptions(field) {
    const values = new Set(capabilities.map(cap => cap[field] || (field === "risk" ? "read" : "builtin")));
    if (field === "risk") {
      const order = ["read", "write", "exec", "network"];
      return Array.from(values).sort((a, b) => {
        const ai = order.includes(a) ? order.indexOf(a) : order.length;
        const bi = order.includes(b) ? order.indexOf(b) : order.length;
        return ai === bi ? String(a).localeCompare(String(b)) : ai - bi;
      });
    }
    return Array.from(values).sort();
  }
  function cpKindLabel(kind) {
    return ({
      command: "命令",
      tool: "工具",
      playbook: "Playbook",
      skill: "Skill",
      resource: "资源",
    })[kind] || kind;
  }
  function cpSourceLabel(source) {
    return ({
      builtin: "内置",
      workspace: "工作区",
      plugin: "插件",
      mcp: "MCP",
    })[source] || source;
  }
  function setCpSelect(sel, options, value, labelFn) {
    if (!sel) return;
    sel.innerHTML = [{ value: "all", label: "全部" }]
      .concat(options.map(v => ({ value: v, label: labelFn ? labelFn(v) : v })))
      .map(opt => `<option value="${esc(opt.value)}"${opt.value === value ? " selected" : ""}>${esc(opt.label)}</option>`)
      .join("");
  }
  function syncCpFilters() {
    setCpSelect($("#cp-risk-filter"), cpFilterOptions("risk"), cpFilters.risk, r => {
      const info = window.describeWorkbenchRisk ? window.describeWorkbenchRisk(r) : { label: r };
      return info.label;
    });
    setCpSelect($("#cp-kind-filter"), cpFilterOptions("kind"), cpFilters.kind, cpKindLabel);
    setCpSelect($("#cp-source-filter"), cpFilterOptions("source"), cpFilters.source, cpSourceLabel);
    const clear = $("#cp-clear-filter");
    if (clear) clear.classList.toggle("hidden",
      cpFilters.risk === "all" && cpFilters.kind === "all" && cpFilters.source === "all");
  }
  function cpMatchesFilters(cap) {
    const risk = cap.risk || "read";
    const kind = cap.kind || "command";
    const source = cap.source || "builtin";
    if (cpFilters.risk !== "all" && risk !== cpFilters.risk) return false;
    if (cpFilters.kind !== "all" && kind !== cpFilters.kind) return false;
    if (cpFilters.source !== "all" && source !== cpFilters.source) return false;
    return true;
  }
  function cpFilterSummary(items, total, query) {
    const summary = $("#cp-summary");
    if (!summary) return;
    const bits = [];
    if (query) bits.push(`搜索: ${query}`);
    if (cpFilters.risk !== "all") {
      const info = window.describeWorkbenchRisk ? window.describeWorkbenchRisk(cpFilters.risk) : { label: cpFilters.risk };
      bits.push(`风险: ${info.label}`);
    }
    if (cpFilters.kind !== "all") bits.push(`类型: ${cpKindLabel(cpFilters.kind)}`);
    if (cpFilters.source !== "all") bits.push(`来源: ${cpSourceLabel(cpFilters.source)}`);
    summary.textContent = `${items.length}/${total} 个能力` + (bits.length ? ` · ${bits.join(" · ")}` : " · 无过滤");
  }

  function cpRender(query) {
    query = query.trim();
    syncCpFilters();
    const filteredCaps = capabilities.filter(cpMatchesFilters);
    let items;
    if (!query) {
      items = filteredCaps.map((a) => ({ a, marks: [] }));
    } else {
      const scored = [];
      filteredCaps.forEach(a => {
        const m = fuzzy(query, a.title || a.name);
        if (m) scored.push({ a, marks: m.marks, score: m.score });
      });
      scored.sort((x, y) => y.score - x.score);
      items = scored;
    }
    cpFilterSummary(items, capabilities.length, query);
    cpResults = items; cpSel = 0;
    const list = $("#cp-list");
    if (!items.length) {
      list.innerHTML = `<div class="cp-empty">${filteredCaps.length ? "无匹配命令" : "当前过滤没有匹配能力"}</div>`;
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
      const riskInfo = window.describeWorkbenchRisk ? window.describeWorkbenchRisk(it.a.risk) : { key: it.a.risk || "read", label: it.a.risk || "read", description: "" };
      const risk = `<span class="cp-risk ${esc(riskInfo.key)}" title="${esc(riskInfo.description)}">${esc(riskInfo.label)}</span>`;
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
    const riskSel = $("#cp-risk-filter");
    if (riskSel) riskSel.onchange = () => { cpFilters.risk = riskSel.value || "all"; cpRender($("#cp-input").value || ""); };
    const kindSel = $("#cp-kind-filter");
    if (kindSel) kindSel.onchange = () => { cpFilters.kind = kindSel.value || "all"; cpRender($("#cp-input").value || ""); };
    const sourceSel = $("#cp-source-filter");
    if (sourceSel) sourceSel.onchange = () => { cpFilters.source = sourceSel.value || "all"; cpRender($("#cp-input").value || ""); };
    const clear = $("#cp-clear-filter");
    if (clear) clear.onclick = () => {
      cpFilters.risk = "all";
      cpFilters.kind = "all";
      cpFilters.source = "all";
      cpRender($("#cp-input").value || "");
    };
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
