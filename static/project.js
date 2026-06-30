/* Workbench 项目记忆面板：读取 state/*.md，作为生态化 Phase 1 的可视入口。 */
(function () {
  const DOCS = [
    { name: "requirements", label: "Requirements" },
    { name: "progress", label: "Progress" },
    { name: "log", label: "Log" },
    { name: "memory", label: "Memory" },
    { name: "roadmap", label: "Roadmap", readonly: true },
  ];
  let docs = [];
  let active = "progress";
  let latestRecordTarget = "progress";
  let roadmap = null;
  let projectLoaded = false;
  let projectRefreshing = false;

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
    projectRefreshing = true;
    refreshProjectRefreshButton();
    doc.textContent = "加载中…";
    try {
      const data = await fetch("/api/project-state", { cache: "no-store" }).then(r => r.json());
      if (data.error) throw new Error(data.error);
      docs = Array.isArray(data.files) ? data.files : [];
      try {
        const road = await fetch("/api/project-roadmap", { cache: "no-store" }).then(r => r.json());
        roadmap = road && !road.error ? road : null;
      } catch {
        roadmap = null;
      }
      renderRecovery();
      renderTabs();
      renderDoc();
    } catch (e) {
      doc.textContent = "项目记忆加载失败: " + (e && e.message ? e.message : e);
    } finally {
      projectLoaded = true;
      projectRefreshing = false;
      refreshProjectRefreshButton();
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
        refreshProjectActions();
      };
    });
  }

  function lineCount(text) {
    return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
  }
  function docByName(name) {
    if (name === "roadmap") return roadmap;
    return docs.find(x => x.name === name) || null;
  }
  function hasWorkspace() {
    return typeof window.hasOpenWorkspace === "function" ? window.hasOpenWorkspace() : !!window.currentRoot;
  }
  function projectActionState(action, name) {
    const key = name || active;
    if (action === "focusRecovery") {
      return { enabled: true, reason: "" };
    }
    if (action === "refresh") {
      if (!hasWorkspace()) return { enabled: false, reason: "请先打开工作区" };
      if (projectRefreshing) return { enabled: false, reason: "项目记忆正在刷新" };
      return { enabled: true, reason: "" };
    }
    if ((action === "edit" || action === "append") && !hasWorkspace()) {
      return { enabled: false, reason: "请先打开工作区" };
    }
    if (action === "copyRoadmap" && !roadmap) {
      if (!projectLoaded) return { enabled: true, reason: "" };
      return { enabled: false, reason: "路线文档尚未加载" };
    }
    if (action === "open" || action === "edit") {
      if (!DOCS.some(d => d.name === key)) return { enabled: false, reason: "未知的项目记忆文档" };
    }
    return { enabled: true, reason: "" };
  }
  function setProjectButtonState(el, state, enabledTitle) {
    if (!el) return;
    el.disabled = !state.enabled;
    el.setAttribute("aria-disabled", state.enabled ? "false" : "true");
    el.title = state.enabled ? enabledTitle : (state.reason || "当前不可用");
  }
  function taskActionState(action, fallback) {
    return window.wbTaskActions && window.wbTaskActions.actionState
      ? window.wbTaskActions.actionState(action)
      : { enabled: false, reason: fallback || "任务面板尚未就绪" };
  }
  function refreshProjectRefreshButton() {
    setProjectButtonState($("#project-refresh"), projectActionState("refresh"), "刷新项目记忆");
  }
  function refreshProjectActions() {
    refreshProjectRefreshButton();
    setProjectButtonState(
      $("#project-open-source"),
      projectActionState("edit", active),
      active === "roadmap" ? "查看只读路线" : "打开当前记忆文件"
    );
    setProjectButtonState($("#project-add-decision"), projectActionState("append", "decision"), "追加决策记录");
    setProjectButtonState($("#project-add-validation"), projectActionState("append", "validation"), "追加验证记录");
    const copyRoadmap = $("#project-latest [data-act='copy-roadmap']");
    if (copyRoadmap) setProjectButtonState(copyRoadmap, projectActionState("copyRoadmap"), "复制路线");
  }
  function roadmapSummary() {
    const item = docByName("roadmap");
    const text = String(item && item.content || "");
    const m = text.match(/## 下一阶段工作包\s+([\s\S]*?)(?:\n## |\s*$)/);
    const scope = m ? m[1] : text;
    const goals = [];
    for (const line of scope.split("\n")) {
      const s = line.trim();
      if (/^###\s+Work Package/.test(s)) goals.push(s.replace(/^###\s+/, ""));
      if (goals.length >= 3) break;
    }
    return {
      ready: !!text,
      count: goals.length,
      goals,
      summary: goals.length ? goals.join(" · ") : "路线文档暂不可用",
    };
  }
  function workspaceSummary() {
    const api = window.wbWorkspaceLayoutActions;
    if (api && api.summary) {
      try {
        const summary = api.summary();
        return {
          roots: summary.roots || [],
          activeFile: summary.activeFile || null,
          activeGroup: summary.activeGroup || "main",
          main: { tabs: new Array(summary.mainTabs || 0).fill(null) },
          side: { tabs: new Array(summary.sideTabs || 0).fill(null) },
          ui: { sidebarCollapsed: !!summary.sidebarCollapsed },
        };
      } catch {}
    }
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
  function extractRecentValidation() {
    const item = docByName("progress");
    if (!item || !item.content) return null;
    const lines = String(item.content).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!/^##\s+Loop Record\b/i.test(line) && !/^##\s+Validation\b/i.test(line)) continue;
      const block = lines.slice(i, i + 18);
      const goal = block.find(x => /^\s*-\s*Goal\s*:/i.test(x));
      const evidence = block.find(x => /^\s*-\s*Validation Evidence\s*:/i.test(x));
      const next = block.find(x => /^\s*-\s*Next Goal\s*:/i.test(x));
      return {
        target: "progress",
        title: line.replace(/^#+\s*/, ""),
        goal: goal ? goal.replace(/^\s*-\s*Goal\s*:\s*/i, "").trim() : "",
        evidence: evidence ? evidence.replace(/^\s*-\s*Validation Evidence\s*:\s*/i, "").trim() : "",
        next: next ? next.replace(/^\s*-\s*Next Goal\s*:\s*/i, "").trim() : "",
      };
    }
    return null;
  }
  function recentValidationTaskSeed(record) {
    const snap = workspaceSummary();
    const roots = snap && snap.roots && snap.roots.length ? snap.roots : [];
    const activeFile = snap && snap.activeFile ? snap.activeFile : "none";
    return {
      title: `验证恢复: ${record.title}`,
      goal: record.next || record.goal || "从最近 Project Memory 验证记录恢复下一轮工作，并形成新的验证闭环。",
      plan: [
        "打开 Project Memory / Progress 查看最近验证证据",
        "确认上一轮遗留的 Next Goal 或风险",
        "实施一个单一范围的修复或恢复性增强",
        "运行语法检查、针对性 smoke、diff 检查和安装包构建",
        "把验证证据写回 Project Memory 并准备原子提交",
      ],
      evidence: record.evidence ? [record.evidence] : [],
      log: [
        "Created from Project Memory recent validation card",
        `Validation record: ${record.title}`,
        `Workspace: ${window.currentWorkspaceId || window.currentRoot || "unknown"}`,
        `Active file: ${activeFile}`,
        ...roots.map((r, i) => `Root[${i}]: ${r}`),
      ],
      next: record.next || "Continue from the latest validation evidence.",
    };
  }
  async function createTaskFromRecentValidation(record) {
    if (!record) {
      if (window.setMsg) setMsg("暂无可创建任务的验证记录", "warn");
      return false;
    }
    if (!window.addWorkflowTask) {
      if (window.setMsg) setMsg("任务面板尚未就绪", "warn");
      return false;
    }
    const task = await window.addWorkflowTask(recentValidationTaskSeed(record));
    if (task && window.setMsg) setMsg("已从最近验证创建任务", "ok");
    return !!task;
  }
  function copyTasksRecoveryBrief() {
    const api = window.wbTaskActions;
    if (!api || !api.run) {
      if (window.setMsg) setMsg("任务恢复 brief 尚未就绪", "warn");
      return false;
    }
    return api.run("copyRecoveryBrief");
  }
  function copySessionRecoveryPackage() {
    const api = window.wbTaskActions;
    if (!api || !api.run) {
      if (window.setMsg) setMsg("Session 恢复包尚未就绪", "warn");
      return false;
    }
    return api.run("copySessionRecovery");
  }
  function focusTasksRecovery() {
    const api = window.wbTaskActions;
    if (!api || !api.run) {
      if (window.setMsg) setMsg("任务恢复中心尚未就绪", "warn");
      return false;
    }
    return api.run("focusRecovery");
  }
  function ecosystemRecoverySummary() {
    const api = window.wbEcosystemActions;
    if (api && api.summary) {
      try { return api.summary(); } catch {}
    }
    return null;
  }
  function ecosystemActionState(action, fallback) {
    const api = window.wbEcosystemActions;
    return api && api.actionState
      ? api.actionState(action)
      : { enabled: false, reason: fallback || "生态入口尚未就绪" };
  }
  function focusEcosystemRecovery() {
    const api = window.wbEcosystemActions;
    if (!api || !api.run) {
      if (window.setMsg) setMsg("生态入口尚未就绪", "warn");
      return false;
    }
    return api.run("focusRecovery");
  }
  function copyRecommendedEcosystemPreview() {
    const api = window.wbEcosystemActions;
    if (!api || !api.run) {
      if (window.setMsg) setMsg("生态入口尚未就绪", "warn");
      return false;
    }
    return api.run("copyRecommendedPreview");
  }
  function taskRecoverySummary() {
    if (window.getWorkflowRecoverySummary) {
      try { return window.getWorkflowRecoverySummary(); } catch {}
    }
    const api = window.wbTaskActions;
    if (api && api.summary) {
      try {
        const s = api.summary();
        return s && s.recovery ? s.recovery : s;
      } catch {}
    }
    return null;
  }
  function renderTaskContinuity() {
    const host = $("#project-task-continuity");
    if (!host) return;
    const summary = taskRecoverySummary();
    const ready = !!summary && (summary.tasksLoaded || summary.sessionsLoaded);
    const latestTask = summary && summary.latestTask;
    const latestSession = summary && summary.latestSession;
    const counts = summary && summary.counts || {};
    const filter = summary && summary.filters
      ? `过滤 ${summary.filters.status || "all"} / ${summary.filters.source || "all"}`
      : "过滤未加载";
    const taskLine = latestTask
      ? `${latestTask.title} · ${latestTask.next || "打开任务继续补证据"}`
      : "暂无任务，可从最近验证、当前文件、Git 或 Playbook 创建";
    const evidenceLine = latestTask && latestTask.latestEvidence
      ? `${latestTask.evidence || 0} 条证据 · ${latestTask.latestEvidence}`
      : "暂无任务证据，继续运行验证并挂到任务";
    const logLine = latestTask && latestTask.latestLog
      ? `最近日志 · ${latestTask.latestLog}`
      : "";
    const sessionLine = latestSession
      ? `${latestSession.title} · ${latestSession.status || "draft"}`
      : "暂无会话，可从任务卡创建 Agent brief";
    const sessionOutputLine = latestSession && latestSession.latestOutput
      ? `${latestSession.outputs || 0} 条输出 · ${latestSession.latestOutput}`
      : "";
    const sessionEvidenceLine = latestSession && latestSession.latestEvidence
      ? `${latestSession.evidence || 0} 条会话证据 · ${latestSession.latestEvidence}`
      : "";
    const sessionLogLine = latestSession && latestSession.latestLog
      ? `会话日志 · ${latestSession.latestLog}`
      : "";
    const layout = latestSession && latestSession.layout;
    const sessionLayoutLine = layout
      ? [
        layout.workspace ? `工作区 ${layout.workspace}` : "",
        layout.file ? `文件 ${layout.file}` : "",
        layout.group ? `焦点 ${layout.group}` : "",
        layout.tabs ? `标签 ${layout.tabs}` : "",
        layout.sideOrient ? `分屏 ${layout.sideOrient}` : "",
      ].filter(Boolean).join(" · ")
      : "";
    const copyState = taskActionState("copyRecoveryBrief", "任务恢复 brief 尚未就绪");
    const sessionCopyState = taskActionState("copySessionRecovery", "Session 恢复包尚未就绪");
    const focusTasksState = taskActionState("focusRecovery", "任务恢复中心尚未就绪");
    host.innerHTML = `<div class="project-continuity-head"><b>任务连续性</b>`
      + `<span>${ready ? `${summary.tasks || 0} tasks · ${summary.sessions || 0} sessions` : "任务面板加载中"}</span></div>`
      + `<div class="project-continuity-grid">`
      + `<span><b>状态</b>待办 ${counts.todo || 0} · 进行 ${counts.running || 0} · 已验 ${counts.verified || 0}</span>`
      + `<span><b>视图</b>${esc(filter)} · ${ready ? `${summary.visible || 0} 可见` : "待同步"}</span>`
      + `</div>`
      + `<button data-act="open-tasks"${focusTasksState.enabled ? "" : ` disabled title="${esc(focusTasksState.reason || "当前不可用")}"`}>${esc(latestTask ? latestTask.title : "打开 Tasks 面板")}</button>`
      + `<span>${esc(taskLine)}</span>`
      + `<span class="project-continuity-evidence">${esc(evidenceLine)}</span>`
      + (logLine ? `<span class="project-continuity-log">${esc(logLine)}</span>` : "")
      + `<em>${esc(sessionLine)}</em>`
      + (sessionLayoutLine ? `<span class="project-continuity-layout">${esc(sessionLayoutLine)}</span>` : "")
      + (sessionOutputLine ? `<span class="project-continuity-session">${esc(sessionOutputLine)}</span>` : "")
      + (sessionEvidenceLine ? `<span class="project-continuity-session">${esc(sessionEvidenceLine)}</span>` : "")
      + (sessionLogLine ? `<span class="project-continuity-log">${esc(sessionLogLine)}</span>` : "")
      + `<button class="project-validation-task" data-act="copy-recovery"${copyState.enabled ? "" : ` disabled title="${esc(copyState.reason || "当前不可用")}"`}>复制完整恢复 brief</button>`
      + `<button class="project-validation-task" data-act="copy-session-recovery"${sessionCopyState.enabled ? "" : ` disabled title="${esc(sessionCopyState.reason || "当前不可用")}"`}>复制 Session 恢复包</button>`;
    const open = host.querySelector("[data-act='open-tasks']");
    if (open) {
      setProjectButtonState(open, focusTasksState, "打开 Tasks 恢复中心");
      open.onclick = focusTasksRecovery;
    }
    const copy = host.querySelector("[data-act='copy-recovery']");
    if (copy) {
      setProjectButtonState(copy, copyState, "复制完整恢复 brief");
      copy.onclick = copyTasksRecoveryBrief;
    }
    const copySession = host.querySelector("[data-act='copy-session-recovery']");
    if (copySession) {
      setProjectButtonState(copySession, sessionCopyState, "复制 Session 恢复包");
      copySession.onclick = copySessionRecoveryPackage;
    }
  }
  function renderEcosystemContinuity() {
    const host = $("#project-ecosystem-continuity");
    if (!host) return;
    const summary = ecosystemRecoverySummary();
    const focusState = ecosystemActionState("focusRecovery", "生态入口尚未就绪");
    const copyPreviewState = ecosystemActionState("copyRecommendedPreview", "生态入口尚未就绪");
    const recommended = summary && summary.recommended;
    const status = summary
      ? summary.status === "ready"
        ? `${summary.playbooks || 0} playbooks · ${summary.skills || 0} skills`
        : summary.status === "loading"
          ? "生态入口扫描中"
          : summary.status === "error"
            ? `加载失败 · ${summary.error || "未知错误"}`
            : "生态入口待加载"
      : "生态入口尚未就绪";
    const riskText = summary && summary.risks
      ? Object.keys(summary.risks).sort().map(k => `${k} ${summary.risks[k]}`).join(" · ") || "无"
      : "无";
    const sourceText = summary && summary.sources
      ? Object.keys(summary.sources).sort().map(k => `${k} ${summary.sources[k]}`).join(" · ") || "无"
      : "无";
    const targetLine = recommended
      ? `${recommended.title} · ${recommended.kind || "entry"} · ${recommended.source || "workspace"}`
      : "暂无推荐入口；可在 .workbench/playbooks 或 .workbench/skills 添加本地定义";
    const verifyLine = summary && summary.verification && summary.verification.length
      ? summary.verification[0]
      : "暂无验证项；打开 Skills / Playbooks 查看定义或补充 verification";
    const commandLine = summary && summary.commands && summary.commands.length
      ? summary.commands[0]
      : "暂无命令预览；保持手动检查和任务证据记录";
    const evidenceLine = summary && summary.evidence && summary.evidence.length
      ? summary.evidence.join(" · ")
      : "暂无证据字段";
    host.innerHTML = `<div class="project-continuity-head"><b>本地生态</b><span>${esc(status)}</span></div>`
      + `<div class="project-continuity-grid">`
      + `<span><b>风险</b>${esc(riskText)}</span>`
      + `<span><b>来源</b>${esc(sourceText)}</span>`
      + `</div>`
      + `<button data-act="open-ecosystem"${focusState.enabled ? "" : ` disabled title="${esc(focusState.reason || "当前不可用")}"`}>${esc(recommended ? recommended.title : "打开 Skills / Playbooks")}</button>`
      + `<span>${esc(targetLine)}</span>`
      + `<span class="project-continuity-session">${esc(verifyLine)}</span>`
      + `<span class="project-continuity-log">${esc(commandLine)}</span>`
      + `<span class="project-continuity-evidence">${esc(evidenceLine)}</span>`
      + `<button class="project-validation-task" data-act="copy-ecosystem-preview"${copyPreviewState.enabled ? "" : ` disabled title="${esc(copyPreviewState.reason || "当前不可用")}"`}>复制推荐预览包</button>`;
    const open = host.querySelector("[data-act='open-ecosystem']");
    if (open) {
      setProjectButtonState(open, focusState, "打开 Skills / Playbooks 恢复入口");
      open.onclick = focusEcosystemRecovery;
    }
    const copyPreview = host.querySelector("[data-act='copy-ecosystem-preview']");
    if (copyPreview) {
      setProjectButtonState(copyPreview, copyPreviewState, "复制推荐执行预览包");
      copyPreview.onclick = copyRecommendedEcosystemPreview;
    }
  }
  function renderRecoveryActions() {
    const host = $("#project-recovery-actions");
    if (!host) return;
    const latestTask = taskRecoverySummary();
    const lt = latestTask && latestTask.latestTask;
    const recentVal = extractRecentValidation();
    const road = roadmapSummary();
    const focusState = taskActionState("focusRecovery", "任务恢复中心尚未就绪");
    const valTitle = recentVal ? recentVal.title : "暂无验证记录";
    const roadTitle = road.ready && road.goals[0] ? road.goals[0] : "路线文档暂不可用";
    host.innerHTML = `<button class="project-recovery-action" data-act="continue-task"${focusState.enabled ? "" : ` disabled title="${esc(focusState.reason)}"`}>`
      + `<b>继续上次任务</b><span>${esc(lt ? lt.title : "暂无进行中任务")}</span></button>`
      + `<button class="project-recovery-action" data-act="view-validation"><b>查看最近验证</b>`
      + `<span>${esc(valTitle)}</span></button>`
      + `<button class="project-recovery-action" data-act="open-roadmap"${road.ready ? "" : ` disabled title="路线文档暂不可用"`}>`
      + `<b>打开路线图</b><span>${esc(roadTitle)}</span></button>`;
    const cont = host.querySelector("[data-act='continue-task']");
    if (cont) cont.onclick = focusTasksRecovery;
    const val = host.querySelector("[data-act='view-validation']");
    if (val) val.onclick = () => {
      const panel = $("#project-validation");
      if (panel) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    const roadBtn = host.querySelector("[data-act='open-roadmap']");
    if (roadBtn) roadBtn.onclick = () => setProjectDoc("roadmap");
  }
  function renderRecovery() {
    const grid = $("#project-recovery-grid");
    const latest = $("#project-latest");
    const validation = $("#project-validation");
    const openLatest = $("#project-open-latest");
    if (!grid || !latest) return;
    const snap = workspaceSummary();
    const roots = snap && snap.roots ? snap.roots : [];
    const stateDocs = DOCS.filter(d => !d.readonly);
    const present = docs.filter(d => d.exists || d.content).length;
    const records = recentRecords();
    const top = records[0] || null;
    const road = roadmapSummary();
    latestRecordTarget = top ? top.target : active;
    const mainTabs = snap && snap.main && snap.main.tabs ? snap.main.tabs.length : 0;
    const sideTabs = snap && snap.side && snap.side.tabs ? snap.side.tabs.length : 0;
    grid.innerHTML = [
      ["工作区", roots.length > 1 ? `${roots.length} 个目录` : (window.currentRoot || "未打开")],
      ["当前文件", snap && snap.activeFile ? snap.activeFile : "none"],
      ["布局", `主 ${mainTabs} / 侧 ${sideTabs}`],
      ["记忆文件", `${present}/${stateDocs.length} 已就绪`],
      ["Progress", docByName("progress") ? `${lineCount(docByName("progress").content)} 行` : "未创建"],
      ["Log", docByName("log") ? `${lineCount(docByName("log").content)} 行` : "未创建"],
      ["路线", road.ready ? `${road.count || 0} 个工作包` : "未打包"],
    ].map(([k, v]) => `<div class="project-recovery-card"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join("");
    latest.innerHTML = top
      ? `<b>最近记录</b><button data-target="${esc(top.target)}">${esc(top.title)}</button><span>${esc(top.preview || "无预览")}</span>`
      : "<b>最近记录</b><span>暂无可恢复记录。可以追加验证或决策记录。</span>";
    const recentValidation = extractRecentValidation();
    const validationTaskState = window.addWorkflowTask
      ? { enabled: true, reason: "" }
      : { enabled: false, reason: "任务面板尚未就绪" };
    if (validation) {
      const recoveryCopyState = taskActionState("copyRecoveryBrief", "任务恢复 brief 尚未就绪");
      validation.innerHTML = recentValidation
        ? `<b>最近验证</b><button data-target="progress">${esc(recentValidation.title)}</button>`
          + `<span>${esc(recentValidation.evidence || recentValidation.goal || "暂无验证摘要")}</span>`
          + (recentValidation.next ? `<em>${esc(recentValidation.next)}</em>` : "")
          + `<button class="project-validation-task" data-act="validation-task"${validationTaskState.enabled ? "" : ` disabled title="${esc(validationTaskState.reason)}"`}>从验证创建任务</button>`
          + `<button class="project-validation-task" data-act="copy-task-recovery"${recoveryCopyState.enabled ? "" : ` disabled title="${esc(recoveryCopyState.reason || "当前不可用")}"`}>复制任务恢复 brief</button>`
        : "<b>最近验证</b><span>暂无验证记录。运行检查后可追加验证记录。</span>";
    }
    if (road.ready) {
      latest.innerHTML += `<div class="project-roadmap-brief"><b>下一阶段路线</b>`
        + `<button data-target="roadmap">${esc(road.goals[0] || "查看路线")}</button>`
        + `<span>${esc(road.summary)}</span>`
        + `<button class="project-copy-roadmap" data-act="copy-roadmap">复制路线</button></div>`;
    }
    latest.querySelectorAll("button[data-target]").forEach(b => {
      b.onclick = () => setProjectDoc(b.dataset.target);
    });
    if (validation) {
      validation.querySelectorAll("button[data-target]").forEach(b => {
        b.onclick = () => setProjectDoc(b.dataset.target);
      });
      const taskBtn = validation.querySelector("[data-act='validation-task']");
      if (taskBtn) {
        setProjectButtonState(taskBtn, validationTaskState, "从验证创建任务");
        taskBtn.onclick = () => createTaskFromRecentValidation(recentValidation);
      }
      const copyTaskBrief = validation.querySelector("[data-act='copy-task-recovery']");
      if (copyTaskBrief) {
        setProjectButtonState(copyTaskBrief, taskActionState("copyRecoveryBrief", "任务恢复 brief 尚未就绪"), "复制任务恢复 brief");
        copyTaskBrief.onclick = copyTasksRecoveryBrief;
      }
    }
    renderTaskContinuity();
    renderEcosystemContinuity();
    renderRecoveryActions();
    const copyRoadmap = latest.querySelector("[data-act='copy-roadmap']");
    if (copyRoadmap) {
      copyRoadmap.onclick = copyRoadmapBrief;
      setProjectButtonState(copyRoadmap, projectActionState("copyRoadmap"), "复制路线");
    }
    if (openLatest) {
      setProjectButtonState(
        openLatest,
        { enabled: !!top, reason: top ? "" : "暂无最近记录" },
        "打开最近记录来源"
      );
      openLatest.onclick = () => {
        if (latestRecordTarget) setProjectDoc(latestRecordTarget);
      };
    }
  }

  function renderDoc() {
    const meta = $("#project-meta");
    const doc = $("#project-doc");
    const openSource = $("#project-open-source");
    if (!doc) return;
    const item = docByName(active) || docs[0];
    if (!item) {
      if (meta) meta.textContent = "未找到 state 文件";
      if (openSource) {
        openSource.disabled = true;
        openSource.title = "未找到可打开的项目资料";
      }
      doc.textContent = "";
      return;
    }
    if (meta) {
      const stamp = item.mtime ? new Date(item.mtime * 1000).toLocaleString() : "未创建";
      meta.textContent = `${item.file}${item.readonly ? " · 只读路线" : ""} · ${stamp}`;
    }
    if (openSource) {
      setProjectButtonState(
        openSource,
        projectActionState("edit", active),
        item.readonly ? "路线为只读资料，可在此处查看或复制" : "打开当前记忆文件"
      );
    }
    renderRecovery();
    refreshProjectActions();
    doc.textContent = item.content || "（空）";
  }

  function setProjectDoc(name) {
    const st = projectActionState("open", name);
    if (!st.enabled) {
      if (window.setMsg) setMsg(st.reason || "当前不可用", "warn");
      return false;
    }
    active = name;
    renderTabs();
    renderDoc();
    return true;
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
    const st = projectActionState("append", kind);
    if (!st.enabled) {
      if (window.setMsg) setMsg(st.reason || "当前不可用", "warn");
      return false;
    }
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
    const st = projectActionState("edit", key);
    if (!st.enabled) {
      if (window.setMsg) setMsg(st.reason || "当前不可用", "warn");
      return false;
    }
    if (key === "roadmap") {
      setProjectDoc("roadmap");
      if (window.setMsg) setMsg("路线文档为只读，可复制后用于任务规划", "warn");
      return;
    }
    if (!DOCS.some(d => d.name === key)) return;
    active = key;
    renderTabs();
    if (typeof switchView === "function") switchView("files");
    if (window.openFile) window.openFile("project://" + key);
    return true;
  }

  async function copyRoadmapBrief() {
    const item = docByName("roadmap");
    const text = item && item.content ? item.content : "";
    if (!text) {
      if (window.setMsg) setMsg("路线文档暂不可用", "warn");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      if (window.setMsg) setMsg("已复制下一阶段路线", "ok");
    } catch {
      prompt("复制下面的路线：", text);
    }
  }

  function initProjectMemory() {
    const refresh = $("#project-refresh");
    if (refresh) refresh.onclick = () => {
      const st = projectActionState("refresh");
      if (!st.enabled) {
        if (window.setMsg) setMsg(st.reason || "当前不可用", "warn");
        refreshProjectRefreshButton();
        return;
      }
      loadProjectState();
    };
    const openSource = $("#project-open-source");
    if (openSource) openSource.onclick = () => openProjectStateFile(active);
    const decision = $("#project-add-decision");
    if (decision) decision.onclick = () => appendProjectRecord("decision");
    const validation = $("#project-add-validation");
    if (validation) validation.onclick = () => appendProjectRecord("validation");
    renderTabs();
    refreshProjectActions();
    loadProjectState();
  }

  window.initProjectMemory = initProjectMemory;
  window.wbProjectActions = {
    actionState: projectActionState,
    run: async (action, name) => {
      if (action === "refresh") {
        const st = projectActionState("refresh");
        if (!st.enabled) {
          if (window.setMsg) setMsg(st.reason || "当前不可用", "warn");
          refreshProjectRefreshButton();
          return false;
        }
        await loadProjectState();
        if (window.setMsg) setMsg("项目记忆已刷新", "ok");
        return true;
      }
      if (!docs.length || action === "focusRecovery" || (action === "copyRoadmap" && !roadmap)) await loadProjectState();
      const st = projectActionState(action, name);
      if (!st.enabled) {
        if (window.setMsg) setMsg(st.reason || "当前不可用", "warn");
        return false;
      }
      if (action === "focusRecovery") {
        if (typeof switchView === "function") switchView("project");
        renderRecovery();
        const panel = $("#project-recovery");
        if (panel) {
          panel.scrollIntoView({ block: "nearest" });
          panel.classList.add("project-recovery-pulse");
          setTimeout(() => panel.classList.remove("project-recovery-pulse"), 900);
        }
        if (window.setMsg) setMsg("已打开项目恢复中心", "ok");
        return true;
      }
      if (action === "open") return setProjectDoc(name);
      if (action === "edit") return openProjectStateFile(name);
      if (action === "append") return appendProjectRecord(name);
      if (action === "copyRoadmap") return copyRoadmapBrief();
      return false;
    },
  };
  window.setProjectDoc = setProjectDoc;
  window.appendProjectRecord = appendProjectRecord;
  window.openProjectStateFile = openProjectStateFile;
  window.reloadProjectMemory = loadProjectState;
  window.copyProjectRoadmapBrief = copyRoadmapBrief;
  window.renderProjectRecovery = renderRecovery;
  window.focusProjectMemory = () => {
    if (!docs.length) loadProjectState();
    else renderRecovery();
    refreshProjectActions();
  };
  window.refreshProjectActions = refreshProjectActions;
  window.addEventListener("wb:workspace-state", () => refreshProjectActions());
})();
