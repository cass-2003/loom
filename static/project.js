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
    if (name === "roadmap") return roadmap;
    return docs.find(x => x.name === name) || null;
  }
  function hasWorkspace() {
    return typeof window.hasOpenWorkspace === "function" ? window.hasOpenWorkspace() : !!window.currentRoot;
  }
  function projectActionState(action, name) {
    const key = name || active;
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
    const sessionLine = latestSession
      ? `${latestSession.title} · ${latestSession.status || "draft"}`
      : "暂无会话，可从任务卡创建 Agent brief";
    const copyState = window.wbTaskActions && window.wbTaskActions.actionState
      ? window.wbTaskActions.actionState("copyRecoveryBrief")
      : { enabled: false, reason: "任务恢复 brief 尚未就绪" };
    host.innerHTML = `<div class="project-continuity-head"><b>任务连续性</b>`
      + `<span>${ready ? `${summary.tasks || 0} tasks · ${summary.sessions || 0} sessions` : "任务面板加载中"}</span></div>`
      + `<div class="project-continuity-grid">`
      + `<span><b>状态</b>待办 ${counts.todo || 0} · 进行 ${counts.running || 0} · 已验 ${counts.verified || 0}</span>`
      + `<span><b>视图</b>${esc(filter)} · ${ready ? `${summary.visible || 0} 可见` : "待同步"}</span>`
      + `</div>`
      + `<button data-act="open-tasks">${esc(latestTask ? latestTask.title : "打开 Tasks 面板")}</button>`
      + `<span>${esc(taskLine)}</span>`
      + `<em>${esc(sessionLine)}</em>`
      + `<button class="project-validation-task" data-act="copy-recovery"${copyState.enabled ? "" : ` disabled title="${esc(copyState.reason || "当前不可用")}"`}>复制完整恢复 brief</button>`;
    const open = host.querySelector("[data-act='open-tasks']");
    if (open) open.onclick = () => {
      if (typeof switchView === "function") switchView("tasks");
      if (window.focusWorkflowTasks) window.focusWorkflowTasks();
    };
    const copy = host.querySelector("[data-act='copy-recovery']");
    if (copy) copy.onclick = copyTasksRecoveryBrief;
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
    if (validation) {
      const taskReady = !!window.addWorkflowTask;
      validation.innerHTML = recentValidation
        ? `<b>最近验证</b><button data-target="progress">${esc(recentValidation.title)}</button>`
          + `<span>${esc(recentValidation.evidence || recentValidation.goal || "暂无验证摘要")}</span>`
          + (recentValidation.next ? `<em>${esc(recentValidation.next)}</em>` : "")
          + `<button class="project-validation-task" data-act="validation-task"${taskReady ? "" : " disabled title=\"任务面板尚未就绪\""}>从验证创建任务</button>`
          + `<button class="project-validation-task" data-act="copy-task-recovery"${window.wbTaskActions ? "" : " disabled title=\"任务恢复 brief 尚未就绪\""}>复制任务恢复 brief</button>`
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
      if (taskBtn) taskBtn.onclick = () => createTaskFromRecentValidation(recentValidation);
      const copyTaskBrief = validation.querySelector("[data-act='copy-task-recovery']");
      if (copyTaskBrief) copyTaskBrief.onclick = copyTasksRecoveryBrief;
    }
    renderTaskContinuity();
    const copyRoadmap = latest.querySelector("[data-act='copy-roadmap']");
    if (copyRoadmap) copyRoadmap.onclick = copyRoadmapBrief;
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
      openSource.disabled = false;
      openSource.title = item.readonly ? "路线为只读资料，可在此处查看或复制" : "打开当前记忆文件";
    }
    renderRecovery();
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
  window.wbProjectActions = {
    actionState: projectActionState,
    run: async (action, name) => {
      if (!docs.length || (action === "copyRoadmap" && !roadmap)) await loadProjectState();
      const st = projectActionState(action, name);
      if (!st.enabled) {
        if (window.setMsg) setMsg(st.reason || "当前不可用", "warn");
        return false;
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
  };
})();
