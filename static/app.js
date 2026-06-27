/* Workbench 前端 */
const $ = (s) => document.querySelector(s);
const api = {
  tree: (p) => fetch(`/api/tree?path=${encodeURIComponent(p)}`).then(r => r.json()),
  file: (p) => fetch(`/api/file?path=${encodeURIComponent(p)}`),
  projectFile: (name) => fetch(`/api/project-state/open?name=${encodeURIComponent(name)}`),
  save: (p, c) => fetch(`/api/save`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p, content: c }),
  }).then(r => r.json()),
  saveProjectFile: (name, c) => fetch(`/api/project-state/save`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, content: c }),
  }).then(r => r.json()),
};

// 同源 POST 帮手（带 CSRF 必需的 Content-Type + 同源 Origin）
function fsPost(url, obj) {
  return fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  }).then(r => r.json());
}

const state = {
  current: null,   // 当前文件 path
  kind: null,      // text/image/binary
  dirty: false,
  expanded: new Set(),
  openSeq: 0,      // 打开文件请求令牌（防竞态）
  imageUrl: null,  // 当前图片 blob URL（用于释放）
  tabs: [],        // 已打开标签：{path,kind,name,ext,dirty,draft,viewMode,loaded}
  activeTab: null, // 当前激活标签的 path
  viewer: null,    // 当前已 mount 的查看器对象（kind==="viewer" 时）
  viewerHost: null,// 当前查看器的挂载容器（#viewer-host 内的干净 div）
};
window.state = state;  // 供工具箱 (Git) 读取当前文件

const explorerState = {
  selected: null,   // { path, name, type }
};

const viewerContext = {
  viewer: null,
  info: null,
  error: "",
};

// 行号槽状态（在 activateTab 之前用到，提前声明）
let gutterLineCount = -1;   // 当前已渲染的行数（避免无谓重绘）
let curGLine = -1;          // 当前高亮行

// ---------- marked 配置 ----------
marked.setOptions({
  breaks: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(code, { language: lang }).value; } catch {}
    }
    try { return hljs.highlightAuto(code).value; } catch { return code; }
  },
});

// ---------- Mermaid 初始化（手动渲染，不 startOnLoad）----------
let mermaidSeq = 0;  // 每次渲染递增，保证 id 唯一、避免旧实例残留
function mermaidTheme() {
  return (document.documentElement.getAttribute("data-theme") === "light")
    ? "default" : "dark";
}
if (window.mermaid) {
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: mermaidTheme(),
    });
  } catch (e) { /* 容错：mermaid 初始化失败不影响其余功能 */ }
}

// ========== Vditor 所见即所得（.md/.markdown）==========
// 全局单例：一个 Vditor 实例复用于所有 markdown 标签，靠 setValue/getValue 切换内容。
const vd = {
  inst: null,        // Vditor 实例
  ready: false,      // onAfterRender 触发后置 true
  pending: null,     // 实例就绪前要 setValue 的内容
  curPath: null,     // 当前挂载内容所属的标签 path
};
window.vd = vd;  // 暴露给调试/自测

// 当前 app 主题 -> Vditor 主题映射
function isLightTheme() {
  return document.documentElement.getAttribute("data-theme") === "light";
}
// Vditor 顶层 theme：只控制 .vditor--dark 类（深色界面）
function vditorTheme() {
  return isLightTheme() ? "classic" : "dark";
}
// Vditor 4.x editorTheme：提供 --bg-color/--front-color 等具体颜色变量，
// 深色下正文/标题/代码/表格的可读性以及 mermaid 取色全靠它。
// 这些 editor-theme 配色块（Light / Github Dark 等）已内联打包进 vditor/dist/index.css
// （选择器形如 #vditor[data-editor-theme=Github\ Dark]{--bg-color:#0d1117;...}），无需额外引 CSS。
function vditorEditorTheme() {
  return isLightTheme() ? "Light" : "Github Dark";
}
// Vditor 4.x mermaidTheme：用 mermaid 内置命名主题（Light→default / Dark→dark），
// 避免走 Auto 分支从空 CSS 变量取色导致 "Unsupported color format: ''"。
function vditorMermaidTheme() {
  return isLightTheme() ? "Light" : "Dark";
}
// 代码块高亮主题（codeMirrorTheme 用于 ``` 块的代码主题）
function vditorCodeTheme() {
  return isLightTheme() ? "Github" : "One Dark";
}

// 自定义图片上传：走我们的 JSON 接口，返回 null 阻止 Vditor 默认 multipart
async function vditorUploadHandler(files) {
  const targetPath = state.activeTab;   // 固定上传时的目标 md 文件，防 await 期间切标签插到错文件
  for (const file of files) {
    if (!file || !file.type || !file.type.startsWith("image/")) continue;
    try {
      const dataUrl = await blobToDataURL(file);
      const res = await fsPost("/api/upload-image", {
        dataB64: dataUrl, mime: file.type, name: file.name || "",
      });
      if (res && res.path) {
        if (state.activeTab !== targetPath || !vd.inst || vd.curPath !== targetPath) {
          setMsg("图片已上传，但已切换文件未插入：/" + res.path, "warn");  // 切走了就别插到别的文件
          continue;
        }
        vd.inst.insertValue(`![](/${res.path})\n`);
        setMsg("已插入图片 " + res.path, "ok");
      } else {
        setMsg("图片上传失败: " + ((res && res.error) || "未知错误"), "err");
      }
    } catch (err) {
      setMsg("图片上传失败: " + (err && err.message ? err.message : err), "err");
    }
  }
  return null;  // 阻止默认上传
}

// 懒创建 Vditor 实例（首次打开 md 时）
function ensureVditor(initialValue, onReady) {
  if (vd.inst) {
    // 记录"最新"挂载意图。就绪则立即执行；未就绪则交给 after() 执行最新那个，
    // 避免快速连切 md 标签时 after() 跑首个标签的陈旧 onReady → vd.curPath 与 activeTab 错位。
    vd.pendingMount = onReady || null;
    if (vd.ready) { const m = vd.pendingMount; vd.pendingMount = null; if (m) m(); }
    return;
  }
  vd.ready = false;
  vd.pendingMount = onReady || null;
  vd.inst = new Vditor("vditor", {
    cdn: "/static/vendor/vditor",
    mode: "wysiwyg",                  // 跟 vscode-office 一样默认进入完整所见即所得
    value: initialValue || "",
    cache: { enable: false },
    theme: vditorTheme(),
    // Vditor 4.x 用 editorTheme/mermaidTheme/codeMirrorTheme 顶层选项驱动内容/代码/图表配色，
    // 不再有 preview.theme.path（content-theme 目录已不存在，旧写法会 404 且变量为空）。
    editorTheme: vditorEditorTheme(),
    mermaidTheme: vditorMermaidTheme(),
    codeMirrorTheme: vditorCodeTheme(),
    icon: "material",
    outline: { enable: true, position: "left" },
    preview: {
      hljs: { style: vditorCodeTheme(), lineNumber: false },
      markdown: { toc: true, mark: true, footnotes: true, autoSpace: true },
      math: { engine: "KaTeX" },
    },
    toolbar: [
      "outline", "headings", "bold", "italic", "strike", "link", "|",
      "upload", "|",
      "editor-theme", "editor-theme-toggle", "|",
      "list", "ordered-list", "check", "table", "|",
      "quote", "line", "code", "inline-code", "|",
      "undo", "redo", "|",
      "find", "edit-mode", "code-theme", "help",
    ],
    tab: "\t",
    placeholder: "开始书写 Markdown...",
    upload: { accept: "image/*", handler: vditorUploadHandler },
    input() {
      // 标记当前 md 标签为脏（复用现有 dirty 机制）
      if (!vd.ready) return;
      if (!state.dirty) { state.dirty = true; document.body.classList.add("dirty"); }
      const t = tabByPath(state.activeTab);
      if (t && t.kind === "md") { if (!t.dirty) { t.dirty = true; } renderTabs(); }
    },
    after() {
      vd.ready = true;
      if (vd.pending != null) { vd.inst.setValue(vd.pending); vd.pending = null; }
      const m = vd.pendingMount; vd.pendingMount = null;   // 跑"最新"挂载，而非首建时的陈旧闭包
      if (m) m();
      if (typeof vd.inst.restoreDocumentSession === "function") {
        try { vd.inst.restoreDocumentSession(true); } catch (_) {}
      }
    },
  });
}

// 把内容塞进 Vditor（实例未就绪则缓存到 after 回调里再灌）
function vditorSetValue(text) {
  if (vd.inst && vd.ready) { vd.inst.setValue(text || ""); }
  else { vd.pending = text || ""; }
}
function vditorGetValue() {
  if (vd.inst && vd.ready) return vd.inst.getValue();
  if (vd.pending != null) return vd.pending;
  return "";
}

const CODE_EXTS = new Set(["json","js","ts","jsx","tsx","py","go","rs","java",
  "c","cpp","h","css","scss","html","htm","xml","yaml","yml","toml","sh",
  "bash","ps1","bat","sql","vue","svelte"]);
// 返回 [图标名, 颜色类]
function fileIcon(entry) {
  if (entry.type === "dir") return ["folder", "ic-folder"];
  const ext = (entry.name.split(".").pop() || "").toLowerCase();
  if (ext === "md" || ext === "markdown") return ["markdown", "ic-md"];
  if (entry.kind === "image") return ["image", "ic-img"];
  if (entry.kind === "binary") return ["file", "ic-bin"];
  if (CODE_EXTS.has(ext)) return ["fileCode", "ic-code"];
  return ["fileText", "ic-text"];
}

// 把页面上所有 [data-icon] 占位元素替换为 SVG
function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(el => {
    if (el.dataset.hydrated) return;
    const name = el.dataset.icon;
    let size = 16;
    if (el.classList.contains("act")) size = 21;
    else if (el.classList.contains("welcome-logo")) size = 46;
    else if (el.classList.contains("bin-icon")) size = 44;
    el.insertAdjacentHTML("afterbegin", svgIcon(name, size));
    el.dataset.hydrated = "1";
  });
}

// ---------- 文件树 ----------
async function loadTree(path, container) {
  const data = await api.tree(path);
  if (data.error) { setMsg(data.error, "err"); return; }
  container.innerHTML = "";
  for (const entry of data.entries) {
    container.appendChild(renderNode(entry));
  }
}

function renderNode(entry) {
  const node = document.createElement("div");
  node.className = "node";
  const row = document.createElement("div");
  row.className = "node-row";
  row.dataset.path = entry.path;
  row.dataset.type = entry.type;

  const [iconName, iconCls] = fileIcon(entry);
  const twist = document.createElement("span");
  twist.className = "twist";
  const ico = document.createElement("span");
  ico.className = "ico " + iconCls;
  ico.innerHTML = svgIcon(iconName, 16);
  const name = document.createElement("span");
  name.className = "node-name";
  name.textContent = entry.name;

  if (entry.type === "dir") {
    twist.innerHTML = svgIcon("chevron", 13);
    const children = document.createElement("div");
    children.className = "node-children hidden";
    row.onclick = async () => {
      const open = !children.classList.contains("hidden");
      if (open) {
        children.classList.add("hidden");
        twist.classList.remove("open");
        ico.innerHTML = svgIcon("folder", 16);
        state.expanded.delete(entry.path);
      } else {
        if (!children.dataset.loaded) {
          await loadTree(entry.path, children);
          children.dataset.loaded = "1";
        }
        children.classList.remove("hidden");
        twist.classList.add("open");
        ico.innerHTML = svgIcon("folderOpen", 16);
        state.expanded.add(entry.path);
      }
    };
    row.append(twist, ico, name);
    node.append(row, children);
  } else {
    row.onclick = () => openFile(entry.path, row);
    row.append(twist, ico, name);
    node.append(row);
  }
  bindRowContextMenu(row, entry);
  return node;
}

function setExplorerSelection(entry, row) {
  if (!entry) {
    explorerState.selected = null;
    return;
  }
  explorerState.selected = {
    path: entry.path || "",
    name: entry.name || String(entry.path || "").split("/").pop() || "",
    type: entry.type || "file",
  };
  document.querySelectorAll("#tree .node-row.context").forEach(e => e.classList.remove("context"));
  if (row) row.classList.add("context");
}

function getExplorerSelection() {
  return explorerState.selected ? Object.assign({}, explorerState.selected) : null;
}

function syncExplorerSelection() {
  const sel = getExplorerSelection();
  if (!sel) return;
  const row = findRow(sel.path);
  if (row) {
    document.querySelectorAll("#tree .node-row.context").forEach(e => e.classList.remove("context"));
    row.classList.add("context");
  } else {
    explorerState.selected = null;
  }
}

function explorerActionState(action) {
  if (!currentRoot) return { enabled: false, reason: "请先打开工作区" };
  const sel = getExplorerSelection();
  if (!sel) return { enabled: false, reason: "请先在资源管理器选择文件或文件夹" };
  const isDir = sel.type === "dir";
  if ((action === "newFile" || action === "newFolder") && !isDir) {
    return { enabled: false, reason: "请先选择文件夹" };
  }
  if ((action === "history" || action === "blame") && isDir) {
    return { enabled: false, reason: "请先选择文件" };
  }
  if (action === "history" || action === "blame") {
    if (!window.gitState || !gitState.repo) return { enabled: false, reason: "当前目录不在 Git 仓库内" };
    if (!gitState.hasHead) return { enabled: false, reason: "仓库还没有提交历史" };
  }
  return { enabled: true, reason: "" };
}

async function runExplorerAction(action) {
  const st = explorerActionState(action);
  if (!st.enabled) {
    setMsg(st.reason || "当前不可用", "warn");
    return false;
  }
  const sel = getExplorerSelection();
  const row = findRow(sel.path);
  const container = row ? containerOf(row) : $("#tree");
  const parentRel = sel.path.includes("/") ? sel.path.slice(0, sel.path.lastIndexOf("/")) : "";
  const isDir = sel.type === "dir";
  if (action === "newFile" || action === "newFolder") {
    const children = row ? childrenOf(row) : null;
    await ensureExpanded(row, children);
    if (action === "newFile") return fsCreate(sel.path, children);
    return fsCreateDir(sel.path, children);
  }
  if (action === "rename") return fsRename(sel.path, sel.name, isDir, container, parentRel);
  if (action === "delete") return fsDelete(sel.path, isDir, container, parentRel);
  if (action === "history") {
    if (window.showFileHistory) return window.showFileHistory(sel.path);
  }
  if (action === "blame") {
    if (window.showBlame) return window.showBlame(sel.path);
  }
  return false;
}

