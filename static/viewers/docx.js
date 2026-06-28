/* Word 文档查看器（docx/dotx）。
 *
 * 用 docx-preview（UMD，全局 window.docx）把 .docx 渲染成 HTML。
 * 依赖 JSZip——基建已全局加载 window.JSZip（docx-preview UMD 包装会读 window.JSZip）。
 *
 * 契约见 static/viewers/_registry.js：registerViewer({ exts, label, mount, unmount, onTheme })。
 * 严禁改动 app.js / index.html / server.py / _registry.js；本文件只负责 docx 渲染。
 */
(function () {
  "use strict";

  var SCRIPT_SRC = "/static/vendor/docx-preview/docx-preview.min.js";
  var _loadPromise = null;
  var STYLE_ID = "docx-viewer-style";

  // 只注入一次：外围用主题变量（深浅色都好看），文档区用浅色「纸张」。
  // 不改 style.css，把样式限定在 .docx-viewer-host 内，避免污染全局。
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      ".docx-viewer-host{",
      "  width:100%;height:100%;box-sizing:border-box;overflow:auto;",
      "  background:var(--editor-bg,var(--bg,#1e1e1e));",
      "  color:var(--fg,#ccc);",
      "  padding:24px;display:flex;flex-direction:column;align-items:center;",
      "}",
      // .docx-paper：透明 flex 容器，真正的「纸张」是 docx-preview 注入的 section.docx 每页。
      ".docx-viewer-host .docx-paper{",
      "  background:transparent;max-width:100%;display:flex;flex-direction:column;align-items:center;",
      "}",
      // docx-preview 自身会注入 .docx-wrapper（页面背景灰）/ section.docx（每页纸）。
      // 让其包裹层透明，由外围 host 的主题色衬托。
      ".docx-viewer-host .docx-wrapper{",
      "  background:transparent;padding:0;display:flex;flex-direction:column;align-items:center;",
      "}",
      // 每页纸：白底深字，深浅色下都是浅色纸张，加阴影区分出纸面。
      ".docx-viewer-host .docx-wrapper>section.docx{",
      "  background:#fff;color:#111;margin-bottom:16px;",
      "  box-shadow:0 2px 12px rgba(0,0,0,.4);border-radius:2px;",
      "}",
      ".docx-viewer-msg{",
      "  margin:auto;padding:16px 20px;font-size:13px;line-height:1.5;",
      "  color:var(--fg-muted,var(--fg,#aaa));text-align:center;",
      "}",
      ".docx-viewer-msg-error{color:var(--danger,#e06c75);}",
    ].join("\n");
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // 注入并加载 docx-preview UMD（只注入一次），resolve 时保证 window.docx.renderAsync 存在。
  function ensureDocxLib() {
    if (window.docx && typeof window.docx.renderAsync === "function") {
      return Promise.resolve(window.docx);
    }
    if (_loadPromise) return _loadPromise;

    _loadPromise = new Promise(function (resolve, reject) {
      // 复用已存在的 <script>（可能正在加载中）
      var existing = document.querySelector(
        'script[src="' + SCRIPT_SRC + '"]'
      );
      function done() {
        if (window.docx && typeof window.docx.renderAsync === "function") {
          resolve(window.docx);
        } else {
          reject(new Error("docx-preview 加载完成但未暴露 window.docx.renderAsync"));
        }
      }
      if (existing) {
        if (window.docx && typeof window.docx.renderAsync === "function") {
          resolve(window.docx);
          return;
        }
        existing.addEventListener("load", done, { once: true });
        existing.addEventListener(
          "error",
          function () {
            reject(new Error("docx-preview 脚本加载失败：" + SCRIPT_SRC));
          },
          { once: true }
        );
        return;
      }
      var s = document.createElement("script");
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = done;
      s.onerror = function () {
        _loadPromise = null; // 允许下次重试
        reject(new Error("docx-preview 脚本加载失败：" + SCRIPT_SRC));
      };
      document.head.appendChild(s);
    });
    return _loadPromise;
  }

  // 渲染期间用于跟踪当前 mount，避免切换文件后旧的异步渲染把内容写回新容器。
  var _session = null;

  function isCurrentSession(session, host) {
    return !!(session && _session === session && session.host === host && document.body.contains(host));
  }

  function showMessage(host, text, isError) {
    host.innerHTML = "";
    var box = document.createElement("div");
    box.className = "docx-viewer-msg" + (isError ? " docx-viewer-msg-error" : "");
    box.textContent = text;
    host.appendChild(box);
  }

  var viewer = {
    exts: ["docx", "dotx"],
    label: "Word 文档",

    mount: function mount(host, info) {
      var path = info && info.path;
      var session = { host: host, path: path };
      _session = session;

      ensureStyle();
      // host：外围用主题色背景，内部 .docx-paper 包裹文档为浅色纸张。
      host.classList.add("docx-viewer-host");
      showMessage(host, "正在加载 Word 文档…", false);

      ensureDocxLib()
        .then(function (docx) {
          if (!isCurrentSession(session, host)) return; // 已切换到别的文件
          if (!path) throw new Error("缺少文件路径");
          return window.fetchRaw(path).then(function (buf) {
            if (!isCurrentSession(session, host)) return;
            var blob = new Blob([buf], {
              type:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            });

            // 清空占位消息，建好 纸张 容器
            if (!isCurrentSession(session, host)) return;
            host.innerHTML = "";
            var paper = document.createElement("div");
            paper.className = "docx-paper";
            host.appendChild(paper);
            session.paper = paper;

            // styleContainer 与 内容容器 同为 paper：把 docx-preview 注入的样式
            // 限定在纸张内，避免污染全局/被深色主题影响。
            return docx
              .renderAsync(blob, paper, paper, {
                className: "docx",
                inWrapper: true,
                ignoreWidth: false,
                ignoreHeight: false,
                breakPages: true,
                experimental: false,
                useBase64URL: true,
                renderHeaders: true,
                renderFooters: true,
                renderFootnotes: true,
                renderEndnotes: true,
                trimXmlDeclaration: true,
              })
              .then(function () {
                if (!isCurrentSession(session, host)) return;
                // 渲染成功
              });
          });
        })
        .catch(function (err) {
          if (!isCurrentSession(session, host)) return;
          if (window.wbViewer && typeof window.wbViewer.reportError === "function") {
            window.wbViewer.reportError(host, err);
          }
          showMessage(
            host,
            "无法渲染该 Word 文档：" + (err && err.message ? err.message : err),
            true
          );
        });
    },

    unmount: function unmount() {
      // 让进行中的异步渲染失效；实际 DOM 由 app.js 清空 #viewer-host。
      _session = null;
    },
  };

  if (typeof window.registerViewer === "function") {
    window.registerViewer(viewer);
  }
})();
