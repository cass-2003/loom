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
  let latestRecordTarget = "progress";

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
      renderRecovery();
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

  function lineCount(text) {
    return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
  }
  function docByName(name) {
    return docs.find(x => x.name === name) || null;
  }
  function workspaceSummary() {
    if (window.getWorkspaceLayoutSnapshot) {
      try { return window.getWorkspaceLayoutSnapshot(); } catch {}
    }
    return {
      roots: Array.isArray(window.currentWorkspaceRoots) ? window.currentWorkspaceRoots : [],
      activeFile: window.state && state.current ? state.current : null,
      main: { tabs: [] },
      side: { tabs: [] },
    };
  }
  function extractRecentRecord(item) {
    if (!item || !item.content) return null;
    const lines = String(item.content).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (/^##\s+Loop Record\b/i.test(line) || /^##\s+(Decision|Validation|Note)\b/i.test(line) || /^##\s+\d{4}-\d{2}-\d{2}/.test(line)) {
        const preview = lines.slice(i + 1, i + 6).map(x => x.trim()).filter(Boolean)
          .join(" ").replace(/^>\s*/g, "");
        return { target: item.name, title: line.replace(/^#+\s*/, ""), preview };
      }
    }
    const fallback = lines.slice(-8).map(x => x.trim()).filter(Boolean).join(" ");
    return fallback ? { target: item.name, title: item.file || item.name, preview: fallback } : null;
  }
  function recentRecords() {
    return ["progress", "log", "memory", "requirements"]
      .map(name => extractRecentRecord(docByName(name)))
      .filter(Boolean);
  }
  function renderRecovery() {
    const grid = $("#project-recovery-grid");
    const latest = $("#project-latest");
    const openLatest = $("#project-open-latest");
    if (!grid || !latest) return;
    const snap = workspaceSummary();
    const roots = snap && snap.roots ? snap.roots : [];
    const present = docs.filter(d => d.exists || d.content).length;
    const records = recentRecords();
    const top = records[0] || null;
    latestRecordTarget = top ? top.target : active;
    const mainTabs = snap && snap.main && snap.main.tabs ? snap.main.tabs.length : 0;
    const sideTabs = snap && snap.side && snap.side.tabs ? snap.side.tabs.length : 0;
    grid.innerHTML = [
      ["工作区", roots.length > 1 ? `${roots.length} 个目录` : (window.currentRoot || "未打开")],
      ["当前文件", snap && snap.activeFile ? snap.activeFile : "none"],
      ["布局", `主 ${mainTabs} / 侧 ${sideTabs}`],
      ["记忆文件", `${present}/${DOCS.length} 已就绪`],
      ["Progress", docByName("progress") ? `${lineCount(docByName("progress").content)} 行` : "未创建"],
      ["Log", docByName("log") ? `${lineCount(docByName("log").content)} 行` : "未创建"],
    ].map(([k, v]) => `<div class="project-recovery-card"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join("");
    latest.innerHTML = top
      ? `<b>最近记录</b><button data-target="${esc(top.target)}">${esc(top.title)}</button><span>${esc(top.preview || "无预览")}</span>`
      : "<b>最近记录</b><span>暂无可恢复记录。可以追加验证或决策记录。</span>";
    const btn = latest.querySelector("button[data-target]");
    if (btn) btn.onclick = () => setProjectDoc(btn.dataset.target);
    if (openLatest) {
      openLatest.disabled = !top;
      openLatest.title = top ? "打开最近记录来源" : "暂无最近记录";
      openLatest.onclick = () => {
        if (latestRecordTarget) setProjectDoc(latestRecordTarget);
      };
    }
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
    renderRecovery();
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
    else renderRecovery();
  };
})();
