/* Workbench Ecosystem：只读展示本地 Skills / Playbooks，不执行脚本。 */
(function () {
  const $ = (s) => document.querySelector(s);
  let cache = { skills: [], playbooks: [] };
  const filters = { risk: "all", source: "all" };

  const esc = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function riskInfo(risk) {
    if (window.describeWorkbenchRisk) return window.describeWorkbenchRisk(risk);
    return { key: risk || "read", label: risk || "read", description: "" };
  }
  function allItems() {
    return cache.playbooks.concat(cache.skills);
  }
  function visibleItems() {
    return allItems().filter(item => {
      const risk = item.risk || "read";
      const source = item.source || "workspace";
      if (filters.risk !== "all" && risk !== filters.risk) return false;
      if (filters.source !== "all" && source !== filters.source) return false;
      return true;
    });
  }
  function countBy(items, fn) {
    return items.reduce((acc, item) => {
      const key = fn(item);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }
  function setSelectOptions(sel, options, value) {
    if (!sel) return;
    sel.innerHTML = options.map(opt =>
      `<option value="${esc(opt.value)}"${opt.value === value ? " selected" : ""}>${esc(opt.label)}</option>`).join("");
  }
  function renderRecovery() {
    const grid = $("#eco-recovery-grid");
    const next = $("#eco-next");
    const riskSel = $("#eco-risk-filter");
    const sourceSel = $("#eco-source-filter");
    const clear = $("#eco-clear-filter");
    if (!grid || !next || !riskSel || !sourceSel) return;
    const items = allItems();
    const visible = visibleItems();
    const risks = countBy(items, item => item.risk || "read");
    const sources = countBy(items, item => item.source || "workspace");
    const workspace = Array.isArray(window.currentWorkspaceRoots) && window.currentWorkspaceRoots.length > 1
      ? `${window.currentWorkspaceRoots.length} 个目录`
      : (window.currentRoot || "未打开");
    const riskText = ["read", "write", "exec", "network"]
      .filter(k => risks[k])
      .map(k => `${riskInfo(k).label} ${risks[k]}`)
      .join(" · ") || "无";
    const sourceText = Object.keys(sources).sort().map(k => `${k} ${sources[k]}`).join(" · ") || "无";
    const recommended = cache.playbooks.find(p => (p.risk || "read") === "write")
      || cache.playbooks[0] || cache.skills[0] || null;
    grid.innerHTML = [
      ["工作区", workspace],
      ["入口", `${cache.playbooks.length} Playbooks · ${cache.skills.length} Skills`],
      ["风险", riskText],
      ["来源", sourceText],
      ["当前过滤", `${visible.length}/${items.length} 可见`],
      ["推荐", recommended ? recommended.title : "暂无"],
    ].map(([k, v]) => `<div class="eco-recovery-card"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join("");
    const riskOptions = [{ value: "all", label: "全部" }]
      .concat(["read", "write", "exec", "network"].filter(k => risks[k]).map(k => ({ value: k, label: riskInfo(k).label })));
    const sourceOptions = [{ value: "all", label: "全部" }]
      .concat(Object.keys(sources).sort().map(k => ({ value: k, label: k })));
    setSelectOptions(riskSel, riskOptions, filters.risk);
    setSelectOptions(sourceSel, sourceOptions, filters.source);
    const hasFilter = filters.risk !== "all" || filters.source !== "all";
    if (clear) clear.classList.toggle("hidden", !hasFilter);
    next.textContent = recommended
      ? `下一步：查看 ${recommended.title}，或创建任务记录验证过程。`
      : "下一步：在 .workbench/playbooks 或 .workbench/skills 中添加本地流程定义。";
  }

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
    const risk = riskInfo(item.risk);
    return `<article class="eco-card" data-path="${esc(item.path)}" data-source="${esc(item.source || "workspace")}">
      <div class="eco-card-head">
        <span class="eco-kind">${esc(item.kind)} · ${esc(item.source || "workspace")}</span>
        <span class="eco-risk ${esc(risk.key)}" title="${esc(risk.description)}">${esc(risk.label)}</span>
      </div>
      <h3>${esc(item.title)}</h3>
      <p>${esc(desc)}</p>
      ${inputs}${ver}
      <div class="eco-actions">
        <button class="eco-open" data-act="open">${item.source === "builtin" ? "查看定义" : "打开定义"}</button>
        <button class="eco-open" data-act="task">创建任务</button>
        <button class="eco-open" data-act="copy">复制验证命令</button>
      </div>
    </article>`;
  }

  function stepsFromContent(item) {
    const lines = String(item.content || "").split(/\r?\n/);
    const steps = [];
    let inSteps = false;
    for (const line of lines) {
      const s = line.trim();
      if (/^##\s+Steps/i.test(s)) { inSteps = true; continue; }
      if (inSteps && /^##\s+/.test(s)) break;
      const m = s.match(/^\d+\.\s+(.+)/);
      if (inSteps && m) steps.push(m[1].trim());
    }
    return steps;
  }

  function findItem(card) {
    return allItems().find(x => x.path === card.dataset.path && (x.source || "workspace") === card.dataset.source);
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
    renderRecovery();
    const shown = visibleItems();
    const shownPlaybooks = shown.filter(x => x.kind === "playbook");
    const shownSkills = shown.filter(x => x.kind === "skill");
    summary.textContent = `${shownPlaybooks.length}/${cache.playbooks.length} playbooks · ${shownSkills.length}/${cache.skills.length} skills`;
    const parts = [];
    parts.push(`<div class="eco-safety">安全边界：当前只支持查看定义、创建任务和复制验证命令；不会直接执行 Playbook / Skill 脚本。</div>`);
    if (shownPlaybooks.length) {
      parts.push(`<div class="eco-group-title">Playbooks</div>`);
      parts.push(shownPlaybooks.map(renderItem).join(""));
    }
    if (shownSkills.length) {
      parts.push(`<div class="eco-group-title">Skills</div>`);
      parts.push(shownSkills.map(renderItem).join(""));
    }
    if (!shown.length) {
      parts.push(`<div class="eco-empty">${allItems().length ? "当前过滤没有匹配入口。" : "未发现本地 Skills / Playbooks。可在 <code>.workbench/playbooks</code> 放置 Markdown playbook。"}</div>`);
    }
    list.innerHTML = parts.join("");
    list.querySelectorAll(".eco-card").forEach(card => {
      card.addEventListener("click", async e => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        const item = findItem(card);
        if (!item) return;
        const act = btn.dataset.act;
        if (act === "open") {
          if (item.source === "builtin") showDefinition(item);
          else if (window.openFile) window.openFile(item.path);
        } else if (act === "task") {
          const plan = stepsFromContent(item);
          if (window.addWorkflowTask) {
            await window.addWorkflowTask({
              title: item.title,
              goal: item.summary || item.description || `Run ${item.title}`,
              plan: plan.length ? plan : (item.verification || []),
              evidence: [],
              log: [`Created from ${item.kind}: ${item.path}`],
              next: item.verification && item.verification.length ? "Run or copy verification commands manually." : "",
            });
          }
        } else if (act === "copy") {
          const text = (item.verification || []).join("\n");
          if (!text) {
            if (window.setMsg) window.setMsg("该定义没有验证命令", "warn");
            return;
          }
          try {
            await navigator.clipboard.writeText(text);
            if (window.setMsg) window.setMsg("已复制验证命令", "ok");
          } catch {
            prompt("复制验证命令：", text);
          }
        }
      });
    });
  }

  function initEcosystemPanel() {
    const refresh = $("#eco-refresh");
    if (refresh) refresh.onclick = loadEcosystem;
    const riskSel = $("#eco-risk-filter");
    if (riskSel) riskSel.onchange = () => { filters.risk = riskSel.value || "all"; renderEcosystem(); };
    const sourceSel = $("#eco-source-filter");
    if (sourceSel) sourceSel.onchange = () => { filters.source = sourceSel.value || "all"; renderEcosystem(); };
    const clear = $("#eco-clear-filter");
    if (clear) clear.onclick = () => {
      filters.risk = "all";
      filters.source = "all";
      renderEcosystem();
    };
    loadEcosystem();
  }

  window.initEcosystemPanel = initEcosystemPanel;
  window.reloadEcosystem = loadEcosystem;
  window.focusEcosystem = () => {
    if (!cache.skills.length && !cache.playbooks.length) loadEcosystem();
    else renderRecovery();
  };
})();