window.wbExplorer = {
  selection: getExplorerSelection,
  actionState: explorerActionState,
  run: runExplorerAction,
};

function currentFileActionState(action) {
  if (!currentRoot) return { enabled: false, reason: "请先打开工作区" };
  if (!state.current) return { enabled: false, reason: "当前没有打开文件" };
  if (action === "revealInExplorer" && String(state.current).startsWith("project://")) {
    return { enabled: false, reason: "项目记忆虚拟文件不在资源管理器中" };
  }
  return { enabled: true, reason: "" };
}

async function revealCurrentFileInExplorer() {
  const st = currentFileActionState("revealInExplorer");
  if (!st.enabled) {
    setMsg(st.reason || "当前不可用", "warn");
    return false;
  }
  if (sidebarCollapsed) setSidebarCollapsed(false);
  switchView("files");
  await expandTreeToPath(state.current);
  const row = findRow(state.current);
  if (!row) {
    setMsg("无法在资源管理器中定位当前文件", "warn");
    return false;
  }
  const entry = {
    path: row.dataset.path || state.current,
    name: (row.querySelector(".node-name") || {}).textContent || String(state.current).split("/").pop(),
    type: row.dataset.type || "file",
  };
  setExplorerSelection(entry, row);
  highlightTreeRow(state.current);
  row.scrollIntoView({ block: "nearest" });
  setMsg("已在资源管理器中定位当前文件", "ok");
  return true;
}

async function runCurrentFileAction(action) {
  const st = currentFileActionState(action);
  if (!st.enabled) {
    setMsg(st.reason || "当前不可用", "warn");
    return false;
  }
  if (action === "revealInExplorer") return revealCurrentFileInExplorer();
  setMsg("未知当前文件动作", "warn");
  return false;
}

window.wbCurrentFile = {
  actionState: currentFileActionState,
  run: runCurrentFileAction,
  revealInExplorer: revealCurrentFileInExplorer,
};

// ---------- 文件操作（新建/重命名/删除）----------
// 刷新某层目录的 container（重新拉取该目录列表）。container 为 #tree 时刷新根。
async function refreshDir(parentRel, container) {
  if (container === $("#tree")) {
    await loadTree("", container);
  } else {
    await loadTree(parentRel, container);
    container.dataset.loaded = "1";
  }
  hydrateIcons(container);
  syncExplorerSelection();
}

// 找到某行所属的「子容器」(.node-children) —— 即该 row 的兄弟节点
function childrenOf(row) {
  return row.parentElement.querySelector(":scope > .node-children");
}
// 找到某行所在的「父容器」—— 它被渲染进的那个 container
function containerOf(row) {
  // row 在 .node 内，.node 在 container 内
  return row.closest(".node").parentElement;
}

// 在指定文件夹下新建文件/文件夹
async function fsCreate(parentRel, container) {
  return new Promise((resolve) => {
    showModal({
      title: "新建文件",
      sub: parentRel ? `位置: ${parentRel}/` : "位置: 根目录",
      placeholder: "名称（如 notes.md）",
      okLabel: "创建",
      onSubmit: async (name) => {
        const res = await fsPost("/api/fs/create", { path: parentRel, name, type: "file" });
        if (res.error) return res.error;
        // 确保父目录已展开后再刷新
        if (container) {
          if (container !== $("#tree") && container.classList.contains("hidden")) {
            container.classList.remove("hidden");
          }
          await refreshDir(parentRel, container);
        } else {
          await fullRefresh();
        }
        const newRow = findRow(res.path);
        openFile(res.path, newRow || null);
        setMsg("已创建 " + res.path, "ok");
        resolve(true);
        return null;
      },
    });
  });
}
async function fsCreateDir(parentRel, container) {
  return new Promise((resolve) => {
    showModal({
      title: "新建文件夹",
      sub: parentRel ? `位置: ${parentRel}/` : "位置: 根目录",
      placeholder: "文件夹名称",
      okLabel: "创建",
      onSubmit: async (name) => {
        const res = await fsPost("/api/fs/create", { path: parentRel, name, type: "dir" });
        if (res.error) return res.error;
        if (container) {
          if (container !== $("#tree") && container.classList.contains("hidden")) {
            container.classList.remove("hidden");
          }
          await refreshDir(parentRel, container);
        } else {
          await fullRefresh();
        }
        setMsg("已创建 " + res.path, "ok");
        resolve(true);
        return null;
      },
    });
  });
}

// 重命名（path 是目标，container 是它所在容器，parentRel 是它的父目录 rel）
async function fsRename(path, oldName, isDir, container, parentRel) {
  showModal({
    title: isDir ? "重命名文件夹" : "重命名文件",
    sub: path,
    placeholder: "新名称",
    value: oldName,
    okLabel: "重命名",
    onSubmit: async (newName) => {
      if (newName === oldName) return null;  // 无变化直接关
      const res = await fsPost("/api/fs/rename", { path, newName });
      if (res.error) return res.error;
      // 若当前打开的就是它（或它的子项），更新/清空编辑区
      handlePathMoved(path, res.path, isDir);
      if (container) await refreshDir(parentRel, container);
      else await fullRefresh();
      setMsg("已重命名为 " + res.path, "ok");
      return null;
    },
  });
}

// 删除（confirm 模态）
async function fsDelete(path, isDir, container, parentRel) {
  showConfirm({
    title: isDir ? "删除文件夹" : "删除文件",
    message: isDir
      ? `确定删除文件夹 “${path}” 及其全部内容？此操作不可撤销。`
      : `确定删除文件 “${path}”？此操作不可撤销。`,
    okLabel: "删除",
    danger: true,
    onConfirm: async () => {
      const res = await fsPost("/api/fs/delete", { path });
      if (res.error) { setMsg(res.error, "err"); return; }
      handlePathDeleted(path, isDir);
      if (container) await refreshDir(parentRel, container);
      else await fullRefresh();
      setMsg("已删除 " + path, "ok");
    },
  });
}

// 重命名/移动时把受影响的标签路径一并更新
function remapTabPath(tab, oldPath, newPath, isDir) {
  if (tab.path === oldPath) {
    tab.path = newPath;
    tab.name = newPath.split("/").pop();
  } else if (isDir && tab.path.startsWith(oldPath + "/")) {
    tab.path = newPath + tab.path.slice(oldPath.length);
    tab.name = tab.path.split("/").pop();
  }
}
// 当前打开文件受重命名影响时同步
function handlePathMoved(oldPath, newPath, isDir) {
  const wasActive = state.activeTab;
  for (const tab of state.tabs) remapTabPath(tab, oldPath, newPath, isDir);
  // 同步 activeTab / current 指针
  const cur = state.current;
  if (cur === oldPath) {
    state.activeTab = newPath;
    setCurrent(newPath, state.kind);
  } else if (isDir && cur && cur.startsWith(oldPath + "/")) {
    const np = newPath + cur.slice(oldPath.length);
    state.activeTab = np;
    setCurrent(np, state.kind);
  } else if (wasActive) {
    const at = state.activeTab;
    if (at === oldPath) state.activeTab = newPath;
    else if (isDir && at && at.startsWith(oldPath + "/"))
      state.activeTab = newPath + at.slice(oldPath.length);
  }
  renderTabs();
  if (window.split && window.split.remapPath) window.split.remapPath(oldPath, newPath, isDir);
}
// 文件/目录被删除时关闭受影响的标签
function handlePathDeleted(path, isDir) {
  if (window.split && window.split.dropPath) window.split.dropPath(path, isDir);  // 副组可能也开着该文件（甚至只在副组）
  const affected = (p) => p === path || (isDir && p.startsWith(path + "/"));
  const survivors = state.tabs.filter(t => !affected(t.path));
  if (survivors.length === state.tabs.length) return;  // 主组无影响
  state.tabs = survivors;
  if (state.current && affected(state.current)) {
    state.activeTab = null;
    if (state.tabs.length) activateTab(state.tabs[state.tabs.length - 1].path);
    else { closeCurrent(); renderTabs(); }
  } else {
    renderTabs();
  }
}
function closeCurrent() {
  revokeImage();
  hideAllViews();
  if (currentRoot) {
    const empty = $("#workspace-empty");
    if (empty) { empty.classList.remove("hidden"); hydrateIcons(empty); }
  } else {
    $("#welcome").classList.remove("hidden");
  }
  $("#editor").value = "";
  state.current = null; state.kind = null; state.activeTab = null;
  state.dirty = false; document.body.classList.remove("dirty");
  renderTabs();
  $("#status-file").textContent = "未打开文件";
  updateStatusFileAction();
  $("#crumb").textContent = currentWorkspaceRoots.length > 1
    ? `工作区: ${currentWorkspaceRoots.length} 个目录`
    : (currentRoot ? "根目录: " + currentRoot : "");
  document.querySelectorAll("#tree .node-row.active").forEach(row => row.classList.remove("active"));
  updateTopActionState();
  if (window.updateStatusBar) updateStatusBar();
  if (window.updateRunButton) updateRunButton();
}

// 在树中按 path 找到对应的 .node-row（仅限已渲染节点）
function findRow(path) {
  return document.querySelector(`#tree .node-row[data-path="${cssEsc(path)}"]`);
}
function cssEsc(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

// 整树刷新，尽量保留 state.expanded 展开状态
async function fullRefresh() {
  const wanted = new Set(state.expanded);
  state.expanded.clear();
  await loadTree("", $("#tree"));
  hydrateIcons($("#tree"));
  // 按路径深度从浅到深依次展开
  const paths = [...wanted].sort((a, b) => a.split("/").length - b.split("/").length);
  for (const p of paths) {
    const row = findRow(p);
    if (row && row.dataset.type === "dir") {
      const children = childrenOf(row);
      if (children && children.classList.contains("hidden")) {
        row.click();  // 触发懒加载+展开
        // 等待该层加载完成
        await waitFor(() => children.dataset.loaded === "1");
        hydrateIcons(children);
      }
    }
  }
  syncExplorerSelection();
}
function waitFor(cond, tries = 50) {
  return new Promise((resolve) => {
    const tick = () => {
      if (cond() || tries-- <= 0) return resolve();
      setTimeout(tick, 20);
    };
    tick();
  });
}

// ---------- 上下文菜单 ----------
let ctxMenuEl = null;
function closeCtxMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
}
function showCtxMenu(x, y, items) {
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.id = "ctx-menu";
  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menu.appendChild(sep);
      continue;
    }
    const el = document.createElement("div");
    const disabled = typeof it.enabled === "function" ? !it.enabled() : !!it.disabled;
    el.className = "ctx-item" + (it.danger ? " danger" : "") + (disabled ? " disabled" : "");
    if (disabled) el.title = it.reason || "当前不可用";
    el.innerHTML = svgIcon(it.icon, 15) + `<span>${escHtml(it.label)}</span>`;
    el.onclick = () => {
      if (disabled) {
        if (it.reason) setMsg(it.reason, "warn");
        return;
      }
      closeCtxMenu();
      it.action();
    };
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  // 防止溢出屏幕
  const r = menu.getBoundingClientRect();
  if (x + r.width > window.innerWidth) x = window.innerWidth - r.width - 6;
  if (y + r.height > window.innerHeight) y = window.innerHeight - r.height - 6;
  menu.style.left = Math.max(4, x) + "px";
  menu.style.top = Math.max(4, y) + "px";
  ctxMenuEl = menu;
}
// 点击空白 / 滚动 / Esc 关闭
document.addEventListener("mousedown", (e) => {
  if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeCtxMenu();
});
document.addEventListener("scroll", closeCtxMenu, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCtxMenu(); });
window.addEventListener("blur", closeCtxMenu);

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 给某个 .node-row 绑定右键菜单
function bindRowContextMenu(row, entry) {
  row.addEventListener("click", () => setExplorerSelection(entry, row), { capture: true });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setExplorerSelection(entry, row);
    const container = containerOf(row);
    const parentRel = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    const isDir = entry.type === "dir";
    const gitHistoryState = explorerActionState("history");
    const items = [];
    if (isDir) {
      const children = childrenOf(row);
      items.push({
        icon: "filePlus", label: "新建文件",
        action: async () => {
          await ensureExpanded(row, children);
          fsCreate(entry.path, children);
        },
      });
      items.push({
        icon: "folderPlus", label: "新建文件夹",
        action: async () => {
          await ensureExpanded(row, children);
          fsCreateDir(entry.path, children);
        },
      });
      items.push({ sep: true });
    }
    if (!isDir) {
      items.push({
        icon: "history", label: "文件历史 (Git)",
        disabled: !gitHistoryState.enabled,
        reason: gitHistoryState.reason,
        action: () => { if (window.showFileHistory) window.showFileHistory(entry.path); },
      });
      items.push({
        icon: "list", label: "Blame (逐行作者)",
        disabled: !gitHistoryState.enabled,
        reason: gitHistoryState.reason,
        action: () => { if (window.showBlame) window.showBlame(entry.path); },
      });
      items.push({ sep: true });
    }
    items.push({
      icon: "pencil", label: "重命名",
      action: () => fsRename(entry.path, entry.name, isDir, container, parentRel),
    });
    items.push({
      icon: "trash", label: "删除", danger: true,
      action: () => fsDelete(entry.path, isDir, container, parentRel),
    });
    showCtxMenu(e.clientX, e.clientY, items);
  });
}
// 确保文件夹已展开（懒加载完成）
async function ensureExpanded(row, children) {
  if (!row || !children) return;
  if (children && children.classList.contains("hidden")) {
    row.click();
    await waitFor(() => children.dataset.loaded === "1");
    hydrateIcons(children);
  }
}

