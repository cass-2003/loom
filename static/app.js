/* Workbench 前端 */
const $ = (s) => document.querySelector(s);
const api = {
  tree: (p) => fetch(`/api/tree?path=${encodeURIComponent(p)}`).then(r => r.json()),
  file: (p) => fetch(`/api/file?path=${encodeURIComponent(p)}`),
  save: (p, c) => fetch(`/api/save`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p, content: c }),
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
};
window.state = state;  // 供工具箱 (Git) 读取当前文件

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
}
// 文件/目录被删除时关闭受影响的标签
function handlePathDeleted(path, isDir) {
  const affected = (p) => p === path || (isDir && p.startsWith(path + "/"));
  const survivors = state.tabs.filter(t => !affected(t.path));
  if (survivors.length === state.tabs.length) return;  // 无影响
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
  $("#welcome").classList.remove("hidden");
  $("#editor").value = "";
  state.current = null; state.kind = null; state.activeTab = null;
  state.dirty = false; document.body.classList.remove("dirty");
  $("#status-file").textContent = "未打开文件";
  $("#crumb").textContent = "";
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
    el.className = "ctx-item" + (it.danger ? " danger" : "");
    el.innerHTML = svgIcon(it.icon, 15) + `<span>${escHtml(it.label)}</span>`;
    el.onclick = () => { closeCtxMenu(); it.action(); };
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
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const container = containerOf(row);
    const parentRel = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    const isDir = entry.type === "dir";
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
    ov.querySelector('[data-act="ok"]').disabled = true;
    const err = await onSubmit(name);
    if (err) {
      errEl.textContent = err;
      ov.querySelector('[data-act="ok"]').disabled = false;
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

// ---------- 打开文件 ----------
window.openFile = openFile;

// 在打开/切换文件前，把当前文本标签的编辑器内容暂存进 tab 对象（保留未保存草稿）
function stashActiveTab() {
  const t = tabByPath(state.activeTab);
  if (t && t.kind === "text") {
    t.draft = $("#editor").value;
    t.viewMode = viewMode;
    t.dirty = state.dirty;
  }
}

// 打开文件：已打开则直接切换，否则新建标签并加载
// opts.line（1 起）：打开后滚动/选中到该行（仅文本文件）
async function openFile(path, row, opts) {
  const gotoLine = opts && opts.line ? opts.line : null;
  if (row) highlightTreeRow(path);
  const existing = tabByPath(path);
  if (existing) {
    if (gotoLine) existing.pendingLine = gotoLine;
    activateTab(path);
    return;
  }

  // 先把当前标签的编辑状态暂存，避免被新文件覆盖
  stashActiveTab();

  // 请求令牌：连续切换文件时，只让最后一次请求生效，丢弃过期响应
  const token = ++state.openSeq;
  const res = await api.file(path);
  if (token !== state.openSeq) return;
  const ctype = res.headers.get("Content-Type") || "";

  const name = path.split("/").pop();
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
  if (data.error) { setMsg(data.error, "err"); return; }

  if (data.kind === "binary") {
    const tab = { path, kind: "binary", name: data.name || name, ext: "",
                  dirty: false, draft: null, viewMode: "split",
                  size: data.size };
    addTab(tab);
    activateTab(path);
    return;
  }
  // 文本
  const tab = { path, kind: "text", name: data.name || name,
                ext: data.ext || "", dirty: false, draft: data.content,
                viewMode: "split", pendingLine: gotoLine };
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

  if (tab.kind === "image") {
    state.imageUrl = URL.createObjectURL(tab.blob);
    $("#image-el").src = state.imageUrl;
    $("#image-view").classList.remove("hidden");
    setCurrent(path, "image");
  } else if (tab.kind === "binary") {
    $("#binary-info").textContent = `${tab.name} · ${fmtSize(tab.size)}`;
    $("#binary-view").classList.remove("hidden");
    setCurrent(path, "binary");
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
  const bar = $("#tabbar");
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
    bar.appendChild(el);
  }
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
  $("#crumb").textContent = path;
}

function hideAllViews() {
  $("#welcome").classList.add("hidden");
  $("#editor-wrap").classList.add("hidden");
  $("#diff-view").classList.add("hidden");
  $("#image-view").classList.add("hidden");
  $("#binary-view").classList.add("hidden");
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
  toggleMenu($("#toc-menu"), [$("#export-menu")]);
};
$("#btn-md-export").onclick = (e) => {
  e.stopPropagation();
  toggleMenu($("#export-menu"), [$("#toc-menu")]);
};
// 点击别处关闭浮层菜单
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#md-toolbar")) {
    $("#toc-menu").classList.add("hidden");
    $("#export-menu").classList.add("hidden");
  }
});
$("#export-menu").querySelectorAll(".toc-act").forEach(el => {
  el.onclick = () => {
    $("#export-menu").classList.add("hidden");
    if (el.dataset.act === "html") exportHtml();
    else if (el.dataset.act === "print") window.print();
  };
});

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
  const preview = $("#preview");
  const title = (state.current || "document").split("/").pop().replace(/\.(md|markdown)$/i, "");
  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  const css = collectStyleText();
  const bodyHtml = preview.innerHTML;
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
}

