/* Workbench 全文搜索 */
(function () {
  const sState = { case: false, regex: false, lastQuery: null };
  let searchTimer = null;
  let searchSeq = 0;          // 请求令牌（防竞态）
  const collapsed = new Set(); // 折叠的文件分组
  let workspaceOpen = typeof window.hasOpenWorkspace === "function" ? window.hasOpenWorkspace() : true;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // 文件图标（复用 fileIcon）
  function iconFor(name) {
    const kind = (typeof guessKind === "function") ? guessKind(name) : "text";
    return fileIcon({ type: "file", name, kind });
  }

  async function runSearch() {
    const input = el("search-input");
    if (!workspaceOpen) {
      renderWorkspaceDisabled();
      return;
    }
    const q = input.value;
    const summary = el("search-summary");
    const list = el("search-results");
    if (!q.trim()) {
      summary.textContent = "";
      list.innerHTML = "";
      sState.lastQuery = null;
      return;
    }
    const token = ++searchSeq;
    summary.textContent = "搜索中…";
    let data;
    try {
      const url = `/api/search?q=${encodeURIComponent(q)}`
        + `&regex=${sState.regex ? 1 : 0}&case=${sState.case ? 1 : 0}`;
      data = await fetch(url).then(r => r.json());
    } catch {
      if (token !== searchSeq) return;
      summary.textContent = "搜索请求失败";
      list.innerHTML = "";
      return;
    }
    if (token !== searchSeq) return;  // 过期响应丢弃
    if (data.error) {
      summary.innerHTML = `<span class="search-err">${esc(data.error)}</span>`;
      list.innerHTML = "";
      return;
    }
    sState.lastQuery = q;
    renderResults(data.results || [], !!data.truncated);
  }

  // 按文件分组渲染
  function renderResults(results, truncated) {
    const summary = el("search-summary");
    const list = el("search-results");
    if (results.length === 0) {
      summary.textContent = "无匹配结果";
      list.innerHTML = "";
      return;
    }
    // 分组（保持后端返回的文件顺序）
    const groups = [];
    const idxMap = new Map();
    for (const r of results) {
      let g = idxMap.get(r.path);
      if (!g) { g = { path: r.path, hits: [] }; idxMap.set(r.path, g); groups.push(g); }
      g.hits.push(r);
    }
    summary.textContent = `${results.length} 个结果，${groups.length} 个文件`
      + (truncated ? "（已截断）" : "");

    list.innerHTML = "";
    for (const g of groups) {
      const slash = g.path.lastIndexOf("/");
      const fname = slash >= 0 ? g.path.slice(slash + 1) : g.path;
      const dir = slash >= 0 ? g.path.slice(0, slash) : "";
      const [iconName, iconCls] = iconFor(fname);
      const isCol = collapsed.has(g.path);

      const groupEl = document.createElement("div");
      groupEl.className = "sr-group" + (isCol ? " collapsed" : "");

      const head = document.createElement("div");
      head.className = "sr-file";
      head.innerHTML =
        `<span class="sr-twist">${svgIcon("chevron", 13)}</span>`
        + `<span class="sr-fico ${iconCls}">${svgIcon(iconName, 14)}</span>`
        + `<span class="sr-fname">${esc(fname)}</span>`
        + (dir ? `<span class="sr-fdir">${esc(dir)}</span>` : "")
        + `<span class="sr-fcount">${g.hits.length}</span>`;
      head.onclick = () => {
        if (collapsed.has(g.path)) collapsed.delete(g.path);
        else collapsed.add(g.path);
        groupEl.classList.toggle("collapsed");
      };
      groupEl.appendChild(head);

      const hitsEl = document.createElement("div");
      hitsEl.className = "sr-hits";
      for (const hit of g.hits) {
        const row = document.createElement("div");
        row.className = "sr-hit";
        row.title = `${g.path}:${hit.line}`;
        const ln = document.createElement("span");
        ln.className = "sr-line";
        ln.textContent = hit.line;
        const tx = document.createElement("span");
        tx.className = "sr-text";
        tx.innerHTML = highlightLine(hit.text, hit.col, hit.len);
        row.append(ln, tx);
        row.onclick = () => openFile(g.path, true, { line: hit.line });
        hitsEl.appendChild(row);
      }
      groupEl.appendChild(hitsEl);
      list.appendChild(groupEl);
    }
  }

  // 整行文本 + 匹配段高亮（col 起、len 长）
  function highlightLine(text, col, len) {
    if (col == null || len == null || col < 0) return esc(text);
    // 后端 col/len 是 Python 码位下标；用 Array.from 按码位切分(而非 UTF-16 半代理对)，
    // 否则行内星平面字符(emoji/罕见汉字)前导时高亮段错位、甚至切出乱码 U+FFFD
    const cps = Array.from(text);
    const before = cps.slice(0, col).join("");
    const mid = cps.slice(col, col + len).join("");
    const after = cps.slice(col + len).join("");
    return esc(before) + `<span class="sr-mark">${esc(mid)}</span>` + esc(after);
  }

  function scheduleSearch() {
    if (!workspaceOpen) {
      renderWorkspaceDisabled();
      return;
    }
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  }

  function renderWorkspaceDisabled() {
    clearTimeout(searchTimer);
    searchSeq++;
    const summary = el("search-summary");
    const list = el("search-results");
    if (summary) summary.textContent = "请先打开工作区再搜索";
    if (list) list.innerHTML = "";
  }

  function updateSearchAvailability() {
    const input = el("search-input");
    const caseBtn = el("search-case");
    const regexBtn = el("search-regex");
    const disabled = !workspaceOpen;
    if (input) {
      input.disabled = disabled;
      input.title = disabled ? "请先打开工作区" : "搜索全文";
      if (disabled) input.value = "";
    }
    [caseBtn, regexBtn].forEach(btn => {
      if (!btn) return;
      btn.disabled = disabled;
      btn.title = disabled ? "请先打开工作区" : btn.title;
    });
    if (disabled) renderWorkspaceDisabled();
  }

  function initSearch() {
    const input = el("search-input");
    const caseBtn = el("search-case");
    const regexBtn = el("search-regex");
    if (!input) return;

    input.addEventListener("input", scheduleSearch);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); runSearch(); }
    });
    caseBtn.addEventListener("click", () => {
      sState.case = !sState.case;
      caseBtn.classList.toggle("active", sState.case);
      runSearch();
    });
    regexBtn.addEventListener("click", () => {
      sState.regex = !sState.regex;
      regexBtn.classList.toggle("active", sState.regex);
      runSearch();
    });
    updateSearchAvailability();
    window.addEventListener("wb:workspace-state", (e) => {
      workspaceOpen = !!(e.detail && e.detail.hasWorkspace);
      updateSearchAvailability();
    });
  }

  window.initSearch = initSearch;
  // 切到搜索视图时自动聚焦输入框
  window.focusSearchInput = function () {
    const input = el("search-input");
    if (input && !input.disabled) setTimeout(() => input.focus(), 0);
  };
})();
