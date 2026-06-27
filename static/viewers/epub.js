/* EPUB 电子书阅读查看器（key=epub）
 *
 * 用 epub.js（UMD，vendored 到 static/vendor/epubjs/epub.min.js，依赖全局 window.JSZip）阅读 .epub。
 * 契约见 static/viewers/_registry.js：mount(host, info) / unmount() / onTheme(t)。
 *
 * 设计：
 *   - 顶部工具栏：阅读模式切换（滚动/翻页）、上一页/下一页（翻页模式）、目录下拉。
 *   - 阅读区保持书本默认浅色背景（书页一般是浅色排版，深色硬翻会破坏正文配色），
 *     但工具栏 / 目录用 style.css 的 CSS 变量随主题走，深浅色都好看。
 */
(function () {
  "use strict";

  var EPUB_SRC = "/static/vendor/epubjs/epub.min.js";
  var _loadingPromise = null;

  // 注入并加载 epub.min.js（幂等）。成功后保证 window.ePub 可用。
  function ensureEpubJs() {
    if (window.ePub) return Promise.resolve(window.ePub);
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = new Promise(function (resolve, reject) {
      // 已有同源 script 标签则等它（避免重复注入）
      var existing = document.querySelector('script[data-epubjs="1"]');
      if (existing) {
        existing.addEventListener("load", function () {
          window.ePub ? resolve(window.ePub) : reject(new Error("epub.js 加载后未暴露 ePub"));
        });
        existing.addEventListener("error", function () {
          reject(new Error("epub.js 脚本加载失败"));
        });
        return;
      }
      var s = document.createElement("script");
      s.src = EPUB_SRC;
      s.async = true;
      s.setAttribute("data-epubjs", "1");
      s.onload = function () {
        if (window.ePub) resolve(window.ePub);
        else reject(new Error("epub.js 加载后未暴露 ePub"));
      };
      s.onerror = function () { reject(new Error("epub.js 脚本加载失败")); };
      document.head.appendChild(s);
    });
    return _loadingPromise;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // 内联样式：不依赖 style.css 里没有的类，只复用其 CSS 变量，深浅色都好看。
  var STYLE_ID = "epub-viewer-style";
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      ".epub-viewer{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;}",
      ".epub-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;",
      "  padding:6px 10px;border-bottom:1px solid var(--border-soft);",
      "  background:var(--bg2);color:var(--text);flex-shrink:0;}",
      ".epub-toolbar button{font:inherit;cursor:pointer;padding:4px 10px;border-radius:6px;",
      "  background:var(--panel);color:var(--text);border:1px solid var(--border);}",
      ".epub-toolbar button:hover:not(:disabled){background:var(--hover,rgba(127,127,127,.16));}",
      ".epub-toolbar button:disabled{opacity:.45;cursor:not-allowed;}",
      ".epub-toolbar select{font:inherit;padding:4px 8px;border-radius:6px;max-width:260px;",
      "  background:var(--panel);color:var(--text);border:1px solid var(--border);}",
      ".epub-toolbar select:disabled{opacity:.55;cursor:not-allowed;}",
      ".epub-toolbar .epub-spacer{flex:1;}",
      ".epub-toolbar .epub-title{color:var(--text-dim);font-size:12px;overflow:hidden;",
      "  text-overflow:ellipsis;white-space:nowrap;max-width:320px;}",
      // 阅读区：白底书页，居中，深色界面下也是浅色书页（书本默认排版）
      ".epub-reader{flex:1;min-width:0;min-height:0;overflow:auto;background:#fafafa;",
      "  display:flex;justify-content:center;}",
      ".epub-reader .epub-area{width:100%;max-width:900px;background:#fff;}",
      ".epub-msg{margin:auto;padding:20px;color:var(--text-dim);text-align:center;}"
    ].join("\n");
    var st = el("style");
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ---- 查看器实例状态（mount/unmount 之间共享） ----
  var book = null;
  var rendition = null;
  var flow = "scrolled-doc"; // 'scrolled-doc' | 'paginated'
  var areaEl = null;
  var btnPrev = null;
  var btnNext = null;
  var btnMode = null;
  var tocSel = null;
  var keyHandler = null;
  var loadState = "idle"; // idle | loading | ready | error

  function setControlState(el, disabled, enabledTitle, disabledReason) {
    if (!el) return;
    el.disabled = !!disabled;
    el.setAttribute("aria-disabled", disabled ? "true" : "false");
    el.title = disabled ? (disabledReason || "当前不可用") : enabledTitle;
  }

  function updateToolbarState() {
    var loading = loadState === "loading" || loadState === "idle";
    var ready = loadState === "ready" && !!rendition;
    var failed = loadState === "error";
    var baseReason = failed ? "电子书加载失败" : "电子书尚未加载完成";
    setControlState(
      btnMode,
      !ready,
      "在滚动 / 翻页之间切换",
      baseReason
    );
    var paginated = ready && flow === "paginated";
    setControlState(
      btnPrev,
      !paginated,
      "上一页",
      ready ? "当前为滚动模式，请先切换到翻页模式" : baseReason
    );
    setControlState(
      btnNext,
      !paginated,
      "下一页",
      ready ? "当前为滚动模式，请先切换到翻页模式" : baseReason
    );
    var hasToc = !!(tocSel && tocSel.querySelector("option[value]:not([value=''])"));
    setControlState(
      tocSel,
      !ready || !hasToc,
      "目录",
      ready ? "该电子书没有可用目录" : baseReason
    );
    if (loading && tocSel) tocSel.title = "目录加载中…";
  }

  function rebuildRendition() {
    if (!book || !areaEl) return;
    if (rendition) {
      try { rendition.destroy(); } catch (e) { /* ignore */ }
      rendition = null;
    }
    areaEl.innerHTML = "";
    rendition = book.renderTo(areaEl, {
      width: "100%",
      height: "100%",
      flow: flow,
      spread: (flow === "paginated") ? "auto" : "none"
    });
    updateToolbarState();
    return rendition.display();
  }

  function mount(host, info) {
    ensureStyle();

    var root = el("div", "epub-viewer");
    var toolbar = el("div", "epub-toolbar");

    // 模式切换
    btnMode = el("button", null, "翻页模式");
    btnMode.title = "在滚动 / 翻页之间切换";

    btnPrev = el("button", null, "‹ 上一页");
    btnNext = el("button", null, "下一页 ›");

    // 目录
    tocSel = document.createElement("select");
    tocSel.title = "目录";
    var optDefault = el("option", null, "目录");
    optDefault.value = "";
    optDefault.disabled = true;
    optDefault.selected = true;
    tocSel.appendChild(optDefault);

    var spacer = el("div", "epub-spacer");
    var titleEl = el("div", "epub-title", (info && info.name) || "");

    toolbar.appendChild(btnMode);
    toolbar.appendChild(btnPrev);
    toolbar.appendChild(btnNext);
    toolbar.appendChild(tocSel);
    toolbar.appendChild(spacer);
    toolbar.appendChild(titleEl);

    var reader = el("div", "epub-reader");
    areaEl = el("div", "epub-area");
    reader.appendChild(areaEl);

    var msg = el("div", "epub-msg", "正在加载电子书…");
    reader.appendChild(msg);

    root.appendChild(toolbar);
    root.appendChild(reader);
    host.appendChild(root);

    // 翻页按钮 / 键盘
    btnPrev.addEventListener("click", function () {
      if (btnPrev.disabled || !rendition) return;
      rendition.prev();
    });
    btnNext.addEventListener("click", function () {
      if (btnNext.disabled || !rendition) return;
      rendition.next();
    });
    keyHandler = function (ev) {
      if (flow !== "paginated" || !rendition) return;
      if (ev.key === "ArrowLeft") { rendition.prev(); }
      else if (ev.key === "ArrowRight") { rendition.next(); }
    };
    document.addEventListener("keydown", keyHandler);

    // 模式切换
    btnMode.addEventListener("click", function () {
      if (btnMode.disabled || !book) return;
      if (flow === "scrolled-doc") {
        flow = "paginated";
        btnMode.textContent = "滚动模式";
      } else {
        flow = "scrolled-doc";
        btnMode.textContent = "翻页模式";
      }
      updateToolbarState();
      rebuildRendition();
    });

    // 目录跳转
    tocSel.addEventListener("change", function () {
      if (tocSel.disabled) return;
      var href = tocSel.value;
      if (href && rendition) rendition.display(href);
    });

    loadState = "loading";
    updateToolbarState();

    // 加载 epub.js → 取原始字节 → 渲染
    ensureEpubJs()
      .then(function (ePub) {
        return window.fetchRaw(info.path).then(function (buf) {
          book = ePub(buf);
          return rebuildRendition().then(function () {
            loadState = "ready";
            updateToolbarState();
            try { reader.removeChild(msg); } catch (e) { /* already gone */ }
          });
        }).then(function () {
          // 目录
          return book.loaded.navigation.then(function (nav) {
            var toc = (nav && nav.toc) || [];
            function addItems(items, depth) {
              for (var i = 0; i < items.length; i++) {
                var it = items[i];
                var opt = el("option", null,
                  (depth ? new Array(depth + 1).join(" ") : "") + (it.label || "").trim());
                opt.value = it.href || "";
                tocSel.appendChild(opt);
                if (it.subitems && it.subitems.length) addItems(it.subitems, depth + 1);
              }
            }
            addItems(toc, 0);
            updateToolbarState();
          }).catch(function () { /* 无目录不致命 */ });
        });
      })
      .catch(function (err) {
        loadState = "error";
        if (window.wbViewer && typeof window.wbViewer.reportError === "function") {
          window.wbViewer.reportError(host, err);
        }
        updateToolbarState();
        msg.textContent = "电子书加载失败：" + (err && err.message || err);
      });
  }

  function unmount() {
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
    if (rendition) {
      try { rendition.destroy(); } catch (e) { /* ignore */ }
      rendition = null;
    }
    if (book) {
      try { book.destroy(); } catch (e) { /* ignore */ }
      book = null;
    }
    areaEl = null;
    btnPrev = null;
    btnNext = null;
    btnMode = null;
    tocSel = null;
    flow = "scrolled-doc";
    loadState = "idle";
  }

  // 阅读区保持书页默认浅色，主题切换不强行改书页背景，避免破坏正文排版配色。
  // 工具栏 / 目录已用 CSS 变量随主题自动跟随，故此处无需额外处理。
  function onTheme(/* t */) { /* no-op：书页保持默认浅色 */ }

  if (typeof window.registerViewer === "function") {
    window.registerViewer({
      exts: ["epub"],
      label: "EPUB 电子书",
      mount: mount,
      unmount: unmount,
      onTheme: onTheme
    });
  }
})();
