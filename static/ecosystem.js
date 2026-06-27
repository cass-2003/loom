/* Workbench Ecosystem：只读展示本地 Skills / Playbooks，不执行脚本。 */
(function () {
  const $ = (s) => document.querySelector(s);
  let cache = { skills: [], playbooks: [] };

  const esc = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function loadEcosystem() {
    const list = $("#eco-list");
    const summary = $("#eco-summary");
    if (!list || !summary) return;
    list.innerHTML = `<div class="eco-loading">扫描中…</div>`;
    try {
      const data = await fetch("/api/ecosystem", { cache: "no-store" }).then(r => r.json());
      if (data.error) throw new Error(data.error);
      cache = {
        skills: Array.isArray(data.skills) ? data.skills : [],
        playbooks: Array.isArray(data.playbooks) ? data.playbooks : [],
      };
      renderEcosystem();
    } catch (e) {
      list.innerHTML = `<div class="eco-error">生态入口加载失败: ${esc(e && e.message ? e.message : e)}</div>`;
    }
  }

  function renderItem(item) {
    const ver = item.verification && item.verification.length
      ? `<div class="eco-lines"><b>验证</b>${item.verification.map(x => `<span>${esc(x)}</span>`).join("")}</div>` : "";
    const inputs = item.inputs && item.inputs.length
      ? `<div class="eco-lines"><b>输入</b>${item.inputs.map(x => `<span>${esc(x)}</span>`).join("")}</div>` : "";
    const desc = item.description || item.summary || "未提供说明";
    return `<article class="eco-card" data-path="${esc(item.path)}" data-source="${esc(item.source || "workspace")}">
      <div class="eco-card-head">
        <span class="eco-kind">${esc(item.kind)} · ${esc(item.source || "workspace")}</span>
        <span class="eco-risk ${esc(item.risk || "read")}">${esc(item.risk || "read")}</span>
      </div>
      <h3>${esc(item.title)}</h3>
      <p>${esc(desc)}</p>
      ${inputs}${ver}
      <button class="eco-open" data-act="open">${item.source === "builtin" ? "查看定义" : "打开定义"}</button>
    </article>`;
  }

  function showDefinition(item) {
    const ov = document.createElement("div");
    ov.className = "eco-modal";
    ov.innerHTML = `<div class="eco-modal-box">
      <div class="eco-modal-head">
        <b>${esc(item.title)}</b>
        <button class="icon-btn" data-act="close">${svgIcon("close", 14)}</button>
      </div>
      <pre>${esc(item.content || "未提供内容")}</pre>
    </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector("[data-act='close']").onclick = close;
    ov.addEventListener("mousedown", e => { if (e.target === ov) ov.remove(); });
    ov.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
    ov.tabIndex = -1;
    ov.focus();
  }

  function renderEcosystem() {
    const list = $("#eco-list");
    const summary = $("#eco-summary");
    if (!list || !summary) return;
    summary.textContent = `${cache.playbooks.length} playbooks · ${cache.skills.length} skills`;
    const parts = [];
    if (cache.playbooks.length) {
      parts.push(`<div class="eco-group-title">Playbooks</div>`);
      parts.push(cache.playbooks.map(renderItem).join(""));
    }
    if (cache.skills.length) {
      parts.push(`<div class="eco-group-title">Skills</div>`);
      parts.push(cache.skills.map(renderItem).join(""));
    }
    if (!parts.length) {
      parts.push(`<div class="eco-empty">未发现本地 Skills / Playbooks。可在 <code>.workbench/playbooks</code> 放置 Markdown playbook。</div>`);
    }
    list.innerHTML = parts.join("");
    list.querySelectorAll(".eco-card").forEach(card => {
      card.querySelector("[data-act='open']").onclick = () => {
        const all = cache.playbooks.concat(cache.skills);
        const item = all.find(x => x.path === card.dataset.path && (x.source || "workspace") === card.dataset.source);
        if (!item) return;
        if (item.source === "builtin") showDefinition(item);
        else if (window.openFile) window.openFile(item.path);
      };
    });
  }

  function initEcosystemPanel() {
    const refresh = $("#eco-refresh");
    if (refresh) refresh.onclick = loadEcosystem;
    loadEcosystem();
  }

  window.initEcosystemPanel = initEcosystemPanel;
  window.reloadEcosystem = loadEcosystem;
  window.focusEcosystem = () => {
    if (!cache.skills.length && !cache.playbooks.length) loadEcosystem();
  };
})();
