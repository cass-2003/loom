/* Workbench 便签 / Todo 面板 */
(function () {
  let todos = [];          // [{id, text, done}]
  let note = "";
  let loaded = false;      // 首次加载完成前不触发保存
  let saveTimer = null;
  let dragId = null;       // 拖拽中的 todo id

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- 持久化 ----------
  async function load() {
    try {
      const data = await fetch("/api/notes").then(r => r.json());
      todos = Array.isArray(data.todos) ? data.todos.map(t => ({
        id: String(t.id || newId()),
        text: String(t.text || ""),
        done: !!t.done,
      })) : [];
      note = typeof data.note === "string" ? data.note : "";
    } catch {
      todos = []; note = "";
    }
    loaded = true;
    const ta = el("notes-text");
    if (ta) ta.value = note;
    renderTodos();
  }

  function scheduleSave() {
    if (!loaded) return;
    const st = el("notes-status");
    if (st) st.textContent = "未保存…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  }

  async function save() {
    const st = el("notes-status");
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ todos, note }),
      }).then(r => r.json());
      if (st) {
        if (res && res.ok) {
          st.textContent = "已保存";
          setTimeout(() => { if (st.textContent === "已保存") st.textContent = ""; }, 1500);
        } else {
          st.textContent = "保存失败";
        }
      }
    } catch {
      if (st) st.textContent = "保存失败";
    }
  }

  // ---------- 渲染 ----------
  function renderTodos() {
    const list = el("todo-list");
    if (!list) return;
    if (todos.length === 0) {
      list.innerHTML = '<div class="todo-empty">暂无待办，添加一个吧</div>';
      return;
    }
    list.innerHTML = "";
    todos.forEach(t => list.appendChild(renderRow(t)));
  }

  function renderRow(t) {
    const row = document.createElement("div");
    row.className = "todo-row" + (t.done ? " done" : "");
    row.dataset.id = t.id;
    row.draggable = true;
    row.innerHTML = `
      <span class="todo-grip" title="拖动排序" data-icon="list"></span>
      <button class="todo-check" title="标记完成"></button>
      <span class="todo-text"></span>
      <button class="todo-del" title="删除" data-icon="trash"></button>`;
    row.querySelector(".todo-text").textContent = t.text;
    if (window.hydrateIcons) hydrateIcons(row);

    // 勾选完成
    row.querySelector(".todo-check").addEventListener("click", () => {
      t.done = !t.done;
      row.classList.toggle("done", t.done);
      scheduleSave();
    });
    // 删除
    row.querySelector(".todo-del").addEventListener("click", () => {
      todos = todos.filter(x => x.id !== t.id);
      renderTodos();
      scheduleSave();
    });
    // 双击编辑
    const textEl = row.querySelector(".todo-text");
    textEl.addEventListener("dblclick", () => startEdit(row, t));

    // 拖拽排序
    row.addEventListener("dragstart", (e) => {
      dragId = t.id;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      dragId = null;
      row.classList.remove("dragging");
      document.querySelectorAll(".todo-row.drop-over")
        .forEach(r => r.classList.remove("drop-over"));
    });
    row.addEventListener("dragover", (e) => {
      if (dragId === null || dragId === t.id) return;
      e.preventDefault();
      row.classList.add("drop-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drop-over");
      if (dragId === null || dragId === t.id) return;
      const from = todos.findIndex(x => x.id === dragId);
      const to = todos.findIndex(x => x.id === t.id);
      if (from < 0 || to < 0) return;
      const [moved] = todos.splice(from, 1);
      todos.splice(to, 0, moved);
      renderTodos();
      scheduleSave();
    });
    return row;
  }

  function startEdit(row, t) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "todo-edit";
    input.value = t.text;
    input.spellcheck = false;
    const textEl = row.querySelector(".todo-text");
    row.replaceChild(input, textEl);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        const v = input.value.trim();
        if (v) { t.text = v; scheduleSave(); }
      }
      renderTodos();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  function addTodo() {
    const input = el("todo-input");
    if (!input) return;
    const v = input.value.trim();
    if (!v) return;
    todos.push({ id: newId(), text: v, done: false });
    input.value = "";
    renderTodos();
    scheduleSave();
  }

  // ---------- 初始化 ----------
  function initNotes() {
    const addInput = el("todo-input");
    const addBtn = el("todo-add");
    const noteTa = el("notes-text");
    if (!addInput) return;

    addBtn.addEventListener("click", addTodo);
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addTodo(); }
    });
    noteTa.addEventListener("input", () => {
      note = noteTa.value;
      scheduleSave();
    });
    load();
  }

  window.initNotes = initNotes;
  window.reloadNotes = load;
})();