// ---------- 模态：输入名称 / 确认 ----------
function buildOverlay() {
  const ov = document.createElement("div");
  ov.id = "modal-overlay";
  return ov;
}
function closeModal() {
  const ov = $("#modal-overlay");
  if (ov) ov.remove();
}
// 输入框模态。onSubmit(value) 返回错误字符串则不关闭并展示，返回 null 则关闭。
function showModal({ title, sub, placeholder, value = "", okLabel = "确定", onSubmit }) {
  closeModal();
  const ov = buildOverlay();
  ov.innerHTML = `
    <div class="modal-box">
      <h3>${escHtml(title)}</h3>
      ${sub ? `<p class="modal-sub">${escHtml(sub)}</p>` : ""}
      <input class="modal-input" type="text" placeholder="${escHtml(placeholder || "")}">
      <div class="modal-err"></div>
      <div class="modal-actions">
        <button class="modal-btn" data-act="cancel">取消</button>
        <button class="modal-btn primary" data-act="ok">${escHtml(okLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const input = ov.querySelector(".modal-input");
  const errEl = ov.querySelector(".modal-err");
  input.value = value;
  input.focus();
  // 预选中文件名主干（保留扩展名）
  const dot = value.lastIndexOf(".");
  if (dot > 0) input.setSelectionRange(0, dot); else input.select();

  const submit = async () => {
    const name = input.value.trim();
    if (!name) { errEl.textContent = "名称不能为空"; return; }
    const okBtn = ov.querySelector('[data-act="ok"]');
    okBtn.disabled = true;
    let err;
    try {
      err = await onSubmit(name);
    } catch (e) {
      // onSubmit(fsPost) 可能 reject(网络失败/非 JSON 响应)；不兜底则 OK 按钮永久禁用、模态卡死
      err = "操作失败：" + (e && e.message ? e.message : e);
    }
    if (err) {
      errEl.textContent = err;
      okBtn.disabled = false;
      return;
    }
    closeModal();
  };
  ov.querySelector('[data-act="ok"]').onclick = submit;
  ov.querySelector('[data-act="cancel"]').onclick = closeModal;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); closeModal(); }
  });
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeModal(); });
}
// 确认模态
function showConfirm({ title, message, okLabel = "确定", danger = false, onConfirm }) {
  closeModal();
  const ov = buildOverlay();
  ov.innerHTML = `
    <div class="modal-box">
      <h3>${escHtml(title)}</h3>
      <p class="modal-sub">${escHtml(message)}</p>
      <div class="modal-actions">
        <button class="modal-btn" data-act="cancel">取消</button>
        <button class="modal-btn ${danger ? "danger" : "primary"}" data-act="ok">${escHtml(okLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const okBtn = ov.querySelector('[data-act="ok"]');
  okBtn.focus();
  okBtn.onclick = async () => { okBtn.disabled = true; await onConfirm(); closeModal(); };
  ov.querySelector('[data-act="cancel"]').onclick = closeModal;
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeModal(); });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
}

// ---------- 多格式查看器：分派与挂载 ----------
// 从路径/文件名取小写无点扩展名
function extOf(nameOrPath) {
  const base = String(nameOrPath || "").split("/").pop();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";  // 无扩展名 或 隐藏文件(.gitignore) 不算扩展名
  return base.slice(dot + 1).toLowerCase();
}

function projectStateKey(path) {
  const m = String(path || "").match(/^project:\/\/(requirements|progress|log|memory)$/);
  return m ? m[1] : null;
}

// 卸载当前已 mount 的查看器（若有），并清空挂载容器
function unmountViewer() {
  if (state.viewer && typeof state.viewer.unmount === "function") {
    try { state.viewer.unmount(); } catch (e) { /* 卸载失败不影响后续 */ }
  }
  state.viewer = null;
  viewerContext.viewer = null;
  viewerContext.info = null;
  viewerContext.error = "";
  const hostWrap = $("#viewer-host");
  if (hostWrap) hostWrap.innerHTML = "";   // 清掉旧的内部容器
  state.viewerHost = null;
}

function viewerActionState(action) {
  if (action === "createTask") {
    if (!currentRoot) return { enabled: false, reason: "请先打开工作区" };
    const tab = tabByPath(state.activeTab);
    if (!(viewerContext.viewer && viewerContext.info && tab && tab.kind === "viewer")) {
      return { enabled: false, reason: "需要打开查看器文件" };
    }
    if (viewerContext.error) return { enabled: false, reason: "查看器加载失败，不能创建验证任务" };
    if (!window.addWorkflowTask) return { enabled: false, reason: "任务面板尚未就绪" };
  }
  return { enabled: true, reason: "" };
}

function currentViewerContext() {
  return {
    viewer: viewerContext.viewer,
    info: viewerContext.info ? Object.assign({}, viewerContext.info) : null,
    error: viewerContext.error || "",
  };
}

window.wbViewer = {
  context: currentViewerContext,
  actionState: viewerActionState,
  run: (action) => {
    if (action === "createTask") return createViewerTaskFromCurrent();
    return false;
  },
};

// 挂载某查看器到 #viewer-host：先卸载上一个，再造一个干净容器交给 viewer.mount
function mountViewer(viewer, info) {
  unmountViewer();
  const hostWrap = $("#viewer-host");
  hostWrap.classList.remove("hidden");
  const host = document.createElement("div");
  host.className = "viewer-mount";
  const actionBar = document.createElement("div");
  actionBar.className = "viewer-actionbar";
  const label = document.createElement("span");
  label.className = "viewer-actionbar-label";
  label.textContent = (viewer && viewer.label ? viewer.label : "查看器") + " · " + (info && info.name ? info.name : "");
  const taskBtn = document.createElement("button");
  taskBtn.type = "button";
  taskBtn.className = "viewer-action";
  taskBtn.title = "从当前查看器文件创建验证任务";
  taskBtn.innerHTML = '<span class="i" data-icon="listChecks"></span>创建验证任务';
  taskBtn.onclick = () => createViewerTaskFromCurrent();
  actionBar.append(label, taskBtn);
  hostWrap.appendChild(actionBar);
  hostWrap.appendChild(host);
  state.viewer = viewer;
  state.viewerHost = host;
  viewerContext.viewer = viewer;
  viewerContext.info = info || {};
  viewerContext.error = "";
  try {
    viewer.mount(host, info);
  } catch (e) {
    viewerContext.error = String(e && e.message || e);
    host.innerHTML = '<div class="viewer-error">查看器加载失败：'
      + escHtml(viewerContext.error) + "</div>";
    taskBtn.disabled = true;
    taskBtn.title = "查看器加载失败，不能创建验证任务";
  }
}

async function createViewerTask(viewer, info) {
  if (!window.addWorkflowTask) {
    setMsg("任务面板尚未就绪", "warn");
    return;
  }
  const name = info.name || String(info.path || "").split("/").pop() || "当前查看器文件";
  const label = viewer && viewer.label ? viewer.label : "多格式查看器";
  const ext = info.ext || extOf(name) || "";
  const path = info.path || state.current || "";
  await window.addWorkflowTask({
    title: `${label} 验证: ${name}`,
    goal: `验证 ${label} 查看器能正确打开、展示和处理 ${path || name}。`,
    plan: [
      "确认查看器成功加载且没有控制台错误",
      "检查关键工具栏、分页、缩放、预览或文件列表等交互",
      "记录截图、导出结果或失败信息作为证据",
      "如发现渲染或交互问题，回到相关 viewer 模块修复并复测",
    ],
    evidence: [],
    log: [
      `Created from viewer: ${label}`,
      `File: ${path || name}`,
      `Ext: ${ext || "unknown"}`,
      `Workspace: ${window.currentWorkspaceId || window.currentRoot || "unknown"}`,
    ],
    next: "Run a viewer smoke and attach screenshot or console output.",
  });
}
function createViewerTaskFromCurrent() {
  const st = viewerActionState("createTask");
  if (!st.enabled) {
    setMsg(st.reason || "当前不可用", "warn");
    return false;
  }
  const tab = tabByPath(state.activeTab);
  if (!tab || tab.kind !== "viewer") {
    setMsg("当前不是查看器文件", "warn");
    return;
  }
  const viewer = tab.viewer || (typeof window.findViewer === "function" ? window.findViewer(tab.ext) : null);
  return createViewerTask(viewer, tab.info || { path: tab.path, name: tab.name, ext: tab.ext });
}
window.createViewerTaskFromCurrent = createViewerTaskFromCurrent;

// ---------- 打开文件 ----------
window.openFile = openFile;

// 在打开/切换文件前，把当前文本标签的编辑器内容暂存进 tab 对象（保留未保存草稿）
function stashActiveTab() {
  const t = tabByPath(state.activeTab);
  if (t && t.kind === "text") {
    t.draft = $("#editor").value;
    t.viewMode = viewMode;
    t.dirty = state.dirty;
  } else if (t && t.kind === "md") {
    // markdown 标签：把 Vditor 当前内容存进草稿
    if (vd.inst && vd.ready && vd.curPath === t.path) t.draft = vd.inst.getValue();
    t.dirty = state.dirty;
  }
}

// 打开文件：已打开则直接切换，否则新建标签并加载
// opts.line（1 起）：打开后滚动/选中到该行（仅文本文件）
async function openFile(path, row, opts) {
  const gotoLine = opts && opts.line ? opts.line : null;
  if (row) highlightTreeRow(path);
  // 已在分屏副组里打开 → 切到副组，别在主组再开一份
  if (window.split && window.split.has(path)) { window.split.activate(path); return; }
  const existing = tabByPath(path);
  if (existing) {
    if (gotoLine) existing.pendingLine = gotoLine;
    activateTab(path);
    return;
  }

  // 先把当前标签的编辑状态暂存，避免被新文件覆盖
  stashActiveTab();

  const name = path.split("/").pop();
  // 多格式查看器分派：按扩展名命中则不走 text/image/binary，直接交给查看器
  // （普通图片不在任何查看器的 exts 里，会落空 → 走下方原 image 逻辑）
  const vext = extOf(path);
  const viewer = (typeof window.findViewer === "function") ? window.findViewer(vext) : null;
  if (viewer) {
    const tab = { path, kind: "viewer", name, ext: vext,
                  dirty: false, draft: null, viewMode: "split",
                  viewer, info: { path, name, ext: vext } };
    addTab(tab);
    activateTab(path);
    return;
  }

  // 请求令牌：连续切换文件时，只让最后一次请求生效，丢弃过期响应
  const token = ++state.openSeq;
  const projectKey = projectStateKey(path);
  const res = projectKey ? await api.projectFile(projectKey) : await api.file(path);
  if (token !== state.openSeq) return;
  const ctype = res.headers.get("Content-Type") || "";

  if (ctype.startsWith("image/")) {
    const blob = await res.blob();
    if (token !== state.openSeq) return;
    const tab = { path, kind: "image", name, ext: "", dirty: false,
                  draft: null, viewMode: "split", blob };
    addTab(tab);
    activateTab(path);
    return;
  }
  const data = await res.json();
  if (token !== state.openSeq) return;
  if (data.error) { if (!(opts && opts.quiet)) setMsg(data.error, "err"); return; }

  if (data.kind === "binary") {
    const tab = { path, kind: "binary", name: data.name || name, ext: "",
                  dirty: false, draft: null, viewMode: "split",
                  size: data.size };
    addTab(tab);
    activateTab(path);
    return;
  }
  // 文本
  const ext = data.ext || "";
  const isMdFile = ext === ".md" || ext === ".markdown";
  const tab = { path, kind: isMdFile ? "md" : "text", name: data.name || name,
                ext, dirty: false, draft: data.content,
                viewMode: "split", pendingLine: gotoLine,
                projectStateKey: projectKey || null };
  addTab(tab);
  activateTab(path);
}

// 把文本编辑器光标定位到第 line 行（1 起）并滚动可见
function gotoEditorLine(line) {
  const ta = $("#editor");
  const text = ta.value;
  const lines = text.split("\n");
  if (line < 1) line = 1;
  if (line > lines.length) line = lines.length;
  let start = 0;
  for (let i = 0; i < line - 1; i++) start += lines[i].length + 1;
  const end = start + (lines[line - 1] ? lines[line - 1].length : 0);
  ta.focus();
  try { ta.setSelectionRange(start, end); } catch {}
  // 估算滚动位置（行高 * 行号），尽量让目标行居中
  const style = getComputedStyle(ta);
  let lh = parseFloat(style.lineHeight);
  if (!lh || Number.isNaN(lh)) lh = parseFloat(style.fontSize) * 1.6 || 20;
  const target = (line - 1) * lh - ta.clientHeight / 2;
  ta.scrollTop = Math.max(0, target);
}

// ---------- 标签管理 ----------
function tabByPath(path) {
  return path ? state.tabs.find(t => t.path === path) || null : null;
}
function tabIcon(tab) {
  // 复用 fileIcon 的语义（构造一个伪 entry）
  return fileIcon({ type: "file", name: tab.name, kind: tab.kind });
}
function addTab(tab) {
  if (!tabByPath(tab.path)) state.tabs.push(tab);
}

// 暴露给分屏模块（split.js）：在主组/副组间搬运标签、保存、状态栏路由都要用
window.wb = {
  state, addTab, tabByPath, renderTabs, setCurrent,
  stashActiveTab, activateTab,
  get current() { return state.current; },
  closeCurrent: () => closeCurrent(),
  saveMain: () => save(),
  mdExt: (ext) => ext === ".md" || ext === ".markdown",
};
// split.js 复用的 UI 帮手（函数声明已提升，这里挂到 window 供分屏副组用）
window.escHtml = escHtml;
window.tabIconFor = tabIcon;
window.highlightTreeRow = highlightTreeRow;
window.setMsg = setMsg;
window.fmtSize = fmtSize;