// ---------- 预览 ----------
function renderPreview() {
  if (state.kind !== "text") return;
  const html = marked.parse($("#editor").value);
  const preview = $("#preview");
  preview.innerHTML = html;
  // Markdown 增强：仅对 .md/.markdown 启用工具栏、标题锚点、大纲、mermaid
  const t = tabByPath(state.activeTab);
  const isMd = t && (t.ext === ".md" || t.ext === ".markdown");
  $("#md-toolbar").classList.toggle("hidden", !isMd);
  if (!isMd) return;
  assignHeadingIds(preview);
  buildTOC(preview);
  renderMermaid(preview);
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
    // 仅在文本编辑视图激活时拦截，否则放行浏览器查找
    if (state.kind === "text" && !$("#editor-wrap").classList.contains("hidden")) {
      e.preventDefault();
      openFind();
    }
  }
});

// Tab 键插入两个空格
$("#editor").addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const t = e.target, s = t.selectionStart, end = t.selectionEnd;
    t.value = t.value.slice(0, s) + "  " + t.value.slice(end);
    t.selectionStart = t.selectionEnd = s + 2;
  }
});

// ---------- 保存 ----------
async function save() {
  if (state.kind !== "text" || !state.current) return;
  const res = await api.save(state.current, $("#editor").value);
  if (res.error) { setMsg("保存失败: " + res.error, "err"); return; }
  state.dirty = false;
  document.body.classList.remove("dirty");
  const t = tabByPath(state.current);
  if (t) { t.dirty = false; t.draft = $("#editor").value; renderTabs(); }
  setMsg(`已保存 · ${fmtSize(res.size)}`, "ok");
  if (activeView === "git") refreshGit();  // 保存后刷新 Git 状态
}
$("#btn-save").onclick = save;
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
    e.preventDefault();
    if (quickOpenIsOpen()) closeQuickOpen(); else openQuickOpen();
  }
});

// ---------- 活动栏：视图切换 ----------
let activeView = "files";
function switchView(view) {
  activeView = view;
  document.querySelectorAll(".act").forEach(b =>
    b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $("#view-" + view).classList.remove("hidden");
  if (view === "git") refreshGit();
  if (view === "search" && window.focusSearchInput) window.focusSearchInput();
}
document.querySelectorAll(".act").forEach(btn => {
  btn.onclick = () => switchView(btn.dataset.view);
});

$("#btn-refresh").onclick = () => { state.expanded.clear(); initTree(); };
$("#btn-new-file").onclick = () => fsCreate("", $("#tree"));
$("#btn-new-dir").onclick = () => fsCreateDir("", $("#tree"));

// ---------- 侧栏宽度拖动 ----------
function initSidebarResize() {
  const sidebar = $("#sidebar"), handle = $("#sidebar-resizer");
  const MIN = 200, MAX = 620;
  const saved = parseInt(localStorage.getItem("wb-sidebar-w") || "", 10);
  if (saved >= MIN && saved <= MAX) sidebar.style.width = saved + "px";
  let dragging = false;
  handle.addEventListener("mousedown", (e) => {
    dragging = true; e.preventDefault();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    let w = e.clientX - sidebar.getBoundingClientRect().left;
    w = Math.max(MIN, Math.min(MAX, w));
    sidebar.style.width = w + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem("wb-sidebar-w", parseInt(sidebar.style.width, 10));
  });
}

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

async function initTree() {
  const r = await fetch("/api/root").then(x => x.json());
  $("#crumb").textContent = "根目录: " + r.root;
  await loadTree("", $("#tree"));
}

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
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
$("#btn-theme").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(cur === "dark" ? "light" : "dark");
  // 主题切换后重渲染预览，让 mermaid 图跟随深浅色
  if (state.kind === "text") renderPreview();
};
applyTheme(localStorage.getItem("wb-theme") || "dark");

hydrateIcons();   // 把 data-icon 占位换成 SVG
initTree();
initTools();
initGit();
initSearch();
initSidebarResize();
refreshGit();  // 首次加载更新 Git 徽标/状态栏
