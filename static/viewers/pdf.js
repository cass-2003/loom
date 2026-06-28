/* PDF 查看器（key=pdf）
 *
 * 用 iframe 内嵌 vendor 的 pdf.js 通用查看器（static/vendor/pdfjs/viewer.html，
 * 解包自 vscode-office 插件，运行期完全离线）。
 *
 * 加载原理：
 *   viewer.html 里的 viewer.js 是标准 pdf.js 通用查看器，webViewerInitialized()
 *   会读取 URL 的 ?file= 参数并自动 PDFViewerApplication.open(file)。
 *   我们把 file 设成 window.rawUrl(info.path)，即同源相对地址
 *   '/api/raw?path=...'。pdf.js 的 validateFileURL 要求 file 与查看器同源
 *   （或 blob:），同源相对地址天然满足，校验通过。
 *   server 的 mimetypes 对 .pdf 猜得到 application/pdf，pdf.js 按响应内容解析，
 *   不依赖后缀。worker 由 viewer.html 内联 <script src="pdf.worker.js"> 提供
 *   （fake worker，主线程跑），不会去 fetch 默认的 ../build/pdf.worker.js。
 *
 * 注：app.js 的 unmountViewer 调用 unmount() 不传参，且会自己清空 #viewer-host，
 *   所以这里用模块级引用记住最近的 iframe，unmount 主动置 about:blank 释放 pdf.js。
 */