// 激活某个标签：恢复其编辑器内容/视图模式，并渲染
function activateTab(path) {
  const tab = tabByPath(path);
  if (!tab) return;
  // 切换前暂存上一个标签
  if (state.activeTab !== path) stashActiveTab();

  state.activeTab = path;
  // 作废在途的 openFile（避免其响应覆盖本次切换）
  const token = ++state.openSeq;
  void token;
  revokeImage();
  hideAllViews();

  if (tab.kind === "viewer") {
    // 多格式查看器：挂到 #viewer-host（hideAllViews 已卸载上一个查看器）
    const viewer = tab.viewer
      || (typeof window.findViewer === "function" ? window.findViewer(tab.ext) : null);
    if (viewer) {
      tab.viewer = viewer;
      mountViewer(viewer, tab.info || { path, name: tab.name, ext: tab.ext });
      setCurrent(path, "viewer");
    } else {
      // 兜底：查看器没注册上（脚本缺失等）→ 退化为二进制提示
      $("#binary-info").textContent = `${tab.name}（无可用查看器）`;
      $("#binary-view").classList.remove("hidden");
      setCurrent(path, "binary");
    }
  } else if (tab.kind === "image") {
    state.imageUrl = URL.createObjectURL(tab.blob);
    $("#image-el").src = state.imageUrl;
    $("#image-view").classList.remove("hidden");
    setCurrent(path, "image");
  } else if (tab.kind === "binary") {
    $("#binary-info").textContent = `${tab.name} · ${fmtSize(tab.size)}`;
    $("#binary-view").classList.remove("hidden");
    setCurrent(path, "binary");
  } else if (tab.kind === "md") {
    // ---- Markdown：用 Vditor 所见即所得 ----
    const content = tab.draft != null ? tab.draft : "";
    $("#vditor").classList.remove("hidden");
    $("#md-toolbar").classList.add("hidden");  // 原 marked 工具栏对 Vditor 不适用
    setCurrent(path, "md");
    state.dirty = !!tab.dirty;
    document.body.classList.toggle("dirty", state.dirty);
    // Vditor 自带模式切换工具，禁用顶栏的分屏/源码/预览按钮
    const vbtn = $("#btn-view-edit");
    if (vbtn) { vbtn.textContent = "所见即所得"; vbtn.disabled = true; }
    const mount = () => { vd.curPath = path; vditorSetValue(content); };
    ensureVditor(content, mount);   // 就绪→立即挂载；未就绪→记为 pendingMount，after() 跑最新那个
    document.body.classList.add("markdown-active");
  } else {
    $("#editor").value = tab.draft != null ? tab.draft : "";
    gutterLineCount = -1; curGLine = -1;  // 强制重建行号
    updateGutter();
    $("#editor-wrap").classList.remove("hidden");
    setCurrent(path, "text");
    state.dirty = !!tab.dirty;
    document.body.classList.toggle("dirty", state.dirty);
    const isMd = tab.ext === ".md" || tab.ext === ".markdown";
    if (isMd) viewMode = tab.viewMode || "split";
    applyViewMode(isMd ? viewMode : "edit", isMd);
    renderPreview();
    if (tab.pendingLine) {
      const ln = tab.pendingLine;
      tab.pendingLine = null;
      // markdown 在纯预览模式下没有可见 textarea，先切到含源码的模式
      if (isMd && viewMode === "preview") { viewMode = "split"; applyViewMode("split", true); }
      requestAnimationFrame(() => gotoEditorLine(ln));
    }
  }
  // 切换标签后重置查找状态：旧文件的匹配坐标不能用到新文件（防 replaceCurrent 错位替换）
  find.matches = [];
  find.idx = -1;
  if (find.open) {
    if (state.kind === "text") { computeMatches(); updateFindCount(); }
    else closeFind();
  }
  highlightTreeRow(path);
  renderTabs();
}

// 关闭标签（有脏标记时二次确认）
function closeTab(path) {
  const tab = tabByPath(path);
  if (!tab) return;
  if (tab.dirty || (tab.path === state.activeTab && state.dirty)) {
    if (!confirm(`“${tab.name}” 有未保存的更改，确定关闭？`)) return;
  }
  const idx = state.tabs.findIndex(t => t.path === path);
  if (idx < 0) return;
  state.tabs.splice(idx, 1);

  if (state.activeTab === path) {
    state.activeTab = null;
    const next = state.tabs[idx] || state.tabs[idx - 1] || null;
    if (next) {
      activateTab(next.path);
    } else {
      closeCurrent();
      renderTabs();
    }
  } else {
    renderTabs();
  }
}

// 渲染标签栏
function renderTabs() {
  if (window.saveWorkspace) saveWorkspace();
  const bar = $("#tabbar");
  if (!bar._wheelBound) {
    // 垂直滚轮 → 横向滚动标签栏（VS Code 风格；滚动条已在 CSS 隐藏），只绑一次
    bar._wheelBound = true;
    bar.addEventListener("wheel", (e) => {
      if (!e.deltaY) return;
      bar.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }
  bar.innerHTML = "";
  if (state.tabs.length === 0) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  for (const tab of state.tabs) {
    const isDirty = tab.dirty || (tab.path === state.activeTab && state.dirty);
    const [iconName, iconCls] = tabIcon(tab);
    const el = document.createElement("div");
    el.className = "tab" + (tab.path === state.activeTab ? " active" : "")
      + (isDirty ? " dirty" : "");
    el.title = tab.path;
    el.dataset.path = tab.path;
    el.innerHTML =
      `<span class="tab-ico ${iconCls}">${svgIcon(iconName, 15)}</span>`
      + `<span class="tab-name">${escHtml(tab.name)}</span>`
      + `<span class="tab-close" title="关闭">${svgIcon("close", 13)}</span>`;
    el.addEventListener("click", (e) => {
      if (e.target.closest(".tab-close")) { closeTab(tab.path); return; }
      activateTab(tab.path);
    });
    // 鼠标中键关闭
    el.addEventListener("mousedown", (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(tab.path); }
    });
    attachTabReorder(el, tab);   // 左键拖动重排标签顺序
    bar.appendChild(el);
  }
}

// ---- 标签拖动重排（指针拖动，WebView2 下比 HTML5 拖放可靠）----
function clearTabDropMarks() {
  document.querySelectorAll("#tabbar .tab").forEach(t =>
    t.classList.remove("tab-drop-before", "tab-drop-after"));
}
function reorderTab(fromPath, toPath, after) {
  if (fromPath === toPath) return;
  const from = state.tabs.findIndex(t => t.path === fromPath);
  if (from < 0) return;
  const [moved] = state.tabs.splice(from, 1);
  let to = state.tabs.findIndex(t => t.path === toPath);
  if (to < 0) { state.tabs.splice(from, 0, moved); return; }   // 目标没了，撤销
  if (after) to += 1;
  state.tabs.splice(to, 0, moved);
  renderTabs();
}
function attachTabReorder(el, tab) {
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".tab-close")) return;
    const startX = e.clientX, startY = e.clientY;
    const bar = $("#tabbar");
    let dragging = false, dropTarget = null, dropAfter = false, splitZone = null;
    function onMove(ev) {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
        dragging = true;
        el.classList.add("tab-dragging");
        document.body.style.cursor = "grabbing";
      }
      ev.preventDefault();
      // 拖出标签条、进入编辑区右/下边缘 → 分屏落点（交给 split.js）
      const br = bar.getBoundingClientRect();
      const overBar = ev.clientX >= br.left && ev.clientX <= br.right
                   && ev.clientY >= br.top && ev.clientY <= br.bottom;
      if (!overBar && window.split) {
        const z = window.split.splitDragHint(ev);
        if (z) { splitZone = z; clearTabDropMarks(); dropTarget = null; return; }
      }
      splitZone = null;
      if (window.split) window.split.clearSplitHint();
      clearTabDropMarks();
      dropTarget = null;
      const tabs = [...bar.querySelectorAll(".tab")].filter(t => t !== el);
      for (const t of tabs) {
        const r = t.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right) {
          dropTarget = t; dropAfter = (ev.clientX - r.left) > r.width / 2; break;
        }
      }
      if (!dropTarget && tabs.length) {   // 指针在标签条左/右空白 → 放到首/尾
        const first = tabs[0].getBoundingClientRect();
        const last = tabs[tabs.length - 1].getBoundingClientRect();
        if (ev.clientX < first.left) { dropTarget = tabs[0]; dropAfter = false; }
        else if (ev.clientX > last.right) { dropTarget = tabs[tabs.length - 1]; dropAfter = true; }
      }
      if (dropTarget) dropTarget.classList.add(dropAfter ? "tab-drop-after" : "tab-drop-before");
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      document.body.style.cursor = "";
      el.classList.remove("tab-dragging");
      clearTabDropMarks();
      if (window.split) window.split.clearSplitHint();
      if (dragging) {
        const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
        document.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => { try { document.removeEventListener("click", swallow, true); } catch (_) {} }, 80);
        if (splitZone && window.split) window.split.splitDrop(tab.path, splitZone);
        else if (dropTarget) reorderTab(tab.path, dropTarget.dataset.path, dropAfter);
      }
    }
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
  });
}

// 高亮文件树中对应行（仅已渲染节点）
function highlightTreeRow(path) {
  document.querySelectorAll(".node-row.active").forEach(e => e.classList.remove("active"));
  const row = findRow(path);
  if (row) row.classList.add("active");
}

// 释放上一张图片的 blob URL，避免内存泄漏
function revokeImage() {
  if (state.imageUrl) { URL.revokeObjectURL(state.imageUrl); state.imageUrl = null; }
}

function setCurrent(path, kind) {
  state.current = path; state.kind = kind;
  $("#status-file").textContent = path;
  updateStatusFileAction();
  $("#crumb").textContent = path;
  updateTopActionState();
  if (window.updateStatusBar) updateStatusBar();
  if (window.updateRunButton) updateRunButton();
}

function updateStatusFileAction() {
  const el = $("#status-file");
  if (!el) return;
  const st = currentFileActionState("revealInExplorer");
  el.classList.toggle("status-clickable", st.enabled);
  el.classList.toggle("disabled", !st.enabled);
  el.title = st.enabled ? "点击在资源管理器中定位当前文件" : (st.reason || "当前没有可定位文件");
}
window.updateStatusFileAction = updateStatusFileAction;

function updateTopActionState() {
  const saveBtn = $("#btn-save");
  if (saveBtn) {
    const canSave = state.kind === "text" || state.kind === "md";
    saveBtn.disabled = !canSave;
    saveBtn.title = canSave ? "保存 (Ctrl+S)" : "当前视图不可保存";
  }
  const viewBtn = $("#btn-view-edit");
  if (viewBtn && !document.body.classList.contains("markdown-active")) {
    const canToggle = state.kind === "text" && activeTabIsMarkdown();
    viewBtn.disabled = !canToggle;
    viewBtn.title = canToggle ? "切换 Markdown 源码 / 预览 / 分屏" : "仅 Markdown 源码视图可切换";
  }
}
window.updateTopActionState = updateTopActionState;

function updateWorkspaceActionState() {
  const hasWs = !!currentRoot;
  const reason = "请先打开工作区";
  [
    ["#btn-new-file", "新建文件（根目录）"],
    ["#btn-new-dir", "新建文件夹（根目录）"],
    ["#btn-refresh", "刷新"],
  ].forEach(([sel, title]) => {
    const btn = $(sel);
    if (!btn) return;
    btn.disabled = !hasWs;
    btn.title = hasWs ? title : reason;
    btn.setAttribute("aria-disabled", hasWs ? "false" : "true");
  });
  updateStatusFileAction();
  window.dispatchEvent(new CustomEvent("wb:workspace-state", {
    detail: {
      hasWorkspace: hasWs,
      root: currentRoot,
      roots: currentWorkspaceRoots.slice(),
      workspaceId: currentWorkspaceId,
    },
  }));
}
window.updateWorkspaceActionState = updateWorkspaceActionState;

function tabSnapshot(tab, activePath) {
  if (!tab) return null;
  return {
    path: tab.path || "",
    name: tab.name || (tab.path ? tab.path.split("/").pop() : ""),
    kind: tab.kind || "",
    ext: tab.ext || "",
    dirty: !!(tab.dirty || (tab.path === activePath && state.dirty)),
    viewMode: tab.viewMode || "",
  };
}

function getWorkspaceLayoutSnapshot() {
  const splitSnap = window.split && typeof window.split.snapshot === "function"
    ? window.split.snapshot()
    : { tabs: [], active: null, orient: null, focus: "main", hasSide: false, dirty: false };
  const mainTabs = state.tabs.map(t => tabSnapshot(t, state.activeTab)).filter(Boolean);
  const activeMain = tabByPath(state.activeTab);
  const activeSide = splitSnap && Array.isArray(splitSnap.tabs)
    ? splitSnap.tabs.find(t => t.path === splitSnap.active) || null
    : null;
  const activeGroup = splitSnap && splitSnap.focus === "side" && activeSide ? "side" : "main";
  const active = activeGroup === "side" ? activeSide : tabSnapshot(activeMain, state.activeTab);
  return {
    workspaceId: currentWorkspaceId,
    root: currentRoot,
    roots: currentWorkspaceRoots.slice(),
    hasWorkspace: !!currentRoot,
    storageKeys: {
      main: wsKey(),
      side: currentWorkspaceId ? ("wb-split:" + currentWorkspaceId) : null,
    },
    activeGroup,
    activeFile: active && active.path ? active.path : (state.current || null),
    main: {
      tabs: mainTabs,
      active: state.activeTab,
      dirty: !!(state.dirty || state.tabs.some(t => t.dirty)),
    },
    side: splitSnap,
    ui: {
      sidebarCollapsed: document.body.classList.contains("sidebar-collapsed"),
      markdownActive: document.body.classList.contains("markdown-active"),
      theme: document.documentElement.getAttribute("data-theme") || "dark",
    },
  };
}

function formatWorkspaceLayoutBrief(snapshot) {
  const s = snapshot || getWorkspaceLayoutSnapshot();
  const rootLines = s.roots && s.roots.length ? s.roots.map((r, i) => `- root[${i}]: ${r}`) : ["- root: none"];
  const mainTabs = s.main && s.main.tabs && s.main.tabs.length
    ? s.main.tabs.map(t => `- ${t.path}${t.path === s.main.active ? " (active)" : ""}${t.dirty ? " *dirty" : ""}`)
    : ["- none"];
  const sideTabs = s.side && s.side.tabs && s.side.tabs.length
    ? s.side.tabs.map(t => `- ${t.path}${t.path === s.side.active ? " (active)" : ""}${t.dirty ? " *dirty" : ""}`)
    : ["- none"];
  return [
    "# Workspace Layout Snapshot",
    "",
    `- workspaceId: ${s.workspaceId || "none"}`,
    `- activeGroup: ${s.activeGroup || "main"}`,
    `- activeFile: ${s.activeFile || "none"}`,
    `- sidebarCollapsed: ${s.ui && s.ui.sidebarCollapsed ? "yes" : "no"}`,
    `- sideOrient: ${s.side && s.side.orient ? s.side.orient : "none"}`,
    `- theme: ${s.ui && s.ui.theme ? s.ui.theme : "unknown"}`,
    "",
    "## Roots",
    ...rootLines,
    "",
    "## Main Tabs",
    ...mainTabs,
    "",
    "## Side Tabs",
    ...sideTabs,
  ].join("\n");
}

window.getWorkspaceLayoutSnapshot = getWorkspaceLayoutSnapshot;
window.formatWorkspaceLayoutBrief = formatWorkspaceLayoutBrief;

function hideAllViews() {
  document.body.classList.remove("markdown-active");
  $("#welcome").classList.add("hidden");
  const empty = $("#workspace-empty"); if (empty) empty.classList.add("hidden");
  $("#editor-wrap").classList.add("hidden");
  const vdEl = $("#vditor"); if (vdEl) vdEl.classList.add("hidden");
  // 多格式查看器：切走时卸载并隐藏挂载点
  unmountViewer();
  const vh = $("#viewer-host"); if (vh) vh.classList.add("hidden");
  $("#diff-view").classList.add("hidden");
  $("#image-view").classList.add("hidden");
  $("#binary-view").classList.add("hidden");
  const fh = $("#filehist-view"); if (fh) fh.classList.add("hidden");
  const bl = $("#blame-view"); if (bl) bl.classList.add("hidden");
}

