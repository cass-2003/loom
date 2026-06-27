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
  function lines(text) {
    return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      .split("\n").map(x => x.trim()).filter(Boolean);
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
    try {
      const data = await fetch("/api/workflow-tasks", { cache: "no-store" }).then(r => r.json());
      if (data.error) throw new Error(data.error);
      tasks = Array.isArray(data.tasks) ? data.tasks : [];
      renderTasks();
    } catch (e) {
      const host = $("#task-list");
      if (host) host.innerHTML = `<div class="task-error">任务加载失败: ${esc(e && e.message ? e.message : e)}</div>`;
    }
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
    empty.classList.toggle("hidden", tasks.length > 0);
    list.innerHTML = tasks.map(t => {
      const plan = (t.plan || []).slice(0, 5).map(x => `<li>${esc(x)}</li>`).join("");
      const evidence = (t.evidence || []).slice(-4).map(x => `<li>${esc(x)}</li>`).join("");
      const log = (t.log || []).slice(-3).map(x => `<li>${esc(x)}</li>`).join("");
      return `<article class="task-card" data-id="${esc(t.id)}">
        <div class="task-card-head">
          <span class="task-state ${esc(t.status)}">${esc(STATUS[t.status] || t.status)}</span>
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
        else if (act === "memory") appendTaskToMemory(id);
        else setTaskStatus(id, act);
      });
    });
  }

  function initTasksPanel() {
    const refresh = $("#task-refresh");
    if (refresh) refresh.onclick = loadTasks;
    const create = $("#task-new");
    if (create) create.onclick = promptTask;
    loadTasks();
  }

  window.initTasksPanel = initTasksPanel;
  window.reloadWorkflowTasks = loadTasks;
  window.createWorkflowTask = promptTask;
  window.appendActiveTaskToMemory = () => {
    if (tasks[0]) appendTaskToMemory(tasks[0].id);
  };
  window.focusWorkflowTasks = () => {
    if (!tasks.length) loadTasks();
  };
})();
