/* Workbench Ecosystem：只读展示本地 Skills / Playbooks，不执行脚本。 */
(function () {
  const $ = (s) => document.querySelector(s);
  let cache = { skills: [], playbooks: [] };
  let ecosystemStatus = "idle"; // idle | loading | ready | error
  let ecosystemError = "";
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
  function recommendedItem(items) {
    if (ecosystemStatus !== "ready") return null;
    return cache.playbooks.find(p => (p.risk || "read") === "write")
      || cache.playbooks[0] || cache.skills[0] || items[0] || null;
  }
  function currentRecommendedItem() {
    return recommendedItem(allItems());
  }
  function ecosystemRecoverySummary() {
    const items = allItems();
    const visible = visibleItems();
    const risks = countBy(items, item => item.risk || "read");
    const sources = countBy(items, item => item.source || "workspace");
    const recommended = recommendedItem(items);
    const preview = recommended ? previewPlan(recommended) : null;
    return {
      skills: cache.skills.length,
      playbooks: cache.playbooks.length,
      visible: visible.length,
      risk: filters.risk,
      source: filters.source,
      status: ecosystemStatus,
      error: ecosystemError,
      risks,
      sources,
      recommended: recommended ? {
        title: recommended.title,
        kind: recommended.kind,
        source: recommended.source || "workspace",
        path: recommended.path || "",
        risk: recommended.risk || "read",
      } : null,
      scope: preview ? preview.scope : "",
      commands: preview ? preview.commands.slice(0, 3) : [],
      verification: preview ? preview.verification.slice(0, 3) : [],
      evidence: preview ? preview.evidence.slice(0, 3) : [],
    };
  }
  function setSelectOptions(sel, options, value) {
    if (!sel) return;
    sel.innerHTML = options.map(opt =>
      `<option value="${esc(opt.value)}"${opt.value === value ? " selected" : ""}>${esc(opt.label)}</option>`).join("");
  }
  function setControlState(el, state, enabledTitle) {
    if (!el) return;
    el.disabled = !state.enabled;
    el.setAttribute("aria-disabled", state.enabled ? "false" : "true");
    el.title = state.enabled ? enabledTitle : (state.reason || "当前不可用");
  }
  function filterControlState(kind) {
    if (ecosystemStatus === "loading") return { enabled: false, reason: "生态入口正在扫描" };
    if (ecosystemStatus === "error" && !allItems().length) {
      return { enabled: false, reason: ecosystemError || "生态入口加载失败" };
    }
    if (!allItems().length) return { enabled: false, reason: "暂无可过滤的生态入口" };
    if (kind === "clear" && filters.risk === "all" && filters.source === "all") {
      return { enabled: false, reason: "当前没有过滤条件" };
    }
    return { enabled: true, reason: "" };
  }
  function refreshFilterControlState() {
    setControlState($("#eco-risk-filter"), filterControlState("risk"), "按风险过滤");
    setControlState($("#eco-source-filter"), filterControlState("source"), "按来源过滤");
    setControlState($("#eco-clear-filter"), filterControlState("clear"), "清除生态过滤");
  }
  function refreshEcosystemActions() {
    setControlState($("#eco-refresh"), ecosystemActionState("refresh"), "刷新生态入口");
    refreshFilterControlState();
  }
  function renderRecovery() {
    const grid = $("#eco-recovery-grid");
    const next = $("#eco-next");
    const riskSel = $("#eco-risk-filter");
    const sourceSel = $("#eco-source-filter");
    const clear = $("#eco-clear-filter");
    if (!grid || !next || !riskSel || !sourceSel) return;
    const summary = ecosystemRecoverySummary();
    const items = allItems();
    const risks = summary.risks;
    const sources = summary.sources;
    const workspace = Array.isArray(window.currentWorkspaceRoots) && window.currentWorkspaceRoots.length > 1
      ? `${window.currentWorkspaceRoots.length} 个目录`
      : (window.currentRoot || "未打开");
    const riskText = ["read", "write", "exec", "network"]
      .filter(k => risks[k])
      .map(k => `${riskInfo(k).label} ${risks[k]}`)
      .join(" · ") || "无";
    const sourceText = Object.keys(sources).sort().map(k => `${k} ${sources[k]}`).join(" · ") || "无";
    const recommended = summary.recommended;
    const statusText = ecosystemStatus === "loading"
      ? "扫描中"
      : ecosystemStatus === "error"
        ? `加载失败: ${ecosystemError || "未知错误"}`
        : ecosystemStatus === "ready"
          ? "已加载"
          : "待加载";
    const cards = [
      ["工作区", workspace],
      ["状态", statusText],
      ["入口", `${cache.playbooks.length} Playbooks · ${cache.skills.length} Skills`],
      ["风险", riskText],
      ["来源", sourceText],
      ["当前过滤", `${summary.visible}/${items.length} 可见`],
      ["推荐", recommended ? recommended.title : "暂无"],
    ];
    if (recommended) {
      cards.push(
        ["推荐路径", recommended.path || "未声明"],
        ["命令预览", summary.commands[0] || "未声明命令；保持手动检查"],
        ["验证项", summary.verification[0] || "未声明验证项"],
        ["证据字段", summary.evidence.join(" · ") || "无"],
        ["作用范围", summary.scope || "未声明"],
      );
    }
    grid.innerHTML = cards.map(([k, v], index) => {
      const wide = index >= 7 ? " wide" : "";
      return `<div class="eco-recovery-card${wide}"><b>${esc(k)}</b><span>${esc(v)}</span></div>`;
    }).join("");
    const riskOptions = [{ value: "all", label: "全部" }]
      .concat(["read", "write", "exec", "network"].filter(k => risks[k]).map(k => ({ value: k, label: riskInfo(k).label })));
    const sourceOptions = [{ value: "all", label: "全部" }]
      .concat(Object.keys(sources).sort().map(k => ({ value: k, label: k })));
    setSelectOptions(riskSel, riskOptions, filters.risk);
    setSelectOptions(sourceSel, sourceOptions, filters.source);
    const hasFilter = filters.risk !== "all" || filters.source !== "all";
    if (clear) clear.classList.toggle("hidden", !hasFilter);
    refreshFilterControlState();
    next.textContent = ecosystemStatus === "loading"
      ? "下一步：等待扫描完成；刷新期间不会使用旧入口创建任务或复制命令。"
      : ecosystemStatus === "error"
        ? `下一步：检查 .workbench 定义或刷新重试。${ecosystemError ? " 错误：" + ecosystemError : ""}`
        : recommended
      ? `下一步：查看 ${recommended.title}，按恢复卡里的验证项手动检查，并把输出/截图/任务日志作为证据记录。`
      : "下一步：在 .workbench/playbooks 或 .workbench/skills 中添加本地流程定义。";
    refreshEcosystemActions();
    renderRecommendedCard();
  }
  function renderRecommendedCard() {
    const host = $("#eco-recommended");
    if (!host) return;
    const recommended = currentRecommendedItem();
    if (!recommended) { host.innerHTML = ""; return; }
    const openState = ecosystemActionState("open", recommended);
    const taskState = ecosystemActionState("task", recommended);
    const copyState = ecosystemActionState("copy", recommended);
    const desc = recommended.description || recommended.summary || "";
    host.innerHTML = `<div class="eco-recommended-card">`
      + `<b>${esc(recommended.title)}</b>`
      + (desc ? `<span>${esc(desc)}</span>` : "")
      + `<div class="eco-recommended-actions">`
      + `<button data-act="open" title="${openState.enabled ? "在编辑器中打开定义" : esc(openState.reason)}"${openState.enabled ? "" : " disabled"}>查看定义</button>`
      + `<button data-act="task" title="${taskState.enabled ? "基于此项创建任务" : esc(taskState.reason)}"${taskState.enabled ? "" : " disabled"}>创建任务</button>`
      + `<button data-act="copy" title="${copyState.enabled ? "复制验证命令到剪贴板" : esc(copyState.reason)}"${copyState.enabled ? "" : " disabled"}>复制验证命令</button>`
      + `</div></div>`;
    host.querySelectorAll("button[data-act]").forEach(btn => {
      btn.onclick = () => {
        if (btn.disabled) return;
        runEcosystemAction(btn.dataset.act, recommended);
      };
    });
  }

  async function loadEcosystem() {
    const list = $("#eco-list");
    const summary = $("#eco-summary");
    if (!list || !summary) return;
    ecosystemStatus = "loading";
    ecosystemError = "";
    cache = { skills: [], playbooks: [] };
    list.innerHTML = `<div class="eco-loading">扫描中…</div>`;
    summary.textContent = "扫描 Skills / Playbooks 中…";
    renderRecovery();
    try {
      const data = await fetch("/api/ecosystem", { cache: "no-store" }).then(r => r.json());
      if (data.error) throw new Error(data.error);
      cache = {
        skills: Array.isArray(data.skills) ? data.skills : [],
        playbooks: Array.isArray(data.playbooks) ? data.playbooks : [],
      };
      ecosystemStatus = "ready";
      ecosystemError = "";
      renderEcosystem();
    } catch (e) {
      ecosystemStatus = "error";
      ecosystemError = e && e.message ? e.message : String(e);
      cache = { skills: [], playbooks: [] };
      list.innerHTML = `<div class="eco-error">生态入口加载失败: ${esc(ecosystemError)}</div>`;
      summary.textContent = "生态入口加载失败";
      renderRecovery();
    }
  }

  function renderItem(item) {
    const actionButton = (action, label, tip) => {
      const st = ecosystemActionState(action, item);
      const disabled = st.enabled ? "" : ` disabled aria-disabled="true"`;
      const t = st.enabled ? (tip || label) : (st.reason || "当前不可用");
      return `<button class="eco-open" data-act="${esc(action)}" title="${esc(t)}"${disabled}>${esc(label)}</button>`;
    };
    const ver = item.verification && item.verification.length
      ? `<div class="eco-lines"><b>验证</b>${item.verification.map(x => `<span>${esc(x)}</span>`).join("")}</div>` : "";
    const inputs = item.inputs && item.inputs.length
      ? `<div class="eco-lines"><b>输入</b>${item.inputs.map(x => `<span>${esc(x)}</span>`).join("")}</div>` : "";
    const req = item.requires && item.requires.length
      ? `<div class="eco-lines compact"><b>要求</b>${item.requires.slice(0, 3).map(x => `<span>${esc(x)}</span>`).join("")}</div>` : "";
    const commands = item.commands && item.commands.length
      ? `<div class="eco-lines compact"><b>命令预览</b>${item.commands.slice(0, 2).map(x => `<span>${esc(x)}</span>`).join("")}</div>` : "";
    const scope = item.scope ? `<div class="eco-scope"><b>范围</b><span>${esc(item.scope)}</span></div>` : "";
    const desc = item.description || item.summary || "未提供说明";
    const risk = riskInfo(item.risk);
    return `<article class="eco-card" data-path="${esc(item.path)}" data-source="${esc(item.source || "workspace")}">
      <div class="eco-card-head">
        <span class="eco-kind">${esc(item.kind)} · ${esc(item.source || "workspace")}</span>
        <span class="eco-risk ${esc(risk.key)}" title="${esc(risk.description)}">${esc(risk.label)}</span>
      </div>
      <h3>${esc(item.title)}</h3>
      <p>${esc(desc)}</p>
      ${scope}${inputs}${req}${commands}${ver}
      <div class="eco-actions">
        ${actionButton("open", item.source === "builtin" ? "查看定义" : "打开定义", "在编辑器中打开定义文件")}
        ${actionButton("preview", "执行预览", "预览执行效果")}
        ${actionButton("copy-preview", "复制预览包", "复制预览内容到剪贴板")}
        ${actionButton("task", "创建任务", "基于此项创建任务")}
        ${actionButton("copy", "复制验证命令", "复制验证命令到剪贴板")}
        ${item.kind === "playbook" ? actionButton("run-step", "▶ 运行步骤", "执行 Playbook 中的代码步骤") : ""}
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

  function ecosystemActionState(action, item) {
    if (action === "refresh") {
      if (ecosystemStatus === "loading") return { enabled: false, reason: "生态入口正在扫描" };
      return { enabled: true, reason: "" };
    }
    if (action === "focusRecovery") return { enabled: true, reason: "" };
    if (ecosystemStatus === "loading") return { enabled: false, reason: "生态入口正在扫描" };
    if (ecosystemStatus === "error") return { enabled: false, reason: ecosystemError || "生态入口加载失败" };
    if (action === "copyRecommendedPreview") {
      if (!currentRecommendedItem()) return { enabled: false, reason: "暂无推荐生态入口" };
      return { enabled: true, reason: "" };
    }
    if (action === "task" && !window.addWorkflowTask) {
      return { enabled: false, reason: "任务面板尚未就绪" };
    }
    if (action === "copy" && item && !(item.verification || []).length) {
      return { enabled: false, reason: "该定义没有验证命令" };
    }
    if (action === "open" && item && item.source !== "builtin" && !window.openFile) {
      return { enabled: false, reason: "文件打开能力尚未就绪" };
    }
    if (action === "run-step" && (!item || item.kind !== "playbook")) {
      return { enabled: false, reason: "仅 Playbook 支持运行步骤" };
    }
    return { enabled: true, reason: "" };
  }

  async function runEcosystemAction(action, item) {
    const st = ecosystemActionState(action, item);
    if (!st.enabled) {
      if (window.setMsg) window.setMsg(st.reason || "当前不可用", "warn");
      return false;
    }
    if (action === "refresh") { await loadEcosystem(); return ecosystemStatus === "ready"; }
    if (action === "focusRecovery") {
      if (typeof switchView === "function") switchView("ecosystem");
      if (!cache.skills.length && !cache.playbooks.length) await loadEcosystem();
      else renderRecovery();
      const panel = $("#eco-recovery");
      if (panel) {
        panel.scrollIntoView({ block: "nearest" });
        panel.classList.add("eco-recovery-pulse");
        setTimeout(() => panel.classList.remove("eco-recovery-pulse"), 900);
      }
      if (window.setMsg) window.setMsg("已打开生态恢复入口", "ok");
      return true;
    }
    if (action === "copyRecommendedPreview") {
      const recommended = currentRecommendedItem();
      if (!recommended) {
        if (window.setMsg) window.setMsg("暂无推荐生态入口", "warn");
        return false;
      }
      await copyText(executionPreviewMarkdown(recommended), "已复制推荐执行预览包", "复制推荐执行预览包：");
      return true;
    }
    if (!item) {
      if (window.setMsg) window.setMsg("未找到生态入口", "warn");
      return false;
    }
    if (action === "open") {
      if (item.source === "builtin") showDefinition(item);
      else window.openFile(item.path);
      return true;
    }
    if (action === "preview") { showExecutionPreview(item); return true; }
    if (action === "copy-preview") {
      await copyText(executionPreviewMarkdown(item), "已复制执行预览包", "复制执行预览包：");
      return true;
    }
    if (action === "task") {
      const plan = stepsFromContent(item);
      const preview = previewPlan(item);
      const firstCmd = preview.commands[0] || "";
      const firstVerify = preview.verification[0] || "";
      const nextHint = firstCmd
        ? `Review execution preview, then run: ${firstCmd}` + (firstVerify ? ` — verify with: ${firstVerify}` : "")
        : "Review the execution preview, then copy commands or run checks manually with evidence logging.";
      await window.addWorkflowTask({
        title: item.title,
        goal: item.summary || item.description || `Run ${item.title}`,
        plan: (plan.length ? plan : []).concat([
          "Review execution preview before running any command manually.",
          ...preview.commands.map(x => `Command preview: ${x}`),
          ...preview.verification.map(x => `Verify: ${x}`),
        ]),
        evidence: [],
        log: [
          `Created from ${item.kind}: ${item.path}`,
          `Risk: ${preview.risk.key}`,
          `Scope: ${preview.scope}`,
          ...preview.requires.map(x => `Requires: ${x}`),
          ...preview.evidence.map(x => `Evidence field: ${x}`),
          ...preview.commands.map(x => `Command preview: ${x}`),
          ...preview.verification.map(x => `Verify: ${x}`),
          "Timeout: manual",
          "Cancel: close terminal / Ctrl+C",
        ],
        next: nextHint,
      });
      return true;
    }
    if (action === "copy") {
      const text = (item.verification || []).join("\n");
      await copyText(text, "已复制验证命令", "复制验证命令：");
      return true;
    }
    if (action === "run-step") {
      const blocks = [];
      const re = /```(?:bash|sh|shell|cmd|powershell)\s+name=(\S+)\s*\n[\s\S]*?```/g;
      let m;
      while ((m = re.exec(item.content || "")) !== null) blocks.push(m[1]);
      if (!blocks.length) { if (window.setMsg) window.setMsg("该 Playbook 没有可执行的命名步骤", "warn"); return false; }
      const stepName = blocks.length === 1
        ? blocks[0]
        : prompt("选择要执行的步骤:\n" + blocks.map((b, i) => `${i + 1}. ${b}`).join("\n") + "\n\n输入步骤名:");
      if (!stepName || !blocks.includes(stepName.trim())) {
        if (stepName !== null && window.setMsg) window.setMsg("无效步骤名", "warn");
        return false;
      }
      if (window.setMsg) window.setMsg(`正在执行步骤 ${stepName}...`, "ok");
      try {
        const resp = await fetch("/api/playbook/run", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: item.path, step: stepName.trim() })
        });
        const data = await resp.json();
        if (data.error) { if (window.setMsg) window.setMsg(data.error, "err"); return false; }
        const msg = data.ok ? `步骤 ${stepName} 成功 (exit ${data.code})` : `步骤 ${stepName} 失败 (exit ${data.code})`;
        if (window.setMsg) window.setMsg(msg, data.ok ? "ok" : "err");
        return data.ok;
      } catch (e) {
        if (window.setMsg) window.setMsg("执行请求失败: " + e.message, "err");
        return false;
      }
    }
    return false;
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

  function previewPlan(item) {
    const risk = riskInfo(item.risk);
    const commands = item.commands && item.commands.length ? item.commands : [];
    const verification = item.verification && item.verification.length ? item.verification : [];
    return {
      risk,
      commands,
      verification,
      scope: item.scope || "未声明；默认仅限当前工作区人工操作。",
      requires: item.requires && item.requires.length ? item.requires : ["人工确认工作区范围", "创建任务或复制命令后手动执行"],
      evidence: [
        "命令输出或浏览器 console 摘要",
        "截图路径或构建产物路径",
        "任务日志 / Project Memory 验证记录",
      ],
    };
  }

  function executionPreviewMarkdown(item) {
    const p = previewPlan(item);
    const lines = [
      `# Execution Preview: ${item.title}`,
      "",
      `- kind: ${item.kind || "playbook"}`,
      `- source: ${item.source || "workspace"}`,
      `- path: ${item.path || ""}`,
      `- risk: ${p.risk.key} (${p.risk.label})`,
      `- scope: ${p.scope}`,
      "",
      "## Safety Boundary",
      "",
      "This preview is informational only. Workbench must not execute these commands until a whitelist, explicit confirmation, timeout/cancel path, output logging, and evidence writeback model exist.",
      "",
      "## Requirements",
      "",
      ...(p.requires.length ? p.requires.map(x => `- ${x}`) : ["- none declared"]),
      "",
      "## Inputs",
      "",
      ...(item.inputs && item.inputs.length ? item.inputs.map(x => `- ${x}`) : ["- none declared"]),
      "",
      "## Commands Preview",
      "",
      ...(p.commands.length ? p.commands.map(x => `- ${x}`) : ["- none declared"]),
      "",
      "## Verification",
      "",
      ...(p.verification.length ? p.verification.map(x => `- ${x}`) : ["- none declared"]),
      "",
      "## Evidence Fields",
      "",
      ...p.evidence.map(x => `- ${x}`),
      "",
      "## Timeout & Cancel",
      "",
      "- Timeout: manual (no auto-execution)",
      "- Cancel: close terminal or Ctrl+C",
      "",
      "## Evidence Schema",
      "",
      "```json",
      "{",
      '  "command_output": "string - stdout/stderr capture",',
      '  "screenshot_path": "string - browser or desktop screenshot",',
      '  "artifact_path": "string - build output or generated file",',
      '  "validation_result": "pass|fail|skip",',
      '  "timestamp": "ISO 8601"',
      "}",
      "```",
    ];
    return lines.join("\n");
  }

  async function copyText(text, okMsg, fallbackTitle) {
    try {
      await navigator.clipboard.writeText(text);
      if (window.setMsg) window.setMsg(okMsg, "ok");
    } catch {
      prompt(fallbackTitle, text);
    }
  }

  function renderPreviewBlock(item) {
    const p = previewPlan(item);
    const list = (title, values, empty) => `<div class="eco-preview-list"><b>${esc(title)}</b>${
      values.length ? values.map(x => `<span>${esc(x)}</span>`).join("") : `<span>${esc(empty)}</span>`
    }</div>`;
    return `<section class="eco-exec-preview">
      <div class="eco-preview-head">
        <span>安全执行预览</span>
        <em class="${esc(p.risk.key)}">${esc(p.risk.label)}</em>
      </div>
      <div class="eco-preview-boundary">当前版本不会直接执行 Playbook / Skill。这里仅展示未来执行前必须确认的命令、范围、风险和证据字段。</div>
      <div class="eco-preview-scope"><b>作用范围</b><span>${esc(p.scope)}</span></div>
      ${list("前置要求", p.requires, "未声明前置要求")}
      ${list("命令预览", p.commands, "未声明命令；只能查看定义、创建任务或复制验证项")}
      ${list("验证项", p.verification, "未声明验证项")}
      ${list("将写入的证据字段", p.evidence, "无")}
      <div class="eco-preview-disabled">执行入口已禁用：需要白名单、确认弹窗、超时/取消、输出日志和证据回写模型后才能开放。</div>
      <button class="eco-preview-copy" data-act="copy-preview">复制执行预览包</button>
    </section>`;
  }

  function showExecutionPreview(item) {
    const ov = document.createElement("div");
    ov.className = "eco-modal";
    ov.innerHTML = `<div class="eco-modal-box eco-preview-modal">
      <div class="eco-modal-head">
        <b>${esc(item.title)} · 执行预览</b>
        <button class="icon-btn" data-act="close">${svgIcon("close", 14)}</button>
      </div>
      <div class="eco-modal-body">
        ${renderPreviewBlock(item)}
      </div>
    </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector("[data-act='close']").onclick = close;
    ov.querySelector("[data-act='copy-preview']").onclick = () =>
      copyText(executionPreviewMarkdown(item), "已复制执行预览包", "复制执行预览包：");
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
    refreshEcosystemActions();
    list.querySelectorAll(".eco-card").forEach(card => {
      card.addEventListener("click", async e => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return;
        const item = findItem(card);
        if (!item) return;
        const act = btn.dataset.act;
        await runEcosystemAction(act, item);
      });
    });
  }

  function initEcosystemPanel() {
    const refresh = $("#eco-refresh");
    if (refresh) refresh.onclick = () => runEcosystemAction("refresh");
    const riskSel = $("#eco-risk-filter");
    if (riskSel) riskSel.onchange = () => { filters.risk = riskSel.value || "all"; renderEcosystem(); };
    const sourceSel = $("#eco-source-filter");
    if (sourceSel) sourceSel.onchange = () => { filters.source = sourceSel.value || "all"; renderEcosystem(); };
    const clear = $("#eco-clear-filter");
    if (clear) clear.onclick = () => {
      const st = filterControlState("clear");
      if (!st.enabled) {
        if (window.setMsg) window.setMsg(st.reason || "当前不可用", "warn");
        refreshFilterControlState();
        return;
      }
      filters.risk = "all";
      filters.source = "all";
      renderEcosystem();
    };
    loadEcosystem();
  }

  window.initEcosystemPanel = initEcosystemPanel;
  window.wbEcosystemActions = {
    actionState: ecosystemActionState,
    run: runEcosystemAction,
    summary: ecosystemRecoverySummary,
  };
  window.reloadEcosystem = loadEcosystem;
  window.focusEcosystem = () => {
    if (!cache.skills.length && !cache.playbooks.length) loadEcosystem();
    else renderRecovery();
  };
})();
