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

const state = {
  current: null,   // 当前文件 path
  kind: null,      // text/image/binary
  dirty: false,
  expanded: new Set(),
  openSeq: 0,      // 打开文件请求令牌（防竞态）
  imageUrl: null,  // 当前图片 blob URL（用于释放）
};
window.state = state;  // 供工具箱 (Git) 读取当前文件

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
  return node;
}

// ---------- 打开文件 ----------
window.openFile = openFile;
async function openFile(path, row) {
  if (state.dirty && !confirm("当前文件未保存，确定切换？")) return;
  document.querySelectorAll(".node-row.active").forEach(e => e.classList.remove("active"));
  if (row) row.classList.add("active");

  // 请求令牌：连续切换文件时，只让最后一次请求生效，丢弃过期响应
  const token = ++state.openSeq;
  const res = await api.file(path);
  if (token !== state.openSeq) return;
  const ctype = res.headers.get("Content-Type") || "";
  hideAllViews();

  if (ctype.startsWith("image/")) {
    const blob = await res.blob();
    if (token !== state.openSeq) return;
    revokeImage();
    state.imageUrl = URL.createObjectURL(blob);
    $("#image-el").src = state.imageUrl;
    $("#image-view").classList.remove("hidden");
    setCurrent(path, "image");
    return;
  }
  const data = await res.json();
  if (token !== state.openSeq) return;
  if (data.error) { setMsg(data.error, "err"); return; }

  if (data.kind === "binary") {
    $("#binary-info").textContent = `${data.name} · ${fmtSize(data.size)}`;
    $("#binary-view").classList.remove("hidden");
    setCurrent(path, "binary");
    return;
  }
  // 文本
  $("#editor").value = data.content;
  $("#editor-wrap").classList.remove("hidden");
  setCurrent(path, "text");
  state.dirty = false;
  document.body.classList.remove("dirty");
  const isMd = data.ext === ".md" || data.ext === ".markdown";
  applyViewMode(isMd ? viewMode : "edit", isMd);
  renderPreview();
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
  $("#graph-view").classList.add("hidden");
  $("#image-view").classList.add("hidden");
  $("#binary-view").classList.add("hidden");
}

// 打开提交图（主内容区宽幅视图）
window.openGraphView = function () {
  ++state.openSeq;   // 作废在途的 openFile
  revokeImage();
  hideAllViews();
  $("#graph-view").classList.remove("hidden");
  $("#crumb").textContent = "提交图";
  if (window.loadGraph) window.loadGraph();
};

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

// ---------- 预览 ----------
function renderPreview() {
  if (state.kind !== "text") return;
  const html = marked.parse($("#editor").value);
  $("#preview").innerHTML = html;
}

let renderTimer = null;
$("#editor").addEventListener("input", () => {
  if (!state.dirty) { state.dirty = true; document.body.classList.add("dirty"); }
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, 120);
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
  setMsg(`已保存 · ${fmtSize(res.size)}`, "ok");
  if (activeView === "git") refreshGit();  // 保存后刷新 Git 状态
}
$("#btn-save").onclick = save;
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
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
}
document.querySelectorAll(".act").forEach(btn => {
  btn.onclick = () => switchView(btn.dataset.view);
});

$("#btn-refresh").onclick = () => { state.expanded.clear(); initTree(); };

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
};
applyTheme(localStorage.getItem("wb-theme") || "dark");

hydrateIcons();   // 把 data-icon 占位换成 SVG
initTree();
initTools();
initGit();
refreshGit();  // 首次加载更新 Git 徽标/状态栏