// 在中间区域显示 diff (源代码管理点文件时调用)
window.showDiffView = function (name, diffText) {
  ++state.openSeq;  // 作废可能在途的 openFile，避免其覆盖 diff 视图
  revokeImage();
  hideAllViews();
  const esc = window.escapeHtml || (s => s);
  $("#diff-head").innerHTML = svgIcon("branch", 14) + `<span>${esc(name)}</span>`;
  const body = $("#diff-body");
  body.innerHTML = "";
  for (const line of diffText.split("\n")) {
    const span = document.createElement("span");
    span.textContent = line + "\n";
    if (line.startsWith("+") && !line.startsWith("+++")) span.className = "d-add";
    else if (line.startsWith("-") && !line.startsWith("---")) span.className = "d-del";
    else if (line.startsWith("@@")) span.className = "d-hunk";
    else if (line.startsWith("diff ") || line.startsWith("index ")) span.className = "d-meta";
    body.appendChild(span);
  }
  $("#diff-view").classList.remove("hidden");
  $("#crumb").textContent = "diff: " + name;
};

// ---------- 视图模式 ----------
let viewMode = "split"; // split | edit | preview
function applyViewMode(mode, isMd) {
  const wrap = $("#editor-wrap");
  wrap.classList.remove("mode-edit", "mode-preview");
  const btn = $("#btn-view-edit");
  if (!isMd) {
    wrap.classList.add("mode-edit");
    btn.textContent = "源码"; btn.disabled = true;
    return;
  }
  btn.disabled = false;
  if (mode === "edit") { wrap.classList.add("mode-edit"); btn.textContent = "源码"; }
  else if (mode === "preview") { wrap.classList.add("mode-preview"); btn.textContent = "预览"; }
  else { btn.textContent = "分屏"; }
}

$("#btn-view-edit").onclick = () => {
  const order = ["split", "edit", "preview"];
  viewMode = order[(order.indexOf(viewMode) + 1) % order.length];
  applyViewMode(viewMode, true);
};

// ---------- Markdown 增强：大纲菜单 / 导出 ----------
function toggleMenu(menu, others) {
  const willOpen = menu.classList.contains("hidden");
  others.forEach(m => m.classList.add("hidden"));
  menu.classList.toggle("hidden", !willOpen);
}
$("#btn-toc").onclick = (e) => {
  e.stopPropagation();
  const st = markdownOutlineActionState("menu");
  if (!st.enabled) { setMsg(st.reason || "当前不可用", "warn"); return; }
  toggleMenu($("#toc-menu"), [$("#export-menu")]);
};
$("#btn-md-export").onclick = (e) => {
  e.stopPropagation();
  const st = markdownExportActionState("menu");
  if (!st.enabled) { setMsg(st.reason || "当前不可用", "warn"); return; }
  toggleMenu($("#export-menu"), [$("#toc-menu")]);
};
// 点击别处关闭浮层菜单
document.addEventListener("mousedown", (e) => {
  if (!(e.target instanceof Element)) return;
  if (!e.target.closest("#md-toolbar")) {
    $("#toc-menu").classList.add("hidden");
    $("#export-menu").classList.add("hidden");
  }
});
$("#export-menu").querySelectorAll(".toc-act").forEach(el => {
  el.onclick = () => {
    $("#export-menu").classList.add("hidden");
    if (el.dataset.act === "html") exportHtml();
    else if (el.dataset.act === "print") printMarkdown();
  };
});

function markdownExportActionState(action) {
  if (!currentRoot) return { enabled: false, reason: "请先打开工作区" };
  if (!activeTabIsMarkdown()) return { enabled: false, reason: "请先打开 Markdown 文件" };
  if (state.kind === "md" && (!vd.inst || !vd.ready || vd.curPath !== state.current)) {
    return { enabled: false, reason: "Markdown 编辑器尚未就绪" };
  }
  if (action === "menu") {
    const toolbar = $("#md-toolbar");
    if (!toolbar || toolbar.classList.contains("hidden")) {
      return { enabled: false, reason: "Vditor 模式使用命令直接导出或打印" };
    }
  }
  return { enabled: true, reason: "" };
}

function runMarkdownExportAction(action) {
  const st = markdownExportActionState(action);
  if (!st.enabled) {
    setMsg(st.reason || "当前不可用", "warn");
    return false;
  }
  if (action === "html") { exportHtml(); return true; }
  if (action === "print") { printMarkdown(); return true; }
  if (action === "menu") {
    const btn = $("#btn-md-export");
    if (btn) btn.click();
    return true;
  }
  return false;
}

window.wbMarkdownExport = {
  actionState: markdownExportActionState,
  run: runMarkdownExportAction,
};

function markdownOutlineActionState(action) {
  if (!currentRoot) return { enabled: false, reason: "请先打开工作区" };
  if (!activeTabIsMarkdown()) return { enabled: false, reason: "请先打开 Markdown 文件" };
  if (state.kind === "md") {
    if (!vd.inst || !vd.ready || vd.curPath !== state.current) {
      return { enabled: false, reason: "Markdown 编辑器尚未就绪" };
    }
    return { enabled: false, reason: "Vditor 模式使用编辑器左侧大纲" };
  }
  const toolbar = $("#md-toolbar");
  if (!toolbar || toolbar.classList.contains("hidden")) {
    return { enabled: false, reason: "当前 Markdown 大纲菜单不可用" };
  }
  if (action === "menu") return { enabled: true, reason: "" };
  return { enabled: true, reason: "" };
}

function runMarkdownOutlineAction(action) {
  const st = markdownOutlineActionState(action);
  if (!st.enabled) {
    setMsg(st.reason || "当前不可用", "warn");
    return false;
  }
  if (action === "menu") {
    const btn = $("#btn-toc");
    if (btn) btn.click();
    return true;
  }
  return false;
}

window.wbMarkdownOutline = {
  actionState: markdownOutlineActionState,
  run: runMarkdownOutlineAction,
};

// 收集页面里已加载的 highlight / markdown 相关样式，内联进导出的 HTML
function collectStyleText() {
  let css = "";
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) css += rule.cssText + "\n";
    } catch { /* 跨域样式表读取受限，忽略 */ }
  }
  return css;
}

// 把当前预览渲染结果导出为内联样式的独立 .html 下载
function exportHtml() {
  const st = markdownExportActionState("html");
  if (!st.enabled) { setMsg(st.reason || "当前不可用", "warn"); return false; }
  const preview = $("#preview");
  const title = (state.current || "document").split("/").pop().replace(/\.(md|markdown)$/i, "");
  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  const css = collectStyleText();
  // Markdown 文件用 Vditor 编辑(kind "md")，#preview 不会被填充(renderPreview 对非 text 直接 return)，
  // 直读会导出空/陈旧内容 → 对当前 md 标签实时渲染 Vditor 源；其余(文本预览)仍读 #preview。
  let bodyHtml;
  const _t = tabByPath(state.activeTab);
  const _isMd = _t && (_t.ext === ".md" || _t.ext === ".markdown");
  if (_isMd && state.kind === "md" && vd.curPath === state.current && typeof marked !== "undefined") {
    bodyHtml = sanitizeHtml(marked.parse(vditorGetValue() || ""));
  } else {
    bodyHtml = sanitizeHtml(preview.innerHTML);
  }
  // 导出文件会在任意上下文打开，已显式消毒一次
  const doc =
`<!DOCTYPE html>
<html lang="zh" data-theme="${theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
${css}
body { margin: 0; background: var(--bg, #fff); }
.export-wrap { max-width: 880px; margin: 0 auto; padding: 40px 32px; }
.mermaid-fig svg { max-width: 100%; height: auto; }
</style>
</head>
<body>
<div class="export-wrap markdown-body">
${bodyHtml}
</div>
</body>
</html>`;
  const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = title + ".html";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setMsg("已导出 " + title + ".html", "ok");
  return true;
}

function printMarkdown() {
  const st = markdownExportActionState("print");
  if (!st.enabled) { setMsg(st.reason || "当前不可用", "warn"); return false; }
  window.print();
  return true;
}

// ---------- HTML 消毒（零依赖，防存储型 XSS→本机 RCE）----------
// 用惰性 <template> 解析(不触发资源加载/脚本执行)，移除危险元素并剥离所有 on* 事件属性
// 与 javascript:/vbscript:/data:text/html 类 URL，使 Markdown/文本内容里的 <img onerror=…>
// 之类无法经 innerHTML 触发脚本（再经同源 /api/exec 升级为本机命令执行）。
const SANITIZE_DROP = new Set(["SCRIPT","IFRAME","OBJECT","EMBED","LINK","META","BASE","FORM","INPUT","BUTTON","TEXTAREA","SELECT","OPTION","FRAME","FRAMESET"]);
const SANITIZE_URL_ATTRS = ["href","src","action","formaction","poster","background"];
function sanitizeHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html == null ? "" : html);
  tpl.content.querySelectorAll("*").forEach((el) => {
    if (SANITIZE_DROP.has(el.tagName)) { el.remove(); return; }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") { el.removeAttribute(attr.name); continue; }
      if (name === "style" && /expression\s*\(|javascript:/i.test(attr.value)) { el.removeAttribute(attr.name); continue; }
      if (SANITIZE_URL_ATTRS.includes(name) || name.endsWith(":href")) {
        const v = (attr.value || "").replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
        if (/^(javascript|vbscript):/.test(v) || v.startsWith("data:text/html")) el.removeAttribute(attr.name);
      }
    }
  });
  return tpl.innerHTML;
}

// ---------- 预览 ----------
function renderPreview() {
  if (state.kind !== "text") return;
  const html = sanitizeHtml(marked.parse($("#editor").value));
  const preview = $("#preview");
  preview.innerHTML = html;
  // Markdown 增强：仅对 .md/.markdown 启用工具栏、标题锚点、大纲、mermaid
  const t = tabByPath(state.activeTab);
  const isMd = t && (t.ext === ".md" || t.ext === ".markdown");
  $("#md-toolbar").classList.toggle("hidden", !isMd);
  if (!isMd) return;
  assignHeadingIds(preview);
  buildTOC(preview);
  renderMath(preview);
  renderMermaid(preview);
  decorateTaskList(preview);
}

// ---------- KaTeX 数学公式渲染 ----------
// 用 auto-render 扫描 $...$ 行内与 $$...$$ 块级。代码块内不渲染（delimiters 不进 pre/code）。
function renderMath(root) {
  if (!window.renderMathInElement) return;
  try {
    window.renderMathInElement(root, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      throwOnError: false,
    });
  } catch (e) { /* 公式渲染失败不影响其余预览 */ }
}

// ---------- 预览任务清单可勾选 ----------
// marked 渲染的 GFM 任务项形如 <li class="task-list-item"><input type=checkbox ...>...
// 给每个复选框打上「在源码里的序号」，点击后回写对应行的 [ ]<->[x]。
function decorateTaskList(root) {
  // 只选「li 首个子元素且为复选框」——GFM 任务项把 checkbox 放在 li 开头，
  // 这样与源码 TASK_LINE_RE（行首任务标记）一一对应；用户手写在文中的裸 checkbox 不计入、不会错位。
  const boxes = root.querySelectorAll('li > input[type="checkbox"]:first-child');
  let i = 0;
  boxes.forEach(cb => {
    cb.disabled = false;
    cb.dataset.taskIndex = String(i++);
    cb.addEventListener("change", onTaskCheckboxToggle);
  });
}

// 源码中所有任务项行（- [ ] / - [x]）的正则
const TASK_LINE_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](\s)/;

function onTaskCheckboxToggle(e) {
  const cb = e.currentTarget;
  const idx = parseInt(cb.dataset.taskIndex, 10);
  if (Number.isNaN(idx)) return;
  const ta = $("#editor");
  const lines = ta.value.split("\n");
  let seen = -1;
  for (let li = 0; li < lines.length; li++) {
    const m = lines[li].match(TASK_LINE_RE);
    if (!m) continue;
    seen++;
    if (seen !== idx) continue;
    const mark = cb.checked ? "x" : " ";
    lines[li] = lines[li].replace(TASK_LINE_RE, (full, pre, _old, sp) => pre + "[" + mark + "]" + sp);
    break;
  }
  ta.value = lines.join("\n");
  fireEditorInput();   // 触发脏标记 + 行号 + 防抖预览刷新
}

// 给预览里的 h1–h6 加唯一 id（供大纲跳转）
function assignHeadingIds(root) {
  const used = new Set();
  root.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h, i) => {
    let base = (h.textContent || "heading").trim().toLowerCase()
      .replace(/[^\w一-龥]+/g, "-").replace(/^-+|-+$/g, "") || "h";
    let id = "h-" + base, n = 2;
    while (used.has(id)) id = "h-" + base + "-" + (n++);
    used.add(id);
    h.id = id;
  });
}

// 构建大纲（h1–h3），写入 #toc-menu
function buildTOC(root) {
  const menu = $("#toc-menu");
  const heads = [...root.querySelectorAll("h1,h2,h3")];
  if (!heads.length) {
    menu.innerHTML = `<div class="toc-empty">无标题</div>`;
    return;
  }
  menu.innerHTML = heads.map(h => {
    const lvl = h.tagName[1];
    return `<div class="toc-item toc-l${lvl}" data-target="${escHtml(h.id)}">`
      + `${escHtml((h.textContent || "").trim())}</div>`;
  }).join("");
  menu.querySelectorAll(".toc-item").forEach(el => {
    el.onclick = () => {
      const preview = $("#preview");
      const target = preview.querySelector("#" + cssEsc(el.dataset.target));
      if (target) {
        // 在 #preview 这个滚动容器内精确定位（scrollIntoView 可能作用于错误的祖先）
        const top = target.getBoundingClientRect().top
          - preview.getBoundingClientRect().top + preview.scrollTop - 8;
        preview.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      }
      $("#toc-menu").classList.add("hidden");
    };
  });
}

