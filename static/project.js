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
  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => r.json());
  }

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

  function askMultiline({ title, placeholder, okLabel, onSubmit }) {
    const ov = document.createElement("div");
    ov.className = "project-modal";
    ov.innerHTML = `
      <div class="project-modal-box">
        <div class="project-modal-title">${esc(title)}</div>
        <input class="project-modal-input" type="text" placeholder="标题（可选）">
        <textarea class="project-modal-text" placeholder="${esc(placeholder)}"></textarea>
        <div class="project-modal-actions">
          <button class="modal-btn" data-act="cancel">取消</button>
          <button class="modal-btn primary" data-act="ok">${esc(okLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector(".project-modal-input");
    const text = ov.querySelector(".project-modal-text");
    const close = () => ov.remove();
    const submit = async () => {
      const btn = ov.querySelector('[data-act="ok"]');
      btn.disabled = true;
      try {
        const err = await onSubmit(input.value.trim(), text.value.trim());
        if (err) {
          if (window.setMsg) setMsg(err, "err");
          btn.disabled = false;
          return;
        }
        close();
      } catch (e) {
        if (window.setMsg) setMsg("追加记录失败: " + (e && e.message ? e.message : e), "err");
        btn.disabled = false;
      }
    };
    ov.querySelector('[data-act="cancel"]').onclick = close;
    ov.querySelector('[data-act="ok"]').onclick = submit;
    ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
    text.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    setTimeout(() => text.focus(), 0);
  }

  function appendProjectRecord(kind) {
    const isValidation = kind === "validation";
    askMultiline({
      title: isValidation ? "追加验证记录" : "追加决策记录",
      placeholder: isValidation ? "写下验证命令、结果、截图或产物路径…" : "写下这次产品/架构决策和原因…",
      okLabel: "追加",
      onSubmit: async (title, content) => {
        const target = isValidation ? "progress" : "log";
        const res = await postJson("/api/project-state/append", { kind, target, title, content });
        if (res.error) return res.error;
        active = target;
        await loadProjectState();
        if (window.setMsg) setMsg("已追加项目记忆", "ok");
        return null;
      },
    });
  }

  function openProjectStateFile(name) {
    const key = name || active;
    if (!DOCS.some(d => d.name === key)) return;
    active = key;
    renderTabs();
    if (typeof switchView === "function") switchView("files");
    if (window.openFile) window.openFile("project://" + key);
  }

  function initProjectMemory() {
    const refresh = $("#project-refresh");
    if (refresh) refresh.onclick = loadProjectState;
    const openSource = $("#project-open-source");
    if (openSource) openSource.onclick = () => openProjectStateFile(active);
    const decision = $("#project-add-decision");
    if (decision) decision.onclick = () => appendProjectRecord("decision");
    const validation = $("#project-add-validation");
    if (validation) validation.onclick = () => appendProjectRecord("validation");
    renderTabs();
    loadProjectState();
  }

  window.initProjectMemory = initProjectMemory;
  window.setProjectDoc = setProjectDoc;
  window.appendProjectRecord = appendProjectRecord;
  window.openProjectStateFile = openProjectStateFile;
  window.reloadProjectMemory = loadProjectState;
  window.focusProjectMemory = () => {
    if (!docs.length) loadProjectState();
  };
})();
