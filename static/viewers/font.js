/* 字体预览查看器（ttf/otf/woff/woff2）——纯前端，无第三方库。
 *
 * 用 FontFace API 动态加载字体文件并 document.fonts.add，加载完成后在 host 内
 * 用该字体渲染：大号字样标题 + 多字号中英文 pangram + 字符表格。样式跟随主题
 * （全部用 style.css 的 CSS 变量），深浅色都好看。
 *
 * 契约见 static/viewers/_registry.js：mount(host,{path,name,ext}) / unmount() / onTheme(t)。
 */
(function () {
  "use strict";

  if (typeof window.registerViewer !== "function") return;

  var STYLE_ID = "font-viewer-style";

  // 一次性注入作用域样式（带 STYLE_ID，unmount 不强删——多次 mount 复用即可）。
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      ".fontv { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;",
      "  overflow: auto; padding: 24px 28px 48px; gap: 26px; }",
      ".fontv-head { display: flex; flex-direction: column; gap: 4px;",
      "  padding-bottom: 16px; border-bottom: 1px solid var(--border-soft); }",
      ".fontv-name { font-size: 13px; color: var(--muted); letter-spacing: .3px;",
      "  font-family: 'Inter','Segoe UI',system-ui,sans-serif; word-break: break-all; }",
      ".fontv-title { font-size: 56px; line-height: 1.15; color: var(--text);",
      "  margin: 6px 0 2px; word-break: break-word; }",
      ".fontv-meta { font-size: 12px; color: var(--muted);",
      "  font-family: 'Inter','Segoe UI',system-ui,sans-serif; }",
      ".fontv-status { font-size: 13px; color: var(--text-dim);",
      "  font-family: 'Inter','Segoe UI',system-ui,sans-serif; }",
      ".fontv-status.err { color: var(--danger); }",
      ".fontv-section { display: flex; flex-direction: column; gap: 14px; }",
      ".fontv-section h3 { margin: 0; font-size: 12px; font-weight: 600;",
      "  text-transform: uppercase; letter-spacing: 1px; color: var(--muted);",
      "  font-family: 'Inter','Segoe UI',system-ui,sans-serif; }",
      ".fontv-row { display: flex; flex-direction: column; gap: 3px; }",
      ".fontv-row .sz { font-size: 11px; color: var(--muted);",
      "  font-family: 'Inter','Segoe UI',system-ui,sans-serif; }",
      ".fontv-sample { color: var(--text); line-height: 1.3; word-break: break-word; }",
      ".fontv-grid { display: grid;",
      "  grid-template-columns: repeat(auto-fill, minmax(46px, 1fr)); gap: 6px; }",
      ".fontv-cell { display: flex; align-items: center; justify-content: center;",
      "  min-height: 46px; padding: 6px; font-size: 24px; color: var(--text);",
      "  background: var(--bg-soft); border: 1px solid var(--border-soft);",
      "  border-radius: 6px; transition: background .12s, border-color .12s; }",
      ".fontv-cell:hover { background: var(--hover); border-color: var(--border); }",
      ""
    ].join("\n");
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  var SIZES = [12, 16, 24, 36, 48, 72];
  var PANGRAM_EN = "The quick brown fox jumps over the lazy dog 0123456789";
  var PANGRAM_ZH = "天地玄黄宇宙洪荒日月盈昃辰宿列张";

  // 字符表：A-Z / a-z / 0-9 / 标点 / 常用汉字
  function charItems() {
    var items = [];
    var i;
    for (i = 65; i <= 90; i++) items.push(String.fromCharCode(i)); // A-Z
    for (i = 97; i <= 122; i++) items.push(String.fromCharCode(i)); // a-z
    for (i = 48; i <= 57; i++) items.push(String.fromCharCode(i)); // 0-9
    var punct = "! ? . , ; : ' \" ( ) [ ] { } - _ + = / \\ | @ # $ % ^ & * < > ~ `".split(" ");
    items = items.concat(punct);
    // 常用汉字（含全角标点）
    var han = ("天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏" +
      "永和九年岁在癸丑暮春之初会于山阴" +
      "中文字体预览测试一二三四五六七八九十" +
      "，。、；：？！“”（）《》").split("");
    items = items.concat(han);
    return items;
  }

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function makeViewer() {
    var state = null; // { face, host, mounted }

    function cleanup(session) {
      var target = session || state;
      if (!target) return;
      if (target.face) {
        try { document.fonts.delete(target.face); } catch (e) {}
      }
      if (target.host) {
        try { target.host.innerHTML = ""; } catch (e) {}
      }
      if (!session || state === session) {
        state = null;
      }
    }

    function isCurrentSession(session, root) {
      return !!(session && state === session && session.host && session.host.contains(root));
    }

    return {
      exts: ["ttf", "otf", "woff", "woff2"],
      label: "Font",

      mount: function (host, info) {
        ensureStyle();
        cleanup();

        var root = el("div", "fontv");
        host.appendChild(root);

        var family = "PreviewFont-" + Math.random().toString(36).slice(2, 10);
        var session = { face: null, host: host, family: family, root: root };
        state = session;

        // 顶部信息 + 加载状态
        var head = el("div", "fontv-head");
        var title = el("div", "fontv-title");
        title.textContent = (info && info.name) || "字体预览";
        var nameLine = el("div", "fontv-name", (info && info.name) || "");
        var status = el("div", "fontv-status");
        status.textContent = "正在加载字体…";
        head.appendChild(nameLine);
        head.appendChild(title);
        head.appendChild(status);
        root.appendChild(head);
        if (window.wbViewer && typeof window.wbViewer.reportLoading === "function") {
          window.wbViewer.reportLoading(host, "字体正在加载，暂不能创建验证任务");
        }

        var url = window.rawUrl(info.path);
        var face;
        try {
          face = new FontFace(family, "url(" + JSON.stringify(url) + ")");
          session.pendingFace = face;
        } catch (e) {
          if (!isCurrentSession(session, root)) return;
          if (window.wbViewer && typeof window.wbViewer.reportError === "function") {
            window.wbViewer.reportError(host, e);
          }
          status.className = "fontv-status err";
          status.textContent = "无法创建字体：" + (e && e.message ? e.message : e);
          return;
        }

        face.load().then(function (loaded) {
          // mount 期间可能已被 unmount/切换
          if (!isCurrentSession(session, root)) {
            try { document.fonts.delete(loaded); } catch (e) {}
            return;
          }
          document.fonts.add(loaded);
          session.face = loaded;

          status.textContent = "已加载";
          title.style.fontFamily = "'" + family + "'";

          // 字号样本区
          var samples = el("div", "fontv-section");
          samples.appendChild(el("h3", null, "字号 / Sizes"));
          SIZES.forEach(function (sz) {
            var row = el("div", "fontv-row");
            row.appendChild(el("div", "sz", sz + "px"));
            var s = el("div", "fontv-sample");
            s.style.fontFamily = "'" + family + "'";
            s.style.fontSize = sz + "px";
            s.textContent = PANGRAM_ZH + "  " + PANGRAM_EN;
            row.appendChild(s);
            samples.appendChild(row);
          });
          root.appendChild(samples);

          // 字符表区
          var chars = el("div", "fontv-section");
          chars.appendChild(el("h3", null, "字符表 / Glyphs"));
          var grid = el("div", "fontv-grid");
          charItems().forEach(function (c) {
            var cell = el("div", "fontv-cell");
            cell.style.fontFamily = "'" + family + "'";
            cell.title = c;
            cell.textContent = c;
            grid.appendChild(cell);
          });
          chars.appendChild(grid);
          root.appendChild(chars);
          if (window.wbViewer && typeof window.wbViewer.reportReady === "function") {
            window.wbViewer.reportReady(host);
          }
        }).catch(function (err) {
          if (!isCurrentSession(session, root)) return;
          if (window.wbViewer && typeof window.wbViewer.reportError === "function") {
            window.wbViewer.reportError(host, err);
          }
          status.className = "fontv-status err";
          status.textContent = "字体加载失败：" + (err && err.message ? err.message : err);
        });
      },

      unmount: function () {
        cleanup();
      },

      onTheme: function () {
        // 样式全部走 CSS 变量，主题切换无需重渲染。
      }
    };
  }

  window.registerViewer(makeViewer());
})();
