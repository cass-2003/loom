/* Workbench 任务 / Agent 面板：轻量本地任务流，后续 Playbook/Agent brief 都挂在这里。 */
(function () {
  const $ = (s) => document.querySelector(s);
  const STATUS = {
    todo: "待办",
    running: "进行中",
    verified: "已验证",
    blocked: "阻塞",
  };
  let tasks = [];
  let tasksLoaded = false;
  let tasksLoading = null;
  let sessions = [];
  let sessionsLoaded = false;
  let sessionsLoading = null;
  const taskFilters = { status: "all", source: "all" };

  const esc = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function nowId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
      + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    return "task-" + stamp + "-" + Math.random().toString(16).slice(2, 6);
  }
  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => r.json());
  }

  function nowSessionId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
      + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    return "session-" + stamp + "-" + Math.random().toString(16).slice(2, 6);
  }
  function lines(text) {
    return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      .split("\n").map(x => x.trim()).filter(Boolean);
  }
  function compactText(text, limit) {
    const s = String(text || "").trim();
    return s.length > limit ? s.slice(0, limit - 1) + "…" : s;
  }
  function workspaceLayoutSnapshot() {
    if (window.getWorkspaceLayoutSnapshot) {
      try { return window.getWorkspaceLayoutSnapshot(); } catch {}
    }
    return null;
  }
  function workspaceLayoutBrief() {
    const snap = workspaceLayoutSnapshot();
    if (window.formatWorkspaceLayoutBrief) {
      try { return window.formatWorkspaceLayoutBrief(snap); } catch {}
    }
    return [
      "# Workspace Layout Snapshot",
      "",
      `- workspaceId: ${window.currentWorkspaceId || "none"}`,
      `- activeFile: ${window.state && state.current ? state.current : "none"}`,
    ].join("\n");
  }
  function workspaceContextLines() {
    const snap = workspaceLayoutSnapshot();
    if (!snap) {
      return [
        `Workspace: ${window.currentWorkspaceId || window.currentRoot || "unknown"}`,
        `Current file: ${window.state && state.current ? state.current : "none"}`,
      ];
    }
    const mainTabs = snap.main && snap.main.tabs ? snap.main.tabs.length : 0;
    const sideTabs = snap.side && snap.side.tabs ? snap.side.tabs.length : 0;
    return [
      `Workspace: ${snap.workspaceId || snap.root || "unknown"}`,
      `Active file: ${snap.activeFile || "none"}`,
      `Active group: ${snap.activeGroup || "main"}`,
      `Main tabs: ${mainTabs}`,
      `Side tabs: ${sideTabs}`,
      `Sidebar collapsed: ${snap.ui && snap.ui.sidebarCollapsed ? "yes" : "no"}`,
    ];
  }
  function taskSource(t) {
    const text = [t && t.title, ...((t && t.log) || [])].join("\n").toLowerCase();
    if (/workspace layout|工作区布局/.test(text)) return "layout";
    if (/created from viewer|查看器/.test(text)) return "viewer";
    if (/created from git|git changes|git 变更/.test(text)) return "git";
    if (/terminal|npm run|make /.test(text)) return "terminal";
    if (/markdown|\.md\b|\.markdown\b/.test(text)) return "markdown";
    if (/playbook|skill|release installer|ui button audit/.test(text)) return "playbook";
    if (/current file|当前文件|文件审计/.test(text)) return "file";
    return "manual";
  }
  const SOURCE_LABELS = {
    all: "全部",
    layout: "布局",
    viewer: "查看器",
    git: "Git",
    terminal: "终端",
    markdown: "Markdown",
    playbook: "Playbook",
    file: "文件",
    manual: "手动",
  };
  function latestByUpdated(items) {
    return (items || []).slice().sort((a, b) =>
      String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0] || null;
  }
  function sessionLayoutSummary(s) {
    const sourceLines = [
      ...((s && Array.isArray(s.context)) ? s.context : []),
      ...String(s && s.brief || "").split(/\r?\n/),
    ];
    const values = {};
    sourceLines.forEach(line => {
      const raw = String(line || "").trim();
      let m = raw.match(/^[-*]?\s*(workspace|workspaceId|activeFile|activeGroup|sideOrient|sidebarCollapsed|theme|currentFile)\s*:\s*(.+)$/i);
      if (m) {
        values[m[1].toLowerCase()] = m[2].trim();
        return;
      }
      m = raw.match(/^[-*]?\s*(main tabs|side tabs)\s*:\s*(\d+)/i);
      if (m) values[m[1].toLowerCase().replace(/\s+/g, "")] = m[2];
    });
    const task = findTaskForSession(s);
    const workspace = values.workspace || values.workspaceid || window.currentWorkspaceId || window.currentRoot || "unknown";
    const file = values.activefile || values.currentfile || "none";
    const mainTabs = values.maintabs || "";
    const sideTabs = values.sidetabs || "";
    return {
      workspace,
      file,
      group: values.activegroup || "main",
      tabs: mainTabs || sideTabs ? `主 ${mainTabs || "?"} / 侧 ${sideTabs || "?"}` : "",
      sideOrient: values.sideorient || "",
      sidebarCollapsed: values.sidebarcollapsed || "",
      theme: values.theme || "",
      taskStatus: task ? (STATUS[task.status] || task.status || "") : "",
    };
  }
  function renderSessionLayout(summary) {
    const chips = [
      ["工作区", summary.workspace],
      ["当前文件", summary.file],
      ["焦点", summary.group],
      summary.tabs ? ["标签", summary.tabs] : null,
      summary.sideOrient ? ["侧栏方向", summary.sideOrient] : null,
      summary.sidebarCollapsed ? ["侧栏", summary.sidebarCollapsed] : null,
      summary.theme ? ["主题", summary.theme] : null,
      summary.taskStatus ? ["任务状态", summary.taskStatus] : null,
    ].filter(Boolean);
    return `<div class="session-layout">${chips.map(([k, v]) =>
      `<span><b>${esc(k)}</b>${esc(v)}</span>`).join("")}</div>`;
  }
  function visibleTasks() {
    return tasks.filter(t => {
      if (taskFilters.status !== "all" && t.status !== taskFilters.status) return false;
      if (taskFilters.source !== "all" && taskSource(t) !== taskFilters.source) return false;
      return true;
    });
  }
  function recoveryBrief() {
    const latestTask = latestByUpdated(tasks);
    const latestSession = latestByUpdated(sessions);
    const shown = visibleTasks();
    const filterText = [
      `status=${taskFilters.status}`,
      `source=${taskFilters.source}`,
      `shown=${shown.length}/${tasks.length}`,
    ].join(", ");
    return [
      "# Workbench Recovery Brief",
      "",
      "## Workspace",
      workspaceLayoutBrief(),
      "",
      "## Current Filters",
      `- ${filterText}`,
      "",
      "## Latest Task",
      latestTask ? taskBrief(latestTask) : "（暂无任务）",
      "",
      "## Latest Session",
      latestSession ? [
        `- id: ${latestSession.id}`,
        `- title: ${latestSession.title || latestSession.taskTitle || "Untitled"}`,
        `- status: ${latestSession.status || "draft"}`,
        `- taskId: ${latestSession.taskId || "none"}`,
        "",
        "### Context",
        ...((latestSession.context || []).length ? latestSession.context.map(x => "- " + x) : ["- （暂无）"]),
        "",
        "### Evidence",
        ...((latestSession.evidence || []).length ? latestSession.evidence.map(x => "- " + x) : ["- （暂无）"]),
      ].join("\n") : "（暂无会话）",
      "",
      "## Next",
      latestTask ? (latestTask.next || "打开最近任务，补充日志、证据或创建会话。") : "从当前文件、Git 变更、Playbook 或工作区布局创建一个可验证任务。",
    ].join("\n");
  }
  async function copyRecoveryBrief() {
    const text = recoveryBrief();
    try {
      await navigator.clipboard.writeText(text);
      if (window.setMsg) setMsg("已复制恢复 brief", "ok");
      return true;
    } catch {
      prompt("复制下面的恢复 brief：", text);
      return true;
    }
  }
  function setSelectOptions(sel, options, value) {
    if (!sel) return;
    sel.innerHTML = options.map(opt =>
      `<option value="${esc(opt.value)}"${opt.value === value ? " selected" : ""}>${esc(opt.label)}</option>`).join("");
  }
  function renderTaskRecovery() {
    const grid = $("#task-recovery-grid");
    const next = $("#task-next");
    const statusSel = $("#task-status-filter");
    const sourceSel = $("#task-source-filter");
    const clear = $("#task-clear-filter");
    const copy = $("#task-copy-recovery");
    if (!grid || !next || !statusSel || !sourceSel) return;
    const snap = workspaceLayoutSnapshot();
    const mainTabs = snap && snap.main && snap.main.tabs ? snap.main.tabs.length : 0;
    const sideTabs = snap && snap.side && snap.side.tabs ? snap.side.tabs.length : 0;
    const counts = tasks.reduce((acc, t) => {
      acc[t.status || "todo"] = (acc[t.status || "todo"] || 0) + 1;
      return acc;
    }, {});
    const latestTask = latestByUpdated(tasks);
    const latestSession = latestByUpdated(sessions);
    grid.innerHTML = [
      ["工作区", snap && snap.roots && snap.roots.length > 1 ? `${snap.roots.length} 个目录` : (window.currentRoot || "未打开")],
      ["当前文件", snap && snap.activeFile ? snap.activeFile : "none"],
      ["布局", `主 ${mainTabs} / 侧 ${sideTabs}`],
      ["任务", `待办 ${counts.todo || 0} · 进行 ${counts.running || 0} · 已验 ${counts.verified || 0} · 阻塞 ${counts.blocked || 0}`],
      ["最近任务", latestTask ? latestTask.title : "暂无"],
      ["最近会话", latestSession ? (latestSession.title || latestSession.taskTitle || latestSession.id) : "暂无"],
    ].map(([k, v]) => `<div class="task-recovery-card"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join("");
    const sources = Array.from(new Set(tasks.map(taskSource))).sort();
    setSelectOptions(statusSel, [
      { value: "all", label: "全部" },
      ...Object.keys(STATUS).map(k => ({ value: k, label: STATUS[k] })),
    ], taskFilters.status);
    setSelectOptions(sourceSel, [
      { value: "all", label: "全部" },
      ...sources.map(k => ({ value: k, label: SOURCE_LABELS[k] || k })),
    ], taskFilters.source);
    const filtered = visibleTasks().length;
    const hasFilter = taskFilters.status !== "all" || taskFilters.source !== "all";
    if (clear) clear.classList.toggle("hidden", !hasFilter);
    if (copy) {
      copy.disabled = !tasksLoaded && !sessionsLoaded;
      copy.title = copy.disabled ? "任务/会话尚未加载" : "复制恢复 brief";
    }
    next.textContent = latestTask
      ? `下一步：${latestTask.next || "打开最近任务，补充日志、证据或创建会话。"}`
      : "下一步：从当前文件、Git 变更、Playbook 或工作区布局创建一个可验证任务。";
    next.title = hasFilter ? `当前过滤显示 ${filtered}/${tasks.length} 个任务` : `共 ${tasks.length} 个任务`;
  }

  async function saveTasks(msg) {
    const res = await postJson("/api/workflow-tasks", { tasks });
    if (res.error) {
      if (window.setMsg) setMsg("任务保存失败: " + res.error, "err");
      return false;
    }
    tasks = Array.isArray(res.tasks) ? res.tasks : tasks;
    renderTasks();
    if (msg && window.setMsg) setMsg(msg, "ok");
    return true;
  }

  async function loadTasks() {
    if (tasksLoading) return tasksLoading;
    tasksLoading = (async () => {
      try {
        const data = await fetch("/api/workflow-tasks", { cache: "no-store" }).then(r => r.json());
        if (data.error) throw new Error(data.error);
        tasks = Array.isArray(data.tasks) ? data.tasks : [];
        tasksLoaded = true;
        renderTaskRecovery();
        renderTasks();
        return true;
      } catch (e) {
        const host = $("#task-list");
        if (host) host.innerHTML = `<div class="task-error">任务加载失败: ${esc(e && e.message ? e.message : e)}</div>`;
        return false;
      } finally {
        tasksLoading = null;
      }
    })();
    return tasksLoading;
  }

  async function loadSessions() {
    if (sessionsLoading) return sessionsLoading;
    sessionsLoading = (async () => {
      try {
        const data = await fetch("/api/agent-sessions", { cache: "no-store" }).then(r => r.json());
        if (data.error) throw new Error(data.error);
        sessions = Array.isArray(data.sessions) ? data.sessions : [];
        sessionsLoaded = true;
        renderTaskRecovery();
        renderSessions();
        return true;
      } catch (e) {
        if (window.setMsg) setMsg("会话加载失败: " + (e && e.message ? e.message : e), "err");
        return false;
      } finally {
        sessionsLoading = null;
      }
    })();
    return sessionsLoading;
  }

  async function saveSessions(msg) {
    const res = await postJson("/api/agent-sessions", { sessions });
    if (res.error) {
      if (window.setMsg) setMsg("会话保存失败: " + res.error, "err");
      return false;
    }
    sessions = Array.isArray(res.sessions) ? res.sessions : sessions;
    renderTaskRecovery();
    renderSessions();
    if (msg && window.setMsg) setMsg(msg, "ok");
    return true;
  }

  function promptTask() {
    const title = prompt("任务标题：", "");
    if (!title || !title.trim()) return;
    const goal = prompt("任务目标 / 验收标准：", "") || "";
    const plan = prompt("计划步骤（每行一条）：", "扫描现状\n实现最小闭环\n运行验证\n记录结果") || "";
    const now = new Date().toISOString().slice(0, 19);
    tasks.unshift({
      id: nowId(),
      title: title.trim(),
      status: "todo",
      goal: goal.trim(),
      plan: lines(plan),
      evidence: [],
      log: [],
      next: "",
      createdAt: now,
      updatedAt: now,
    });
    saveTasks("已创建任务");
  }

  async function addWorkflowTask(seed) {
    if (!tasksLoaded) await loadTasks();
    const now = new Date().toISOString().slice(0, 19);
    tasks.unshift({
      id: nowId(),
      title: String(seed && seed.title || "未命名任务").trim(),
      status: "todo",
      goal: String(seed && seed.goal || "").trim(),
      plan: Array.isArray(seed && seed.plan) ? seed.plan : [],
      evidence: Array.isArray(seed && seed.evidence) ? seed.evidence : [],
      log: Array.isArray(seed && seed.log) ? seed.log : [],
      next: String(seed && seed.next || "").trim(),
      createdAt: now,
      updatedAt: now,
    });
    const task = tasks[0];
    await saveTasks("已创建任务");
    if (typeof switchView === "function") switchView("tasks");
    return task;
  }

  function taskBrief(t) {
    return [
      `# ${t.title}`,
      "",
      `- id: ${t.id}`,
      `- status: ${STATUS[t.status] || t.status}`,
      "",
      "## Goal",
      t.goal || "（未填写）",
      "",
      "## Plan",
      ...(t.plan && t.plan.length ? t.plan.map(x => "- " + x) : ["- （未填写）"]),
      "",
      "## Evidence",
      ...(t.evidence && t.evidence.length ? t.evidence.map(x => "- " + x) : ["- （暂无）"]),
      "",
      "## Log",
      ...(t.log && t.log.length ? t.log.map(x => "- " + x) : ["- （暂无）"]),
      "",
      "## Next",
      t.next || "（未填写）",
    ].join("\n");
  }

  function sessionBrief(t) {
    const git = window.gitState && gitState.repo
      ? `repo=${gitState.repo}, branch=${gitState.branch || ""}, changed=${gitState.changed || 0}`
      : "repo=unknown";
    const file = window.state && state.current ? state.current : "none";
    return [
      `# Agent Session: ${t.title}`,
      "",
      `- taskId: ${t.id}`,
      `- status: draft`,
      `- workspace: ${window.currentWorkspaceId || window.currentRoot || "unknown"}`,
      `- currentFile: ${file}`,
      `- git: ${git}`,
      "",
      "## Workspace Layout",
      workspaceLayoutBrief(),
      "",
      "## Task Brief",
      taskBrief(t),
      "",
      "## Instructions",
      "- Work locally and preserve existing user changes.",
      "- Prefer small verifiable changes.",
      "- Record commands, outputs, screenshots, and changed files as evidence.",
      "- Do not run high-risk commands without explicit confirmation.",
      "",
      "## Expected Return",
      "- Summary of actions taken.",
      "- Validation commands and results.",
      "- Files changed or artifacts produced.",
      "- Follow-up risks or blockers.",
    ].join("\n");
  }

  function taskMemoryTitle(t) {
    return `Task ${STATUS[t.status] || t.status}: ${t.title}`;
  }

  async function copyBrief(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    const brief = taskBrief(t);
    try {
      await navigator.clipboard.writeText(brief);
      if (window.setMsg) setMsg("已复制 Agent brief", "ok");
    } catch {
      prompt("复制下面的 Agent brief：", brief);
    }
  }

  async function appendTaskToMemory(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    const res = await postJson("/api/project-state/append", {
      kind: "validation",
      target: "progress",
      title: taskMemoryTitle(t),
      content: taskBrief(t),
    });
    if (res.error) {
      if (window.setMsg) setMsg("写入项目记忆失败: " + res.error, "err");
      return;
    }
    t.log = Array.isArray(t.log) ? t.log : [];
    t.log.push("已同步任务验证记录到 Project Memory / Progress");
    await saveTasks("已写入项目记忆");
    if (window.reloadProjectMemory) window.reloadProjectMemory();
  }

  function findTaskForSession(session) {
    if (!session) return null;
    return tasks.find(t => t.id === session.taskId) || null;
  }

  async function appendAgentResultToMemory(t, session, summary, evidence) {
    const content = [
      `Session: ${session ? session.id : "none"}`,
      "",
      summary,
      "",
      "Evidence:",
      ...(evidence.length ? evidence.map(x => "- " + x) : ["- （暂无）"]),
    ].join("\n");
    const res = await postJson("/api/project-state/append", {
      kind: "validation",
      target: "progress",
      title: `Agent result: ${t ? t.title : (session && session.title) || "Untitled"}`,
      content,
    });
    if (res.error) {
      if (window.setMsg) setMsg("写入项目记忆失败: " + res.error, "err");
      return false;
    }
    if (window.reloadProjectMemory) window.reloadProjectMemory();
    return true;
  }

  async function importAgentResult(sessionId, taskId) {
    if (!tasksLoaded) await loadTasks();
    if (!sessionsLoaded) await loadSessions();
    const session = sessions.find(s => s.id === sessionId) || null;
    const t = tasks.find(x => x.id === taskId) || findTaskForSession(session);
    if (!session && !t) {
      if (window.setMsg) setMsg("没有可导入的任务或会话", "warn");
      return;
    }
    const summary = prompt("粘贴外部 Agent / CLI 的执行摘要：", "");
    if (!summary || !summary.trim()) return;
    const evidence = lines(prompt("证据路径 / 验证命令（每行一条，可留空）：", "") || "");
    const now = new Date().toISOString().slice(0, 19);
    const short = compactText(summary, 420);
    if (session) {
      session.status = evidence.length ? "verified" : "running";
      session.outputs = Array.isArray(session.outputs) ? session.outputs : [];
      session.outputs.push(short);
      session.evidence = Array.isArray(session.evidence) ? session.evidence : [];
      session.evidence.push(...evidence);
      session.log = Array.isArray(session.log) ? session.log : [];
      session.log.push(`Imported Agent result at ${now}`);
    }
    if (t) {
      t.status = evidence.length ? "verified" : "running";
      t.log = Array.isArray(t.log) ? t.log : [];
      t.log.push(`Agent result imported${session ? " from " + session.id : ""}: ${short}`);
      t.evidence = Array.isArray(t.evidence) ? t.evidence : [];
      t.evidence.push(...evidence);
    }
    const memoryOk = t ? await appendAgentResultToMemory(t, session, summary.trim(), evidence) : true;
    const taskOk = t ? await saveTasks() : true;
    const sessionOk = session ? await saveSessions() : true;
    if (memoryOk && taskOk && sessionOk && window.setMsg) setMsg("已导入 Agent 结果", "ok");
  }

  async function createSessionFromTask(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return null;
    if (!sessionsLoaded) await loadSessions();
    const now = new Date().toISOString().slice(0, 19);
    const brief = sessionBrief(t);
    const session = {
      id: nowSessionId(),
      title: t.title,
      status: "draft",
      taskId: t.id,
      taskTitle: t.title,
      brief,
      context: [
        `Task: ${t.title}`,
        ...workspaceContextLines(),
      ],
      outputs: [],
      evidence: [],
      log: [`Created from workflow task: ${t.id}`],
      createdAt: now,
      updatedAt: now,
    };
    sessions.unshift(session);
    const ok = await saveSessions("已创建 Agent session");
    if (!ok) return null;
    t.log = Array.isArray(t.log) ? t.log : [];
    t.log.push(`已创建 Agent session: ${session.id}`);
    await saveTasks();
    return session;
  }

  async function copySessionBrief(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    let session = null;
    if (!sessionsLoaded) await loadSessions();
    session = sessions.find(s => s.taskId === id) || await createSessionFromTask(id);
    if (!session) return;
    const text = session.brief || sessionBrief(t);
    try {
      await navigator.clipboard.writeText(text);
      if (window.setMsg) setMsg("已复制 Session brief", "ok");
    } catch {
      prompt("复制下面的 Session brief：", text);
    }
  }

  function addTaskLine(id, field, label) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    const text = prompt(label + "：", "");
    if (!text || !text.trim()) return;
    t[field] = Array.isArray(t[field]) ? t[field] : [];
    t[field].push(text.trim());
    if (field === "evidence" && t.status !== "verified") t.status = "running";
    saveTasks("已更新任务");
  }

  function setTaskStatus(id, status) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    t.status = status;
    saveTasks("已更新任务状态");
  }

  function renderTasks() {
    const list = $("#task-list");
    const empty = $("#task-empty");
    if (!list || !empty) return;
    renderTaskRecovery();
    const shown = visibleTasks();
    empty.classList.toggle("hidden", shown.length > 0);
    const emptyText = empty.querySelector("span");
    if (emptyText) emptyText.textContent = tasks.length && !shown.length
      ? "当前过滤没有匹配任务。可以清除过滤，或从当前上下文创建新任务。"
      : "记录目标、计划、执行日志和证据路径，后续可导出给 Agent / Playbook。";
    list.innerHTML = shown.map(t => {
      const plan = (t.plan || []).slice(0, 5).map(x => `<li>${esc(x)}</li>`).join("");
      const evidence = (t.evidence || []).slice(-4).map(x => `<li>${esc(x)}</li>`).join("");
      const logLines = Array.isArray(t.log) ? t.log : [];
      const logPreview = logLines.length > 4
        ? logLines.slice(0, 2).concat(logLines.slice(-2))
        : logLines;
      const log = logPreview.map(x => `<li>${esc(x)}</li>`).join("");
      return `<article class="task-card" data-id="${esc(t.id)}">
        <div class="task-card-head">
          <span class="task-state ${esc(t.status)}">${esc(STATUS[t.status] || t.status)}</span>
          <span class="task-source">${esc(SOURCE_LABELS[taskSource(t)] || taskSource(t))}</span>
          <button class="task-mini" data-act="brief" title="复制 Agent brief">${svgIcon("copy", 13)}</button>
        </div>
        <h3>${esc(t.title)}</h3>
        <p class="task-goal">${esc(t.goal || "未填写目标")}</p>
        <div class="task-section"><b>Plan</b><ol>${plan || "<li>未填写</li>"}</ol></div>
        <div class="task-section"><b>Evidence</b><ul>${evidence || "<li>暂无</li>"}</ul></div>
        <div class="task-section"><b>Log</b><ul>${log || "<li>暂无</li>"}</ul></div>
        <div class="task-actions">
          <button data-act="running">开始</button>
          <button data-act="verified">验证通过</button>
          <button data-act="blocked">阻塞</button>
          <button data-act="log">追加日志</button>
          <button data-act="evidence">追加证据</button>
          <button data-act="session">创建会话</button>
          <button data-act="sessionBrief">复制会话 brief</button>
          <button data-act="import">导入结果</button>
          <button data-act="memory">写入记忆</button>
        </div>
      </article>`;
    }).join("");
    list.querySelectorAll(".task-card").forEach(card => {
      const id = card.dataset.id;
      card.addEventListener("click", e => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === "brief") copyBrief(id);
        else if (act === "log") addTaskLine(id, "log", "追加日志");
        else if (act === "evidence") addTaskLine(id, "evidence", "追加证据路径 / 验证命令");
        else if (act === "session") createSessionFromTask(id);
        else if (act === "sessionBrief") copySessionBrief(id);
        else if (act === "import") importAgentResult(null, id);
        else if (act === "memory") appendTaskToMemory(id);
        else setTaskStatus(id, act);
      });
    });
  }

  function renderSessions() {
    const list = $("#session-list");
    const empty = $("#session-empty");
    if (!list || !empty) return;
    empty.classList.toggle("hidden", sessions.length > 0);
    renderTaskRecovery();
    list.innerHTML = sessions.map(s => {
      const outputs = (s.outputs || []).slice(-2).map(x => `<li>${esc(x)}</li>`).join("");
      const evidence = (s.evidence || []).slice(-3).map(x => `<li>${esc(x)}</li>`).join("");
      const layout = renderSessionLayout(sessionLayoutSummary(s));
      return `<article class="session-card" data-id="${esc(s.id)}">
        <div class="session-card-head">
          <span class="task-state ${esc(s.status)}">${esc(STATUS[s.status] || s.status || "draft")}</span>
          <span class="session-id">${esc(s.id)}</span>
        </div>
        <h3>${esc(s.title || s.taskTitle || "未命名会话")}</h3>
        <div class="session-sub">${esc(s.taskTitle || s.taskId || "未绑定任务")}</div>
        ${layout}
        <div class="task-section"><b>Outputs</b><ul>${outputs || "<li>暂无</li>"}</ul></div>
        <div class="task-section"><b>Evidence</b><ul>${evidence || "<li>暂无</li>"}</ul></div>
        <div class="task-actions">
          <button data-act="brief">复制 brief</button>
          <button data-act="import">导入结果</button>
        </div>
      </article>`;
    }).join("");
    list.querySelectorAll(".session-card").forEach(card => {
      const id = card.dataset.id;
      card.addEventListener("click", e => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const session = sessions.find(s => s.id === id);
        if (!session) return;
        if (btn.dataset.act === "brief") {
          const text = session.brief || "";
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
              () => window.setMsg && setMsg("已复制 Session brief", "ok"),
              () => prompt("复制下面的 Session brief：", text)
            );
          } else {
            prompt("复制下面的 Session brief：", text);
          }
        } else if (btn.dataset.act === "import") {
          importAgentResult(id, session.taskId);
        }
      });
    });
  }

  function initTasksPanel() {
    const refresh = $("#task-refresh");
    if (refresh) refresh.onclick = loadTasks;
    const sessionRefresh = $("#session-refresh");
    if (sessionRefresh) sessionRefresh.onclick = loadSessions;
    const create = $("#task-new");
    if (create) create.onclick = promptTask;
    const statusSel = $("#task-status-filter");
    if (statusSel) statusSel.onchange = () => { taskFilters.status = statusSel.value || "all"; renderTasks(); };
    const sourceSel = $("#task-source-filter");
    if (sourceSel) sourceSel.onchange = () => { taskFilters.source = sourceSel.value || "all"; renderTasks(); };
    const clear = $("#task-clear-filter");
    if (clear) clear.onclick = () => {
      taskFilters.status = "all";
      taskFilters.source = "all";
      renderTasks();
    };
    const copy = $("#task-copy-recovery");
    if (copy) copy.onclick = copyRecoveryBrief;
    loadTasks();
    loadSessions();
  }

  window.initTasksPanel = initTasksPanel;
  window.reloadWorkflowTasks = loadTasks;
  window.reloadAgentSessions = loadSessions;
  window.createWorkflowTask = promptTask;
  window.addWorkflowTask = addWorkflowTask;
  function taskActionState(action) {
    const hasTask = tasks.length > 0;
    const hasSession = sessions.length > 0;
    if (action === "appendMemory" || action === "createSession" || action === "copySessionBrief" || action === "importTaskResult") {
      if (!tasksLoaded) return { enabled: true, reason: "" };
      if (!hasTask) return { enabled: false, reason: "还没有可操作的工作流任务" };
    }
    if (action === "importSessionResult" && !hasSession && !hasTask) {
      if (!tasksLoaded || !sessionsLoaded) return { enabled: true, reason: "" };
      return { enabled: false, reason: "还没有可导入结果的任务或会话" };
    }
    return { enabled: true, reason: "" };
  }
  async function runTaskAction(action) {
    if (!tasksLoaded) await loadTasks();
    if ((action === "importSessionResult" || action === "copySessionBrief") && !sessionsLoaded) await loadSessions();
    const st = taskActionState(action);
    if (!st.enabled) {
      if (window.setMsg) setMsg(st.reason || "当前不可用", "warn");
      return false;
    }
    if (action === "appendMemory") return appendTaskToMemory(tasks[0].id);
    if (action === "createSession") return createSessionFromTask(tasks[0].id);
    if (action === "copySessionBrief") return copySessionBrief(tasks[0].id);
    if (action === "importTaskResult") return importAgentResult(null, tasks[0].id);
    if (action === "importSessionResult") {
      if (sessions[0]) return importAgentResult(sessions[0].id, sessions[0].taskId);
      return importAgentResult(null, tasks[0].id);
    }
    return false;
  }
  window.wbTaskActions = {
    actionState: taskActionState,
    run: runTaskAction,
    summary: () => ({
      tasks: tasks.length,
      sessions: sessions.length,
      tasksLoaded,
      sessionsLoaded,
    }),
  };
  window.appendActiveTaskToMemory = () => {
    runTaskAction("appendMemory");
  };
  window.createSessionFromActiveTask = () => {
    runTaskAction("createSession");
  };
  window.copyActiveSessionBrief = () => {
    runTaskAction("copySessionBrief");
  };
  window.importAgentResultToActiveTask = () => {
    runTaskAction("importTaskResult");
  };
  window.importAgentResultToActiveSession = () => {
    runTaskAction("importSessionResult");
  };
  window.focusWorkflowTasks = () => {
    if (!tasks.length) loadTasks();
    renderTaskRecovery();
  };
})();
