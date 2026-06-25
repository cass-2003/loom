/* Workbench 多格式查看器：注册表 + 分派契约
 *
 * 这是“多格式查看器”插件基建的公共契约层。各具体查看器（pdf/sheet/docx/
 * archive/epub/font/imageplus）只需在自己的文件里调用 window.registerViewer
 * 注册一组扩展名与生命周期回调；app.js 在打开/切换文件时按扩展名分派。
 *
 * 契约（后续查看器 agent 按此消费，勿改签名）：
 *   window.registerViewer({ exts, label, mount, unmount, onTheme })
 *     - exts:   小写、无点的扩展名数组，如 ['pdf'] / ['xlsx','xls','csv']
 *     - label:  人类可读名（可选，用于 UI/调试）
 *     - mount(host, info):  host 是 #viewer-host 内一个干净容器（div），
 *                           info = { path, name, ext }；查看器在 host 内渲染。
 *     - unmount():          清理（移除事件/释放 URL 等）。可选。
 *     - onTheme(t):         主题切换，t = 'dark' | 'light'。可选。
 *   window.findViewer(ext) -> 命中的 viewer 对象，或 null。ext 大小写不敏感、可带点。
 *   window.fetchRaw(path)  -> Promise<ArrayBuffer>（GET /api/raw 原始字节）。
 *   window.rawUrl(path)    -> '/api/raw?path=' + encodeURIComponent(path)（给 <img>/<embed> 等直接用）。
 */
(function () {
  "use strict";

  // ext（无点小写）-> viewer 对象。后注册的同 ext 覆盖先注册的。
  const registry = new Map();

  function normExt(ext) {
    if (ext == null) return "";
    let e = String(ext).trim().toLowerCase();
    if (e.charAt(0) === ".") e = e.slice(1);
    return e;
  }

  window.registerViewer = function registerViewer(viewer) {
    if (!viewer || typeof viewer !== "object") return;
    const exts = Array.isArray(viewer.exts) ? viewer.exts : [];
    for (const raw of exts) {
      const e = normExt(raw);
      if (e) registry.set(e, viewer);
    }
  };

  window.findViewer = function findViewer(ext) {
    const e = normExt(ext);
    if (!e) return null;
    return registry.get(e) || null;
  };

  window.rawUrl = function rawUrl(path) {
    return "/api/raw?path=" + encodeURIComponent(path);
  };

  window.fetchRaw = function fetchRaw(path) {
    return fetch(window.rawUrl(path)).then(function (r) {
      if (!r.ok) throw new Error("fetchRaw " + r.status + " for " + path);
      return r.arrayBuffer();
    });
  };
})();