// 渲染预览里的 ```mermaid 代码块（marked 生成 <pre><code class="language-mermaid">）
async function renderMermaid(root) {
  if (!window.mermaid) return;
  const blocks = [...root.querySelectorAll("pre > code.language-mermaid")];
  if (!blocks.length) return;
  // 主题跟随当前深浅色（重渲染时重新 initialize 不报错）
  try { mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: mermaidTheme() }); } catch {}
  for (const code of blocks) {
    const pre = code.parentElement;
    const src = code.textContent || "";
    const holder = document.createElement("div");
    holder.className = "mermaid-fig";
    pre.replaceWith(holder);
    const id = "mmd-" + (++mermaidSeq);
    try {
      const { svg } = await mermaid.render(id, src);
      holder.innerHTML = svg;
    } catch (e) {
      holder.classList.add("mermaid-err");
      holder.textContent = "Mermaid 渲染失败: " + (e && e.message ? e.message : e);
      // 清理 mermaid 可能注入到 body 的临时错误节点
      document.getElementById("d" + id)?.remove();
    }
  }
}

let renderTimer = null;
$("#editor").addEventListener("input", () => {
  if (!state.dirty) {
    state.dirty = true; document.body.classList.add("dirty");
    const t = tabByPath(state.activeTab);
    if (t) { t.dirty = true; renderTabs(); }  // 标签亮起脏点
  }
  updateGutter();
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, 120);
});

// ---------- 行号槽 ----------
const gutterEl = $("#editor-gutter");
// 重建行号（仅当行数变化时重写 DOM），并刷新当前行高亮
function updateGutter() {
  const ta = $("#editor");
  const n = ta.value.split("\n").length;
  if (n !== gutterLineCount) {
    let html = "";
    for (let i = 1; i <= n; i++) html += `<span class="gline" data-l="${i}">${i}</span>`;
    gutterEl.innerHTML = html;
    gutterLineCount = n;
  }
  syncGutterScroll();
  highlightCurrentLine();
}
// 行号槽随 textarea 垂直滚动
function syncGutterScroll() {
  gutterEl.scrollTop = $("#editor").scrollTop;
}
// 当前行高亮（基于光标所在行）
function highlightCurrentLine() {
  const ta = $("#editor");
  const line = ta.value.slice(0, ta.selectionStart).split("\n").length;
  if (line === curGLine) return;
  const prev = gutterEl.querySelector(".gline.cur");
  if (prev) prev.classList.remove("cur");
  const el = gutterEl.querySelector(`.gline[data-l="${line}"]`);
  if (el) el.classList.add("cur");
  curGLine = line;
}
$("#editor").addEventListener("scroll", syncGutterScroll);
$("#editor").addEventListener("keyup", highlightCurrentLine);
$("#editor").addEventListener("click", highlightCurrentLine);
$("#editor").addEventListener("input", highlightCurrentLine);

// ---------- 文件内查找/替换 (Ctrl+F) ----------
const find = { open: false, regex: false, ci: true, matches: [], idx: -1 };

function findIsOpen() { return find.open; }

function openFind() {
  if (state.kind !== "text") return;   // 仅文本编辑可用
  find.open = true;
  $("#editor-find").classList.remove("hidden");
  const ta = $("#editor");
  // 用选区内容预填查找框
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  const inp = $("#find-input");
  if (sel && !sel.includes("\n")) inp.value = sel;
  inp.focus(); inp.select();
  runFind(false);
}

function closeFind() {
  find.open = false;
  $("#editor-find").classList.add("hidden");
  find.matches = []; find.idx = -1;
  $("#editor").focus();
}

// 构建匹配列表 [{start,end}]，按需重新计算
function computeMatches() {
  find.matches = [];
  const q = $("#find-input").value;
  const text = $("#editor").value;
  if (!q) return;
  if (find.regex) {
    let re;
    try { re = new RegExp(q, "g" + (find.ci ? "i" : "")); }
    catch { $("#find-count").textContent = "正则错误"; return; }
    let m, guard = 0;
    while ((m = re.exec(text)) && guard++ < 100000) {
      find.matches.push({ start: m.index, end: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;  // 防零宽死循环
    }
  } else {
    const hay = find.ci ? text.toLowerCase() : text;
    const needle = find.ci ? q.toLowerCase() : q;
    let from = 0, i;
    while ((i = hay.indexOf(needle, from)) !== -1) {
      find.matches.push({ start: i, end: i + needle.length });
      from = i + (needle.length || 1);
    }
  }
}

function updateFindCount() {
  const c = $("#find-count");
  if (!$("#find-input").value) { c.textContent = "无结果"; return; }
  if (c.textContent === "正则错误") return;
  if (find.matches.length === 0) { c.textContent = "无结果"; return; }
  c.textContent = `${find.idx + 1}/${find.matches.length}`;
}

// 选中第 idx 个匹配并滚动可见
function selectMatch(idx) {
  if (!find.matches.length) { updateFindCount(); return; }
  if (idx < 0) idx = find.matches.length - 1;
  if (idx >= find.matches.length) idx = 0;
  find.idx = idx;
  const m = find.matches[idx];
  const ta = $("#editor");
  ta.focus();
  try { ta.setSelectionRange(m.start, m.end); } catch {}
  // 滚动到匹配行
  const before = ta.value.slice(0, m.start).split("\n").length;
  const style = getComputedStyle(ta);
  let lh = parseFloat(style.lineHeight);
  if (!lh || Number.isNaN(lh)) lh = parseFloat(style.fontSize) * 1.65 || 20;
  ta.scrollTop = Math.max(0, (before - 1) * lh - ta.clientHeight / 2);
  syncGutterScroll();
  highlightCurrentLine();
  // 重新聚焦查找框（保留选区高亮）
  $("#find-input").focus();
  updateFindCount();
}

// 执行查找。advance=true 时定位首个/下一个匹配
function runFind(advance) {
  computeMatches();
  if (!find.matches.length) { find.idx = -1; updateFindCount(); return; }
  // 优先选中光标之后的第一个匹配
  const caret = $("#editor").selectionStart;
  let target = find.matches.findIndex(m => m.start >= caret);
  if (target < 0) target = 0;
  selectMatch(target);
}

function findNext(dir) {
  if (!find.matches.length) { computeMatches(); }
  if (!find.matches.length) { updateFindCount(); return; }
  selectMatch(find.idx + (dir || 1));
}

// 触发 input 事件以更新脏标记/预览/行号
function fireEditorInput() {
  $("#editor").dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------- Markdown 粘贴图片自动存盘 + 插链接 ----------
// 当前激活标签是否为 Markdown 文件
function activeTabIsMarkdown() {
  const t = tabByPath(state.activeTab);
  return !!(t && (t.ext === ".md" || t.ext === ".markdown"));
}

// 把 Markdown 文本插入到 #editor 当前光标处（替换选区），并刷新预览/脏标记
function insertAtCursor(text) {
  const ta = $("#editor");
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  const caret = s + text.length;
  ta.selectionStart = ta.selectionEnd = caret;
  fireEditorInput();
}

// 读 Blob 为 base64 dataURL
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error("读取失败"));
    fr.readAsDataURL(blob);
  });
}

$("#editor").addEventListener("paste", async (e) => {
  // 仅在文本编辑视图、且当前是 Markdown 文件时拦截图片粘贴
  if (state.kind !== "text" || !activeTabIsMarkdown()) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  let imgItem = null;
  for (const it of items) {
    if (it.kind === "file" && it.type && it.type.startsWith("image/")) { imgItem = it; break; }
  }
  if (!imgItem) return;   // 非图片粘贴照常
  e.preventDefault();
  const file = imgItem.getAsFile();
  if (!file) return;
  const targetPath = state.activeTab;   // 固定上传时的目标文件，防 await 期间切标签插错/留下占位符
  // 占位符，避免上传期间用户继续输入打乱光标
  const placeholder = `![上传中…](uploading)`;
  insertAtCursor(placeholder);
  // 把占位符替换成 repl（repl 为空即移除）。仍是目标标签→改 #editor；已切走→改目标标签的 draft。
  const settle = (repl) => {
    if (state.activeTab === targetPath) {
      const ta = $("#editor");
      const at = ta.value.indexOf(placeholder);
      if (at >= 0) {
        ta.value = ta.value.slice(0, at) + repl + ta.value.slice(at + placeholder.length);
        ta.selectionStart = ta.selectionEnd = at + repl.length;
      } else if (repl) { insertAtCursor(repl); }
      fireEditorInput();
    } else {
      const t = tabByPath(targetPath);
      if (t && typeof t.draft === "string") {
        const at = t.draft.indexOf(placeholder);
        if (at >= 0) t.draft = t.draft.slice(0, at) + repl + t.draft.slice(at + placeholder.length);
      }
    }
  };
  try {
    const dataUrl = await blobToDataURL(file);
    const res = await fsPost("/api/upload-image", {
      dataB64: dataUrl, mime: file.type, name: file.name || "",
    });
    if (res && res.path) {
      settle(`![](${res.path})`);
      setMsg("已插入图片 " + res.path, "ok");
    } else {
      settle("");
      setMsg("图片上传失败: " + ((res && res.error) || "未知错误"), "err");
    }
  } catch (err) {
    settle("");
    setMsg("图片上传失败: " + (err && err.message ? err.message : err), "err");
  }
});

// ---------- 编辑 ↔ 预览 滚动同步（仅分屏模式）----------
// 分屏：editor-wrap 既无 mode-edit 也无 mode-preview，且当前是 markdown 文件
function isSplitMode() {
  const wrap = $("#editor-wrap");
  if (!wrap || wrap.classList.contains("hidden")) return false;
  if (wrap.classList.contains("mode-edit") || wrap.classList.contains("mode-preview")) return false;
  return activeTabIsMarkdown();
}
let scrollSyncing = false;   // 防回声循环
function ratioOf(el) {
  const range = el.scrollHeight - el.clientHeight;
  return range > 0 ? el.scrollTop / range : 0;
}
function applyRatio(el, ratio) {
  const range = el.scrollHeight - el.clientHeight;
  el.scrollTop = range > 0 ? ratio * range : 0;
}
function syncScrollFrom(src, dst) {
  if (scrollSyncing) return;
  if (!isSplitMode()) return;
  scrollSyncing = true;
  applyRatio(dst, ratioOf(src));
  // 下一帧解锁，吞掉被动滚动触发的回声事件
  requestAnimationFrame(() => { scrollSyncing = false; });
}
$("#editor").addEventListener("scroll", () => syncScrollFrom($("#editor"), $("#preview")), { passive: true });
$("#preview").addEventListener("scroll", () => syncScrollFrom($("#preview"), $("#editor")), { passive: true });

// 替换当前选中的匹配
function replaceCurrent() {
  if (find.idx < 0 || !find.matches.length) { findNext(1); return; }
  const ta = $("#editor");
  const m = find.matches[find.idx];
  // 仅当当前选区正好是该匹配才替换，否则先定位
  if (ta.selectionStart !== m.start || ta.selectionEnd !== m.end) {
    selectMatch(find.idx);
    return;
  }
  const rep = $("#replace-input").value;
  ta.setRangeText(rep, m.start, m.end, "end");
  fireEditorInput();
  const nextCaret = m.start + rep.length;
  ta.selectionStart = ta.selectionEnd = nextCaret;
  // 重新计算并定位下一个
  computeMatches();
  if (!find.matches.length) { find.idx = -1; updateFindCount(); return; }
  let t = find.matches.findIndex(x => x.start >= nextCaret);
  if (t < 0) t = 0;
  selectMatch(t);
}

// 全部替换
function replaceAll() {
  computeMatches();
  if (!find.matches.length) { updateFindCount(); return; }
  const ta = $("#editor");
  const rep = $("#replace-input").value;
  // 从后往前替换，避免下标偏移
  let text = ta.value;
  for (let i = find.matches.length - 1; i >= 0; i--) {
    const m = find.matches[i];
    text = text.slice(0, m.start) + rep + text.slice(m.end);
  }
  const count = find.matches.length;
  ta.value = text;
  fireEditorInput();
  computeMatches();
  find.idx = -1;
  updateFindCount();
  setMsg(`已替换 ${count} 处`, "ok");
}

$("#find-input").addEventListener("input", () => runFind(false));
$("#find-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
  else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
});
$("#replace-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); replaceCurrent(); }
  else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
});
$("#find-next").onclick = () => findNext(1);
$("#find-prev").onclick = () => findNext(-1);
$("#find-close").onclick = closeFind;
$("#replace-one").onclick = replaceCurrent;
$("#replace-all").onclick = replaceAll;
$("#find-regex").onclick = () => {
  find.regex = !find.regex;
  $("#find-regex").classList.toggle("on", find.regex);
  runFind(false);
};
$("#find-case").onclick = () => {
  find.ci = !find.ci;   // ci=true 表示忽略大小写；按钮高亮表示“区分大小写”=!ci
  $("#find-case").classList.toggle("on", !find.ci);
  runFind(false);
};

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    // 仅在「主」文本编辑视图激活时拦截；焦点在分屏副组(或非文本视图)时放行浏览器查找
    const sideFocused = window.split && window.split.isSideFocused && window.split.isSideFocused();
    if (state.kind === "text" && !$("#editor-wrap").classList.contains("hidden") && !sideFocused) {
      e.preventDefault();
      openFind();
    }
  }
});

// Tab 键插入缩进（宽度跟随设置：2/4 空格或真实 Tab）
$("#editor").addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const cfg = window.wbSettings ? wbSettings() : null;
    const tw = cfg ? cfg.tabWidth : "2";
    const ins = tw === "tab" ? "\t" : (tw === "4" ? "    " : "  ");
    const t = e.target, s = t.selectionStart, end = t.selectionEnd;
    t.value = t.value.slice(0, s) + ins + t.value.slice(end);
    t.selectionStart = t.selectionEnd = s + ins.length;
  }
});

// ---------- 保存 ----------
async function save() {
  if (!state.current) return;
  const path = state.current;          // 在 await 前固定目标路径，避免存盘往返中切换标签存错文件
  let content;
  if (state.kind === "md") {
    // Vditor 未就绪 / 实例当前不是这个文件时 getValue 会返回空串——别用它覆盖文件（防截断）
    if (!vd.inst || !vd.ready || vd.curPath !== path) { setMsg("编辑器尚未就绪，请稍候再保存", "warn"); return; }
    content = vditorGetValue();
  } else if (state.kind === "text") content = $("#editor").value;
  else return;
  const projectKey = projectStateKey(path);
  const res = projectKey ? await api.saveProjectFile(projectKey, content) : await api.save(path, content);
  if (res.error) { setMsg("保存失败: " + res.error, "err"); return; }
  const t = tabByPath(path);           // 按固定路径回写，而不是 await 后的 state.current
  if (t) { t.dirty = false; t.draft = content; }
  if (state.activeTab === path) {      // 仅当被存文件仍是当前标签，才清全局脏标
    state.dirty = false;
    document.body.classList.remove("dirty");
  }
  renderTabs();
  setMsg(`已保存 · ${fmtSize(res.size)}`, "ok");
  if (projectKey && window.reloadProjectMemory) window.reloadProjectMemory();
  if (activeView === "git") refreshGit();  // 保存后刷新 Git 状态
}
// 焦点在副分屏组时存副组，否则存主组
function saveRouted() {
  if (window.split && window.split.isSideFocused()) return window.split.save();
  return save();
}
$("#btn-save").onclick = saveRouted;
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveRouted(); }
});

