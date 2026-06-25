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

  // 记住当前挂载的 iframe，供无参 unmount() 释放。
  var currentIframe = null;

  function buildSrc(path) {
    // file 用同源相对地址，交给 pdf.js 通用查看器的 ?file= 自动打开逻辑。
    // 对整个 rawUrl 再 encodeURIComponent 一次，使其作为单个查询值塞进
    // file=，避免 rawUrl 内部的 ?/& 干扰 viewer.html 自己的 query 解析。
    var raw = window.rawUrl(path); // '/api/raw?path=<encoded>'
    return VIEWER_BASE + "?file=" + encodeURIComponent(raw);
  }

  function releaseCurrent() {
    if (currentIframe) {
      try {
        currentIframe.src = "about:blank";
      } catch (e) {}
      currentIframe = null;
    }
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

      iframe.src = buildSrc(info && info.path);
      host.appendChild(iframe);
      currentIframe = iframe;
    },
    unmount: function () {
      // app.js 调用时不传参，且随后会清空 #viewer-host；这里主动停掉 pdf.js。
      releaseCurrent();
    },
  });
})();
