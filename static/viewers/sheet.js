/* 表格查看器（xlsx/xlsm/xls/ods/csv）——用 SheetJS 渲染为 HTML 表。
 *
 * 契约见 _registry.js：registerViewer({ exts, label, mount, unmount, onTheme })。
 * 依赖 window.fetchRaw(path) 取原始字节；SheetJS 本地 vendor，运行时按需注入一次。
 * 表格样式跟随主题（用 style.css 的 CSS 变量），深浅色都可读，带边框 + 斑马纹。
 */
(function () {
  "use strict";

  var XLSX_SRC = "/static/vendor/sheetjs/xlsx.full.min.js";
  var STYLE_ID = "wb-sheet-viewer-style";
  var _xlsxPromise = null;

  // —— 一次性确保 SheetJS 已加载 ——
  function ensureXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (_xlsxPromise) return _xlsxPromise;
    _xlsxPromise = new Promise(function (resolve, reject) {
      // 复用页面里可能已存在的同源 <script>
      var existing = document.querySelector('script[data-wb-sheet="1"]');
      if (existing) {
        existing.addEventListener("load", function () {
          window.XLSX ? resolve(window.XLSX) : reject(new Error("SheetJS 加载后未暴露 XLSX"));
        });
        existing.addEventListener("error", function () {
          reject(new Error("SheetJS 脚本加载失败"));
        });
        return;
      }
      var s = document.createElement("script");
      s.src = XLSX_SRC;
      s.async = true;
      s.setAttribute("data-wb-sheet", "1");
      s.onload = function () {
        window.XLSX ? resolve(window.XLSX) : reject(new Error("SheetJS 加载后未暴露 XLSX"));
      };
      s.onerror = function () {
        _xlsxPromise = null; // 允许后续重试
        reject(new Error("SheetJS 脚本加载失败: " + XLSX_SRC));
      };
      document.head.appendChild(s);
    });
    return _xlsxPromise;
  }

  // —— 注入一次跟随主题的表格样式 ——
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      ".wb-sheet { display:flex; flex-direction:column; height:100%; min-height:0; box-sizing:border-box; color:var(--text); background:var(--bg); }",
      ".wb-sheet-toolbar { flex:0 0 auto; display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 12px; border-bottom:1px solid var(--border); background:var(--bg-soft); font-size:13px; color:var(--text-dim); }",
      ".wb-sheet-toolbar label { color:var(--muted); }",
      ".wb-sheet-select { background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:4px 8px; font-size:13px; outline:none; cursor:pointer; }",
      ".wb-sheet-select:focus { border-color:var(--accent); }",
      ".wb-sheet-meta { color:var(--muted); margin-left:auto; }",
      ".wb-sheet-body { flex:1 1 auto; min-height:0; overflow:auto; padding:0; }",
      ".wb-sheet-body table { border-collapse:collapse; font-size:13px; color:var(--text); width:auto; }",
      ".wb-sheet-body td, .wb-sheet-body th { border:1px solid var(--border); padding:4px 10px; white-space:nowrap; vertical-align:top; max-width:480px; overflow:hidden; text-overflow:ellipsis; }",
      ".wb-sheet-body tr:nth-child(even) td { background:var(--bg-soft); }",
      ".wb-sheet-body tr:hover td { background:var(--hover); }",
      ".wb-sheet-body td b, .wb-sheet-body th { color:var(--text); font-weight:600; }",
      ".wb-sheet-empty { padding:24px; color:var(--muted); font-size:13px; }",
      ".wb-sheet-error { padding:24px; color:var(--danger); font-size:13px; white-space:pre-wrap; }"
    ].join("\n");
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  // 模块级状态：当前 mount 的工作簿/容器，供 select 切换 + unmount 清理
  var _state = null;

  function renderSheet(workbook, name, bodyEl, metaEl) {
    var XLSX = window.XLSX;
    bodyEl.innerHTML = "";
    var ws = workbook.Sheets[name];
    if (!ws) {
      var d = document.createElement("div");
      d.className = "wb-sheet-empty";
      d.textContent = "工作表为空或不存在：" + name;
      bodyEl.appendChild(d);
      if (metaEl) metaEl.textContent = "";
      return;
    }
    // sheet_to_html 生成完整 <table>（含内联属性，外层样式用 CSS 变量覆盖）
    var html = XLSX.utils.sheet_to_html(ws, { id: "wb-sheet-table", editable: false });
    bodyEl.innerHTML = html;
    // 行列计数（来自 ref，如 "A1:D20"）
    if (metaEl) {
      var dims = "";
      if (ws["!ref"]) {
        try {
          var r = XLSX.utils.decode_range(ws["!ref"]);
          var rows = r.e.r - r.s.r + 1;
          var cols = r.e.c - r.s.c + 1;
          dims = rows + " 行 × " + cols + " 列";
        } catch (e) { dims = ""; }
      }
      metaEl.textContent = dims;
    }
  }

  function mount(host, info) {
    ensureStyle();

    var root = document.createElement("div");
    root.className = "wb-sheet";

    var toolbar = document.createElement("div");
    toolbar.className = "wb-sheet-toolbar";

    var meta = document.createElement("span");
    meta.className = "wb-sheet-meta";

    var body = document.createElement("div");
    body.className = "wb-sheet-body";

    root.appendChild(toolbar);
    root.appendChild(body);
    host.appendChild(root);

    _state = { host: host, root: root, body: body, meta: meta, workbook: null, select: null };

    var loading = document.createElement("div");
    loading.className = "wb-sheet-empty";
    loading.textContent = "正在加载表格…";
    body.appendChild(loading);

    var path = info && info.path;

    Promise.all([ensureXLSX(), window.fetchRaw(path)])
      .then(function (results) {
        var XLSX = results[0];
        var buf = results[1];
        var data = new Uint8Array(buf);
        // dense:false 兼容性更好；type:'array' 自动嗅探 xlsx/xls/ods/csv 等
        var wb = XLSX.read(data, { type: "array" });
        if (!_state || _state.host !== host) return; // 已被 unmount
        _state.workbook = wb;
        body.innerHTML = "";

        var names = wb.SheetNames || [];
        if (!names.length) {
          var e = document.createElement("div");
          e.className = "wb-sheet-empty";
          e.textContent = "未找到任何工作表。";
          body.appendChild(e);
          return;
        }

        // 多表时给个切换下拉
        if (names.length > 1) {
          var lab = document.createElement("label");
          lab.textContent = "工作表：";
          var sel = document.createElement("select");
          sel.className = "wb-sheet-select";
          names.forEach(function (n, i) {
            var opt = document.createElement("option");
            opt.value = String(i);
            opt.textContent = n;
            sel.appendChild(opt);
          });
          sel.addEventListener("change", function () {
            var idx = parseInt(sel.value, 10) || 0;
            renderSheet(wb, names[idx], body, meta);
          });
          toolbar.appendChild(lab);
          toolbar.appendChild(sel);
          _state.select = sel;
        } else {
          var single = document.createElement("span");
          single.style.color = "var(--text-dim)";
          single.textContent = names[0];
          toolbar.appendChild(single);
        }
        toolbar.appendChild(meta);

        renderSheet(wb, names[0], body, meta);
      })
      .catch(function (err) {
        if (!_state || _state.host !== host) return;
        if (window.wbViewer && typeof window.wbViewer.reportError === "function") {
          window.wbViewer.reportError(host, err);
        }
        body.innerHTML = "";
        var e = document.createElement("div");
        e.className = "wb-sheet-error";
        e.textContent = "无法解析表格：" + (err && err.message ? err.message : String(err));
        body.appendChild(e);
      });
  }

  function unmount() {
    if (_state) {
      if (_state.root && _state.root.parentNode) {
        _state.root.parentNode.removeChild(_state.root);
      }
      _state.workbook = null;
      _state = null;
    }
  }

  window.registerViewer({
    exts: ["xlsx", "xlsm", "xls", "ods", "csv"],
    label: "表格",
    mount: mount,
    unmount: unmount
    // 主题随 CSS 变量自动切换，无需 onTheme
  });
})();
