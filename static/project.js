/* Workbench 项目记忆面板：读取 state/*.md，作为生态化 Phase 1 的可视入口。 */
(function () {
  const DOCS = [
    { name: "requirements", label: "Requirements" },
    { name: "progress", label: "Progress" },
    { name: "log", label: "Log" },
    { name: "memory", label: "Memory" },
  ];
  let docs = [];
  let active = "progress";

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function loadProjectState() {
    const body = $("#project-body");
    const doc = $("#project-doc");
    if (!body || !doc) return;
    doc.textContent = "加载中…";
    try {
      const data = await fetch("/api/project-state", { cache: "no-store" }).then(r => r.json());
      if (data.error) throw new Error(data.error);
      docs = Array.isArray(data.files) ? data.files : [];
      renderTabs();
      renderDoc();
    } catch (e) {
      doc.textContent = "项目记忆加载失败: " + (e && e.message ? e.message : e);
    }
  }

  function renderTabs() {
    const host = $("#project-tabs");
    if (!host) return;
    host.innerHTML = DOCS.map(d =>
      `<button class="project-tab${d.name === active ? " active" : ""}" data-name="${esc(d.name)}">${esc(d.label)}</button>`
    ).join("");
    host.querySelectorAll(".project-tab").forEach(btn => {
      btn.onclick = () => {
        active = btn.dataset.name;
        renderTabs();
        renderDoc();
      };
    });
  }

  function renderDoc() {
    const meta = $("#project-meta");
    const doc = $("#project-doc");
    if (!doc) return;
    const item = docs.find(x => x.name === active) || docs[0];
    if (!item) {
      if (meta) meta.textContent = "未找到 state 文件";
      doc.textContent = "";
      return;
    }
    if (meta) {
      const stamp = item.mtime ? new Date(item.mtime * 1000).toLocaleString() : "未创建";
      meta.textContent = `${item.file} · ${stamp}`;
    }
    doc.textContent = item.content || "（空）";
  }

  function setProjectDoc(name) {
    if (!DOCS.some(d => d.name === name)) return;
    active = name;
    renderTabs();
    renderDoc();
  }

  function initProjectMemory() {
    const refresh = $("#project-refresh");
    if (refresh) refresh.onclick = loadProjectState;
    renderTabs();
    loadProjectState();
  }

  window.initProjectMemory = initProjectMemory;
  window.setProjectDoc = setProjectDoc;
  window.focusProjectMemory = () => {
    if (!docs.length) loadProjectState();
  };
})();