// ---------- Ctrl+P 快速打开 ----------
let qoFiles = [];          // 全量相对路径缓存
let qoFilesLoaded = false;
let qoResults = [];        // 当前过滤结果（{path, marks}）
let qoSel = 0;             // 当前高亮索引

async function loadFlatFiles(force = false) {
  if (qoFilesLoaded && !force) return;
  try {
    const data = await fetch("/api/files-flat").then(r => r.json());
    qoFiles = Array.isArray(data.files) ? data.files : [];
    qoFilesLoaded = true;
  } catch { qoFiles = []; }
}

// 子序列模糊匹配：返回匹配的字符下标数组，不匹配返回 null。
// 评分：连续命中、命中文件名（最后一段）的越靠前越优。
function fuzzyMatch(query, path) {
  const q = query.toLowerCase();
  const s = path.toLowerCase();
  if (!q) return { marks: [], score: 0 };
  const marks = [];
  let qi = 0, score = 0, prev = -2;
  const slash = s.lastIndexOf("/");
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      marks.push(i);
      if (i === prev + 1) score += 6;       // 连续命中加权
      if (i > slash) score += 3;            // 命中文件名部分加权
      if (i === slash + 1) score += 4;      // 文件名首字符
      score += 1;
      prev = i; qi++;
    }
  }
  if (qi < q.length) return null;
  score -= (path.length - query.length) * 0.05;  // 越短越优
  return { marks, score };
}

function quickOpenIsOpen() {
  return !$("#quickopen").classList.contains("hidden");
}

async function openQuickOpen() {
  if (quickOpenIsOpen()) return;
  const input = $("#qo-input");
  $("#quickopen").classList.remove("hidden");
  input.value = "";
  $("#qo-list").innerHTML = `<div class="qo-empty">加载文件列表…</div>`;
  input.focus();
  await loadFlatFiles();
  qoRender("");
}

function closeQuickOpen() {
  $("#quickopen").classList.add("hidden");
}

function qoRender(query) {
  query = query.trim();
  let items;
  if (!query) {
    // 空查询：先列最近打开的标签，再补充其他文件，限量
    const tabPaths = state.tabs.map(t => t.path);
    const rest = qoFiles.filter(p => !tabPaths.includes(p));
    items = [...tabPaths, ...rest].slice(0, 200).map(p => ({ path: p, marks: [] }));
  } else {
    const scored = [];
    for (const p of qoFiles) {
      const m = fuzzyMatch(query, p);
      if (m) scored.push({ path: p, marks: m.marks, score: m.score });
    }
    scored.sort((a, b) => b.score - a.score);
    items = scored.slice(0, 200);
  }
  qoResults = items;
  qoSel = 0;
  const list = $("#qo-list");
  if (items.length === 0) {
    list.innerHTML = `<div class="qo-empty">无匹配文件</div>`;
    return;
  }
  list.innerHTML = items.map((it, idx) => {
    const slash = it.path.lastIndexOf("/");
    const dir = slash >= 0 ? it.path.slice(0, slash) : "";
    const fname = slash >= 0 ? it.path.slice(slash + 1) : it.path;
    const [iconName, iconCls] = fileIcon({ type: "file", name: fname, kind: guessKind(fname) });
    // 高亮：marks 是 path 维度下标，转换到 fname 维度
    const base = slash >= 0 ? slash + 1 : 0;
    const hlSet = new Set(it.marks.filter(m => m >= base).map(m => m - base));
    let nameHtml = "";
    for (let i = 0; i < fname.length; i++) {
      const ch = escHtml(fname[i]);
      nameHtml += hlSet.has(i) ? `<span class="qo-hl">${ch}</span>` : ch;
    }
    return `<div class="qo-item${idx === 0 ? " sel" : ""}" data-idx="${idx}">`
      + `<span class="qo-ico ${iconCls}">${svgIcon(iconName, 15)}</span>`
      + `<span class="qo-text"><div class="qo-fname">${nameHtml}</div>`
      + (dir ? `<div class="qo-dir">${escHtml(dir)}</div>` : "")
      + `</span></div>`;
  }).join("");
  list.querySelectorAll(".qo-item").forEach(el => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.idx, 10);
      qoChoose(idx);
    });
    el.addEventListener("mousemove", () => {
      const idx = parseInt(el.dataset.idx, 10);
      if (idx !== qoSel) qoSetSel(idx);
    });
  });
}

// 依扩展名粗判类型（仅用于快速打开的图标）
function guessKind(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const imgs = ["png","jpg","jpeg","gif","webp","svg","bmp","ico"];
  if (imgs.includes(ext)) return "image";
  return "text";
}

function qoSetSel(idx) {
  const list = $("#qo-list");
  const items = list.querySelectorAll(".qo-item");
  if (!items.length) return;
  idx = Math.max(0, Math.min(items.length - 1, idx));
  items[qoSel]?.classList.remove("sel");
  qoSel = idx;
  items[qoSel].classList.add("sel");
  items[qoSel].scrollIntoView({ block: "nearest" });
}

function qoChoose(idx) {
  const it = qoResults[idx];
  if (!it) return;
  closeQuickOpen();
  openFile(it.path, true);  // 传 true 触发树高亮
}

$("#qo-input").addEventListener("input", (e) => qoRender(e.target.value));
$("#qo-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); qoSetSel(qoSel + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); qoSetSel(qoSel - 1); }
  else if (e.key === "Enter") { e.preventDefault(); qoChoose(qoSel); }
  else if (e.key === "Escape") { e.preventDefault(); closeQuickOpen(); }
});
$("#quickopen").addEventListener("mousedown", (e) => {
  if (e.target === $("#quickopen")) closeQuickOpen();
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    if (quickOpenIsOpen()) closeQuickOpen(); else openQuickOpen();
  }
});

// ---------- 活动栏：视图切换 ----------
let activeView = "files";
let sidebarCollapsed = localStorage.getItem("wb-sidebar-collapsed") === "1";
let wsRestoring = false;   // 恢复期间不写回，避免覆盖
let wsSuspendSave = false; // 工作区切换时短暂禁止主组状态回写，避免旧 key 被空标签覆盖
function setSidebarCollapsed(collapsed) {
  sidebarCollapsed = !!collapsed;
  document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  const side = $("#sidebar");
  const rz = $("#sidebar-resizer");
  if (side) side.setAttribute("aria-hidden", sidebarCollapsed ? "true" : "false");
  if (rz) rz.classList.toggle("hidden", sidebarCollapsed);
  localStorage.setItem("wb-sidebar-collapsed", sidebarCollapsed ? "1" : "0");
  if (!wsRestoring && !wsSuspendSave && typeof saveWorkspace === "function") saveWorkspace();
  try { window.dispatchEvent(new Event("resize")); } catch {}
}
function switchView(view) {
  if (!view || !$("#view-" + view)) return;
  activeView = view;
  document.querySelectorAll(".act").forEach(b =>
    b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $("#view-" + view).classList.remove("hidden");
  if (view === "git") refreshGit();
  if (view === "search" && window.focusSearchInput) window.focusSearchInput();
  if (view === "project" && window.focusProjectMemory) window.focusProjectMemory();
  if (view === "tasks" && window.focusWorkflowTasks) window.focusWorkflowTasks();
  if (view === "ecosystem" && window.focusEcosystem) window.focusEcosystem();
  if (!wsRestoring && !wsSuspendSave && typeof saveWorkspace === "function") saveWorkspace();
}
document.querySelectorAll(".act").forEach(btn => {
  btn.onclick = () => {
    const view = btn.dataset.view;
    if (view === activeView && !sidebarCollapsed) {
      setSidebarCollapsed(true);
      return;
    }
    if (sidebarCollapsed) setSidebarCollapsed(false);
    switchView(view);
  };
});
setSidebarCollapsed(sidebarCollapsed);

$("#btn-refresh").onclick = () => window.wbWorkspaceActions && wbWorkspaceActions.run("refreshTree");
$("#btn-new-file").onclick = () => window.wbWorkspaceActions && wbWorkspaceActions.run("newFileRoot");
$("#btn-new-dir").onclick = () => window.wbWorkspaceActions && wbWorkspaceActions.run("newFolderRoot");
$("#status-file").onclick = () => window.wbCurrentFile && wbCurrentFile.run("revealInExplorer");

// ---------- 杂项 ----------
let msgTimer = null;
function setMsg(text, cls = "") {
  const el = $("#status-msg");
  el.textContent = text; el.className = cls;
  clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => { el.textContent = ""; el.className = ""; }, 4000);
}
function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

// ---------- 工作区（根目录）管理 ----------
// IDE 式：启动先查 /api/config，有工作区则进文件树，否则渲染欢迎页。
// 工作区会话状态（打开的标签等）按根路径分区存 localStorage，切根不丢。
let currentRoot = null;   // 当前工作区主根（字符串）
let currentWorkspaceId = null;
let currentWorkspaceRoots = [];
window.currentRoot = currentRoot;
window.currentWorkspaceId = currentWorkspaceId;
window.currentWorkspaceRoots = currentWorkspaceRoots;
window.hasOpenWorkspace = () => !!currentRoot;

function wsKey() {
  if (!currentWorkspaceId) return null;
  return "wb-ws:" + currentWorkspaceId;
}

async function initTree() {
  const cfg = await fetch("/api/config").then(x => x.json());
  currentRoot = cfg.currentRoot;
  currentWorkspaceId = cfg.workspaceId || null;
  currentWorkspaceRoots = Array.isArray(cfg.workspaceRoots) ? cfg.workspaceRoots : (currentRoot ? [currentRoot] : []);
  window.currentRoot = currentRoot;
  window.currentWorkspaceId = currentWorkspaceId;
  window.currentWorkspaceRoots = currentWorkspaceRoots;
  window.hasOpenWorkspace = () => !!currentRoot;
  if (cfg.hasWorkspace && currentRoot) {
    $("#crumb").textContent = currentWorkspaceRoots.length > 1
      ? `工作区: ${currentWorkspaceRoots.length} 个目录`
      : "根目录: " + currentRoot;
    await loadTree("", $("#tree"));
    hydrateIcons($("#tree"));
    if (!state.tabs.length && !state.activeTab) showEmptyWorkspace(currentRoot);
  } else {
    // 无工作区：显示欢迎页，隐藏标签栏/编辑区
    showWelcome(cfg);
  }
  updateWorkspaceActionState();
  if (window.refreshGit) window.refreshGit();
}

// 渲染欢迎页（无工作区时）。cfg 来自 /api/config，含 recent 列表
function showWelcome(cfg) {
  $("#crumb").textContent = "未打开工作区";
  $("#tabbar").classList.add("hidden");
  $("#editor-wrap").classList.add("hidden");
  const empty = $("#workspace-empty"); if (empty) empty.classList.add("hidden");
  const vdEl = $("#vditor"); if (vdEl) vdEl.classList.add("hidden");
  const vh = $("#viewer-host"); if (vh) vh.classList.add("hidden");
  $("#diff-view").classList.add("hidden");
  $("#image-view").classList.add("hidden");
  $("#binary-view").classList.add("hidden");
  const fh = $("#filehist-view"); if (fh) fh.classList.add("hidden");
  const bl = $("#blame-view"); if (bl) bl.classList.add("hidden");
  const w = $("#welcome");
  w.classList.remove("hidden");
  state.current = null; state.kind = null; state.activeTab = null;
  updateTopActionState();
  updateWorkspaceActionState();
  // 隐藏可能残留的查看器
  if (state.viewer && typeof state.viewer.unmount === "function") {
    try { state.viewer.unmount(); } catch {}
  }
  state.viewer = null;
  // 渲染最近列表
  const list = $("#welcome-recent-list");
  list.innerHTML = "";
  const recent = (cfg && cfg.recent) || [];
  if (recent.length) {
    $("#welcome-recent").classList.remove("hidden");
    for (const r of recent) {
      const li = document.createElement("li");
      li.className = "welcome-recent-item";
      // 失效路径置灰（不主动剔除，保留用户记忆，点击时由 set-root 校验）
      // 这里不预检 is_dir（前端无文件系统访问），交给后端 set-root 报错
      li.innerHTML = `
        <span class="wr-icon"><span class="i" data-icon="folder"></span></span>
        <span class="wr-text">
          <div class="wr-name">${escapeHtml(r.name)}</div>
          <div class="wr-path">${escapeHtml((r.roots && r.roots.join("  ·  ")) || r.path)}</div>
        </span>
        <button class="wr-remove" title="从列表移除"><span class="i" data-icon="close"></span></button>`;
      li.addEventListener("click", (e) => {
        if (e.target.closest(".wr-remove")) return;
        switchWorkspace(r.roots && r.roots.length ? r.roots : r.path);
      });
      li.querySelector(".wr-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        removeRecent(r.id || r.path);
      });
      list.appendChild(li);
    }
  } else {
    $("#welcome-recent").classList.add("hidden");
  }
  hydrateIcons(w);
}

// 切换工作区：调 /api/set-root，成功后整体重载
async function switchWorkspace(pathOrRoots) {
  if (!pathOrRoots) return;
  // 有未保存改动先确认
  const anyDirty = state.dirty || state.tabs.some(t => t.dirty)
    || (window.split && typeof window.split.hasUnsaved === "function" && window.split.hasUnsaved());
  if (anyDirty && !confirm("有未保存的修改，切换工作目录将丢弃它们。确定继续？")) return;
  const body = Array.isArray(pathOrRoots) ? { roots: pathOrRoots } : { path: pathOrRoots };
  const r = await fsPost("/api/set-root", body);
  if (r.error) { setMsg(r.error, "err"); return; }
  await reloadRoot(r.workspace || { path: r.root, roots: r.workspaceRoots || [r.root], id: r.workspaceId }, r.recent);
}
window.switchWorkspace = switchWorkspace;

function showEmptyWorkspace(root) {
  hideAllViews();
  $("#welcome").classList.add("hidden");
  const empty = $("#workspace-empty");
  if (empty) { empty.classList.remove("hidden"); hydrateIcons(empty); }
  $("#tabbar").classList.add("hidden");
  $("#crumb").textContent = currentWorkspaceRoots.length > 1
    ? `工作区: ${currentWorkspaceRoots.length} 个目录`
    : (root ? ("根目录: " + root) : "未打开工作区");
  $("#status-file").textContent = "未打开文件";
  state.current = null; state.kind = null; state.activeTab = null;
  updateStatusFileAction();
  updateTopActionState();
  updateWorkspaceActionState();
}