(function () {
  "use strict";

  if (typeof window.registerViewer !== "function") return;

  // viewer.html 所在目录。相对引用（viewer.js/css、pdf.worker.js、locale、
  // images、lib/vscode.js）都按此目录解析。
  var VIEWER_BASE = "/static/vendor/pdfjs/viewer.html";

  // 记住当前挂载会话，供无参 unmount() 释放并让旧 iframe 回调失效。
  var currentIframe = null;
  var currentSession = null;

  function buildSrc(path) {
    // file 用同源相对地址，交给 pdf.js 通用查看器的 ?file= 自动打开逻辑。
    // 对整个 rawUrl 再 encodeURIComponent 一次，使其作为单个查询值塞进
    // file=，避免 rawUrl 内部的 ?/& 干扰 viewer.html 自己的 query 解析。
    var raw = window.rawUrl(path); // '/api/raw?path=<encoded>'
    return VIEWER_BASE + "?file=" + encodeURIComponent(raw);
  }

  function releaseCurrent() {
    if (currentSession && currentSession.timer) {
      clearInterval(currentSession.timer);
    }
    if (currentSession && currentSession.timeout) {
      clearTimeout(currentSession.timeout);
    }
    currentSession = null;
    if (currentIframe) {
      try {
        currentIframe.src = "about:blank";
      } catch (e) {}
      currentIframe = null;
    }
  }

  function isCurrentSession(session, host) {
    return !!(session && currentSession === session && session.host === host && document.body.contains(host));
  }

  function setLoading(host, text) {
    var overlay = host.querySelector(".viewer-pdf-loading");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "viewer-pdf-loading";
      overlay.setAttribute("role", "status");
      overlay.setAttribute("aria-live", "polite");
      host.appendChild(overlay);
    }
    overlay.textContent = text || "PDF 正在加载…";
  }

  function clearLoading(host) {
    var overlay = host.querySelector(".viewer-pdf-loading");
    if (overlay) overlay.remove();
  }

  function reportLoading(host) {
    if (window.wbViewer && typeof window.wbViewer.reportLoading === "function") {
      window.wbViewer.reportLoading(host, "PDF 正在加载，暂不能创建验证任务");
    }
  }

  function reportReady(host) {
    if (window.wbViewer && typeof window.wbViewer.reportReady === "function") {
      window.wbViewer.reportReady(host);
    }
  }

  function reportError(host, err) {
    if (window.wbViewer && typeof window.wbViewer.reportError === "function") {
      window.wbViewer.reportError(host, err);
    }
  }

  function markReady(session) {
    if (!isCurrentSession(session, session.host) || session.ready) return;
    session.ready = true;
    if (session.timer) clearInterval(session.timer);
    if (session.timeout) clearTimeout(session.timeout);
    clearLoading(session.host);
    reportReady(session.host);
  }

  function markFailed(session, message) {
    if (!isCurrentSession(session, session.host) || session.failed) return;
    session.failed = true;
    if (session.timer) clearInterval(session.timer);
    if (session.timeout) clearTimeout(session.timeout);
    clearLoading(session.host);
    reportError(session.host, new Error(message || "PDF 加载失败"));
  }

  function maybeMarkReady(session) {
    if (!isCurrentSession(session, session.host) || session.failed || session.ready) return;
    if (session.preflightOk && session.frameLoaded) markReady(session);
  }

  function looksLikePdf(bytes) {
    if (!bytes || bytes.length < 5) return false;
    var limit = Math.min(bytes.length - 4, 1024);
    for (var i = 0; i < limit; i++) {
      if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
        return true;
      }
    }
    return false;
  }

  function preflightPdf(session, path) {
    if (!path) {
      markFailed(session, "缺少 PDF 文件路径");
      return;
    }
    fetch(window.rawUrl(path)).then(function (res) {
      if (!res.ok) throw new Error("PDF 文件读取失败: HTTP " + res.status);
      if (!res.body || typeof res.body.getReader !== "function") {
        return res.arrayBuffer().then(function (buf) {
          return new Uint8Array(buf).slice(0, 1024);
        });
      }
      var reader = res.body.getReader();
      return reader.read().then(function (chunk) {
        try { reader.cancel(); } catch (e) {}
        return chunk && chunk.value ? chunk.value : new Uint8Array();
      });
    }).then(function (bytes) {
      if (!isCurrentSession(session, session.host)) return;
      if (!looksLikePdf(bytes)) {
        markFailed(session, "文件内容不是有效的 PDF");
        return;
      }
      session.preflightOk = true;
      if (!session.frameLoaded) setLoading(session.host, "PDF 文件已校验，等待查看器加载…");
      maybeMarkReady(session);
    }).catch(function (err) {
      if (!isCurrentSession(session, session.host)) return;
      markFailed(session, err && err.message ? err.message : "PDF 文件读取失败");
    });
  }

  function startTimeout(session) {
    session.timeout = setTimeout(function () {
      markFailed(session, "PDF 加载超时或查看器框架不可访问");
    }, 45000);
  }

  window.registerViewer({
    exts: ["pdf"],
    label: "PDF",
    mount: function (host, info) {
      // 先释放上一个（防御性；app.js 通常已先 unmount）。
      releaseCurrent();

      // 清空容器并放一个充满的 iframe。
      while (host.firstChild) host.removeChild(host.firstChild);

      var iframe = document.createElement("iframe");
      iframe.className = "viewer-pdf-iframe";
      iframe.setAttribute("title", (info && info.name) || "PDF");
      // 充满 host：用内联样式，不依赖外部 CSS（并行约束下不改 style.css）。
      iframe.style.position = "absolute";
      iframe.style.top = "0";
      iframe.style.left = "0";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.border = "0";
      iframe.style.display = "block";
      iframe.style.background = "var(--bg, #fff)";
      iframe.setAttribute(
        "allow",
        "fullscreen; clipboard-read; clipboard-write"
      );

      // host 需相对定位，绝对定位的 iframe 才能充满。
      try {
        var pos = window.getComputedStyle(host).position;
        if (pos === "static" || !pos) host.style.position = "relative";
      } catch (e) {
        host.style.position = "relative";
      }

      setLoading(host, "PDF 正在加载…");
      reportLoading(host);
      var session = {
        host: host,
        iframe: iframe,
        ready: false,
        failed: false,
        frameLoaded: false,
        preflightOk: false,
        timer: null,
        timeout: null,
      };
      currentSession = session;

      iframe.addEventListener("load", function () {
        if (!isCurrentSession(session, host)) return;
        if (session.failed) return;
        session.frameLoaded = true;
        if (!session.preflightOk) setLoading(host, "PDF 查看器已打开，校验文件…");
        maybeMarkReady(session);
      });
      iframe.addEventListener("error", function () {
        markFailed(session, "PDF 查看器框架加载失败");
      });

      iframe.src = buildSrc(info && info.path);
      host.appendChild(iframe);
      currentIframe = iframe;
      startTimeout(session);
      preflightPdf(session, info && info.path);
    },
    unmount: function () {
      // app.js 调用时不传参，且随后会清空 #viewer-host；这里主动停掉 pdf.js。
      releaseCurrent();
    },
  });
})();