async function expandTreeToPath(path) {
  if (!path) return;
  if (path.startsWith("@")) {
    const rootSeg = path.split("/")[0];
    const rootRow = findRow(rootSeg);
    if (rootRow && rootRow.dataset.type === "dir") {
      const children = childrenOf(rootRow);
      if (children && children.classList.contains("hidden")) {
        rootRow.click();
        await waitFor(() => children.dataset.loaded === "1");
        hydrateIcons(children);
      }
    }
  }
  const parts = path.split("/");
  if (parts.length <= 1) return;
  let cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? (cur + "/" + parts[i]) : parts[i];
    const row = findRow(cur);
    if (!row || row.dataset.type !== "dir") break;
    const children = childrenOf(row);
    if (!children) break;
    if (!children.dataset.loaded) {
      await loadTree(cur, children);
      children.dataset.loaded = "1";
      hydrateIcons(children);
    }
    if (children.classList.contains("hidden")) {
      children.classList.remove("hidden");
      const twist = row.querySelector(":scope > .twist");
      const ico = row.querySelector(":scope > .ico");
      if (twist) twist.classList.add("open");
      if (ico) ico.innerHTML = svgIcon("folderOpen", 16);
    }
    state.expanded.add(cur);
  }
}

// 从最近列表移除一项
async function removeRecent(path) {
  const r = await fsPost("/api/recent/remove", path && path.startsWith("ws:") ? { id: path } : { path });
  if (r.error) { setMsg(r.error, "err"); return; }
  // 就地刷新欢迎页的最近列表（不整页重载）
  const cfg = await fetch("/api/config").then(x => x.json());
  showWelcome(cfg);
}
window.removeRecent = removeRecent;

// 切换工作区后整体重载（set-root 成功 / 桌面版 open_folder 用）
async function reloadRoot(workspace, recent) {
  const newRoot = workspace && workspace.path ? workspace.path : null;
  // 1) 先把当前工作区状态存到旧 key（切根前留档）
  saveWorkspace();
  wsSuspendSave = true;
  try {
    // 2) 关闭所有标签 + 清空编辑区
    state.tabs = [];
    state.activeTab = null;
    state.current = null;
    state.dirty = false;
    state.expanded = new Set();
    if (typeof renderTabs === "function") renderTabs();
    if (typeof closeCurrent === "function") closeCurrent();
    if (window.split && window.split.reset) window.split.reset();  // 切根目录时拆掉分屏副组
    // 3) 切到新根
    currentRoot = newRoot;
    currentWorkspaceId = workspace && workspace.id ? workspace.id : null;
    currentWorkspaceRoots = workspace && Array.isArray(workspace.roots) ? workspace.roots : (newRoot ? [newRoot] : []);
    window.currentRoot = currentRoot;
    window.currentWorkspaceId = currentWorkspaceId;
    window.currentWorkspaceRoots = currentWorkspaceRoots;
    window.hasOpenWorkspace = () => !!currentRoot;
    $("#crumb").textContent = currentWorkspaceRoots.length > 1
      ? `工作区: ${currentWorkspaceRoots.length} 个目录`
      : "根目录: " + newRoot;
    // 4) 隐藏欢迎页、显示编辑区骨架
    $("#welcome").classList.add("hidden");
    // 5) 加载新文件树
    await loadTree("", $("#tree"));
    hydrateIcons($("#tree"));
    // 6) 从新根分区恢复工作区
    await restoreWorkspace();
    if (window.split && window.split.restore) { try { await window.split.restore(); } catch (_) {} }
    for (const tab of state.tabs) {
      try { await expandTreeToPath(tab.path); } catch (_) {}
    }
    if (!state.tabs.length) showEmptyWorkspace(newRoot);
    if (window.refreshGit) window.refreshGit();
    if (window.reloadProjectMemory) window.reloadProjectMemory();
    if (window.reloadTasks) window.reloadTasks();
    if (window.reloadWorkflowTasks) window.reloadWorkflowTasks();
    if (window.reloadAgentSessions) window.reloadAgentSessions();
    if (window.reloadEcosystem) window.reloadEcosystem();
    setMsg("已切换工作区: " + (workspace && workspace.name ? workspace.name : newRoot), "ok");
  } finally {
    wsSuspendSave = false;
  }
}
window.reloadRoot = reloadRoot;

window.addEventListener("beforeunload", (e) => {
  // 活动主标签(state.dirty) + 任意未激活主标签 + 分屏副组 任一有未保存改动都要拦
  const anyDirty = state.dirty
    || state.tabs.some(t => t.dirty)
    || (window.split && typeof window.split.hasUnsaved === "function" && window.split.hasUnsaved());
  if (anyDirty) { e.preventDefault(); e.returnValue = ""; }
});

// ---------- 主题 ----------
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("wb-theme", t);
  const btn = $("#btn-theme");
  // 显示「将切换到的」模式图标
  btn.innerHTML = svgIcon(t === "dark" ? "sun" : "moon", 16);
  btn.title = t === "dark" ? "切换到浅色" : "切换到深色";
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(cur === "dark" ? "light" : "dark");
  const newTheme = document.documentElement.getAttribute("data-theme") || "dark";
  // 主题切换后重渲染预览，让 mermaid 图跟随深浅色
  if (state.kind === "text") renderPreview();
  // 多格式查看器：把新主题告知当前查看器
  if (state.kind === "viewer" && state.viewer && typeof state.viewer.onTheme === "function") {
    try { state.viewer.onTheme(newTheme); } catch (e) { /* 主题回调失败不影响切换 */ }
  }
  // Vditor 主题跟随（4.x：setTheme(theme, codeMirrorTheme) 只两参；editorTheme 另调）
  if (vd.inst && vd.ready) {
    try {
      // 1) 界面深浅 + 代码块主题
      vd.inst.setTheme(vditorTheme(), vditorCodeTheme());
      // 2) editorTheme：换 --bg-color/--front-color 等具体颜色变量（正文/标题/表格/代码可读性）
      if (typeof vd.inst.setEditorTheme === "function") vd.inst.setEditorTheme(vditorEditorTheme());
      // 3) mermaidTheme：切换内置命名主题，并重渲染图（mermaid 不会自动跟随，需强制重灌内容）
      vd.inst.vditor.options.mermaidTheme = vditorMermaidTheme();
      try {
        const cur = document.getElementById("vditor");
        if (cur) cur.setAttribute("data-mermaid-theme", vditorMermaidTheme());
        document.documentElement.setAttribute("data-mermaid-theme", vditorMermaidTheme());
      } catch {}
      // 重灌内容触发 mermaid 用新主题重绘（保留脏标记，不影响 dirty 状态）
      const wasDirty = state.dirty;
      const t = tabByPath(state.activeTab);
      const wasTabDirty = t && t.dirty;
      vd.inst.setValue(vd.inst.getValue());
      state.dirty = wasDirty;
      if (t) t.dirty = !!wasTabDirty;
    } catch {}
  }
}
window.toggleTheme = toggleTheme;
$("#btn-theme").onclick = () => {
  if (window.wbChromeActions && window.wbChromeActions.run) wbChromeActions.run("theme");
  else toggleTheme();
};
applyTheme(localStorage.getItem("wb-theme") || "dark");

// ---------- 工作区记忆：保存/恢复打开的标签（按根路径分区）----------
// 旧版用固定 key "wb-workspace"，切根时清空、重启时回到错误根。
// 现按 workspaceId 分区：每个工作区独立记忆，切根不丢、跨会话恢复到上次工作区。
function saveWorkspace() {
  if (wsRestoring) return;
  if (wsSuspendSave) return;
  const key = wsKey();
  if (!key) return;   // 无工作区不记忆
  try {
    const paths = state.tabs.map(t => t.path);
    localStorage.setItem(key, JSON.stringify({
      version: 2,
      tabs: paths,
      active: state.activeTab,
      ui: {
        activeView,
        sidebarCollapsed,
      },
    }));
  } catch {}
}
window.saveWorkspace = saveWorkspace;

function restoreWorkspaceUi(data) {
  const ui = data && data.ui && typeof data.ui === "object" ? data.ui : {};
  if (typeof ui.sidebarCollapsed === "boolean") setSidebarCollapsed(ui.sidebarCollapsed);
  if (ui.activeView && $("#view-" + ui.activeView)) switchView(ui.activeView);
}

async function restoreWorkspace() {
  const key = wsKey();
  if (!key) return;
  let data;
  try { data = JSON.parse(localStorage.getItem(key) || "null"); } catch { data = null; }
  if ((!data || !Array.isArray(data.tabs) || !data.tabs.length) && currentRoot) {
    try { data = JSON.parse(localStorage.getItem("wb-ws:" + currentRoot) || "null"); } catch { data = null; }
  }
  if (!data || (!Array.isArray(data.tabs) && !data.ui)) return;
  wsRestoring = true;
  try {
    restoreWorkspaceUi(data);
    // 不能用 /api/files-flat 当存在性判据：它会被截断(>2000)、且故意剔除 node_modules/.git/dist
    // 等忽略目录——会误删这些目录下已打开的标签并永久遗忘。改为直接尝试打开，让 openFile 自身的
    // 404 处理丢弃真正不存在的文件(quiet 模式不弹错误提示)，存在的(含忽略目录内)正常恢复。
    for (const p of (Array.isArray(data.tabs) ? data.tabs : [])) {
      try { await openFile(p, false, { quiet: true }); } catch (_) {}   // 单个坏标签不阻断其余恢复
    }
  } finally {
    wsRestoring = false;   // 任何异常都不能让 wsRestoring 永久卡 true（否则整会话工作区记忆失效）
  }
  const act = data.active;
  if (act && tabByPath(act)) activateTab(act);
  saveWorkspace();
}

// 欢迎页按钮绑定（一次性；HTML 里静态按钮，showWelcome 只刷新最近列表）
async function chooseAndSwitchWorkspace() {
  if (window.workbenchDesktopOpenWorkspace) {
    const handled = await window.workbenchDesktopOpenWorkspace();
    if (handled) return;
  }
  // 桌面版：多选文件夹组成一个工作区；不支持多选时退化为单目录
  if (window.pywebview && window.pywebview.api && (window.pywebview.api.open_folders || window.pywebview.api.open_folder)) {
    try {
      const api = window.pywebview.api;
      const roots = api.open_folders ? await api.open_folders() : null;
      if (roots && roots.length) { await switchWorkspace(roots); return; }
      const p = api.open_folder ? await api.open_folder() : null;
      if (p) await switchWorkspace(p);
    } catch (e) { console.error(e); }
    return;
  }
  // 浏览器版：多目录用分号分隔
  const p = prompt("输入工作区文件夹路径（多个目录用分号 ; 分隔）：", currentRoot || "");
  if (p && p.trim()) {
    const roots = p.split(";").map(x => x.trim()).filter(Boolean);
    await switchWorkspace(roots.length > 1 ? roots : roots[0]);
  }
}

function workspaceActionState(action) {
  if (action === "open") return { enabled: true, reason: "" };
  if (!currentRoot) return { enabled: false, reason: "请先打开工作区" };
  if (action === "newFileRoot" && typeof fsCreate !== "function") {
    return { enabled: false, reason: "新建文件能力尚未就绪" };
  }
  if (action === "newFolderRoot" && typeof fsCreateDir !== "function") {
    return { enabled: false, reason: "新建文件夹能力尚未就绪" };
  }
  if (action === "refreshTree" && typeof initTree !== "function") {
    return { enabled: false, reason: "文件树刷新能力尚未就绪" };
  }
  return { enabled: true, reason: "" };
}

async function runWorkspaceAction(action) {
  const st = workspaceActionState(action);
  if (!st.enabled) {
    setMsg(st.reason || "当前不可用", "warn");
    return false;
  }
  if (action === "open") { await chooseAndSwitchWorkspace(); return true; }
  if (action === "newFileRoot") { await fsCreate("", $("#tree")); return true; }
  if (action === "newFolderRoot") { await fsCreateDir("", $("#tree")); return true; }
  if (action === "refreshTree") {
    state.expanded.clear();
    await initTree();
    setMsg("文件树已刷新", "ok");
    return true;
  }
  setMsg("未知工作区动作: " + action, "warn");
  return false;
}

window.wbWorkspaceActions = {
  actionState: workspaceActionState,
  run: runWorkspaceAction,
  summary: () => ({
    hasWorkspace: !!currentRoot,
    root: currentRoot,
    roots: currentWorkspaceRoots.slice(),
    workspaceId: currentWorkspaceId,
  }),
};

function bindWelcomeButtons() {
  const topOpenBtn = $("#btn-open-folder");
  if (topOpenBtn) topOpenBtn.onclick = () => wbWorkspaceActions.run("open");

  const openBtn = $("#welcome-open");
  if (openBtn) openBtn.onclick = () => wbWorkspaceActions.run("open");

  const newBtn = $("#welcome-new");
  if (newBtn) newBtn.onclick = async () => {
    const p = prompt("输入新文件夹路径（将创建并打开）：", "");
    if (!p || !p.trim()) return;
    const path = p.trim();
    const r = await fsPost("/api/create-workspace", { path });
    if (r.error) {
      setMsg(r.error, "err");
      return;
    }
    await reloadRoot(r.workspace || { path: r.root, roots: r.workspaceRoots || [r.root], id: r.workspaceId }, r.recent);
  };
}

hydrateIcons();   // 把 data-icon 占位换成 SVG
initTools();
initGit();
initSearch();
initNotes();
if (window.initProjectMemory) initProjectMemory();
if (window.initTasksPanel) initTasksPanel();
if (window.initEcosystemPanel) initEcosystemPanel();
refreshGit();  // 首次加载更新 Git 徽标/状态栏
if (window.initWorkbench) initWorkbench();  // 命令面板/设置/快捷键/状态栏
bindWelcomeButtons();
updateTopActionState();
updateWorkspaceActionState();
(async () => {
  await initTree();
  await restoreWorkspace();
  // 主组恢复完毕后再恢复分屏副组（顺序固定，避免抢写工作区记忆）
  if (window.split && window.split.restore) { try { await window.split.restore(); } catch (_) {} }
  if (currentRoot && !state.tabs.length && !state.activeTab) showEmptyWorkspace(currentRoot);
})();
