/* splitter.js — VS Code 风格可拖拽分隔条
 *
 * 三根分隔条，全部纯前端、零依赖、尺寸持久化到 localStorage（wb- 前缀）：
 *   1) #sidebar-resizer        竖向：侧边栏宽度    键 wb-sidebar-w     范围 160~640px
 *   2) #term-resizer           横向：终端面板高度  键 wb-term-h        范围 80px~70vh（仅终端展开时可拖）
 *   3) #editor-split-resizer   竖向：编辑/预览分屏  键 wb-edit-split    范围 15%~85%（仅 Markdown 分屏模式可拖）
 *
 * 拖动期间在最上层盖一层 position:fixed 透明遮罩，接管 mousemove/mouseup，
 * 防止 xterm / iframe（查看器）吞掉鼠标事件。
 * 拖完后触发一次 window 'resize'，让 xterm 等自适应（terminal.js 监听了 resize → relayout）。
 */
(function () {
  "use strict";
  function $(s) { return document.querySelector(s); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // 拖动遮罩：盖住整个视口，吃掉 mousemove/mouseup，并显示正确光标
  let overlay = null;
  function showOverlay(cursor) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "wb-drag-overlay";
      document.body.appendChild(overlay);
    }
    overlay.style.cursor = cursor;
    overlay.style.display = "block";
  }
  function hideOverlay() {
    if (overlay) overlay.style.display = "none";
  }

  // 拖完通知终端等自适应
  function fireResize() {
    if (typeof window.termRefit === "function") { try { window.termRefit(); } catch {} }
    try { window.dispatchEvent(new Event("resize")); } catch {}
  }

  /* 通用拖拽绑定。
   * opts.handle   分隔条元素
   * opts.cursor   "col-resize" | "row-resize"
   * opts.onMove(e) 拖动中：根据鼠标算尺寸并应用
   * opts.onEnd()   松手：持久化
   * opts.canDrag() 可选：返回 false 则忽略本次按下（如终端折叠时）
   */
  function bindDrag(opts) {
    const handle = opts.handle;
    if (!handle) return;
    let dragging = false;
    handle.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      if (opts.canDrag && !opts.canDrag()) return;
      dragging = true;
      e.preventDefault();
      handle.classList.add("dragging");
      showOverlay(typeof opts.cursor === "function" ? opts.cursor() : opts.cursor);
    });
    function move(e) {
      if (!dragging) return;
      opts.onMove(e);
    }
    function up() {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      hideOverlay();
      if (opts.onEnd) opts.onEnd();
      fireResize();
    }
    // 同时监听 window 与 overlay：overlay 在最上层接管，window 兜底
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // ---------- 1) 侧边栏宽度 ----------
  function initSidebar() {
    const sidebar = $("#sidebar"), handle = $("#sidebar-resizer");
    if (!sidebar || !handle) return;
    const MIN = 160, MAX = 640;
    const saved = parseInt(localStorage.getItem("wb-sidebar-w") || "", 10);
    if (saved >= MIN && saved <= MAX) sidebar.style.width = saved + "px";
    bindDrag({
      handle, cursor: "col-resize",
      onMove: function (e) {
        let w = e.clientX - sidebar.getBoundingClientRect().left;
        w = clamp(w, MIN, MAX);
        sidebar.style.width = w + "px";
      },
      onEnd: function () {
        const w = parseInt(sidebar.style.width, 10);
        if (w) localStorage.setItem("wb-sidebar-w", w);
      }
    });
  }

  // ---------- 2) 终端面板高度 ----------
  function initTerminal() {
    const panel = $("#terminal-panel"), handle = $("#term-resizer");
    if (!panel || !handle) return;
    const MIN = 80;
    function maxH() { return Math.round(window.innerHeight * 0.70); }
    function isCollapsed() { return panel.classList.contains("collapsed"); }
    // 恢复持久化高度（折叠时不应用，由 .collapsed 的固定高度接管）
    const saved = parseInt(localStorage.getItem("wb-term-h") || "", 10);
    if (saved >= MIN) panel.style.height = clamp(saved, MIN, maxH()) + "px";
    const content = $("#content");
    const SNAP = 36;   // 拖到离边 36px 内 → 铺满文件区
    function dockRight() { return !!(content && content.classList.contains("term-dock-right")); }
    bindDrag({
      handle,
      cursor: function () { return dockRight() ? "col-resize" : "row-resize"; },
      canDrag: function () { return !isCollapsed(); },
      onMove: function (e) {
        const crect = content ? content.getBoundingClientRect() : null;
        const prect = panel.getBoundingClientRect();
        if (dockRight()) {
          // 终端在右侧：宽度 = 面板右边 - 鼠标 X
          const fullW = crect ? crect.width : window.innerWidth;
          let w = prect.right - e.clientX;
          if (w >= fullW - SNAP) { if (content) content.classList.add("term-maxed"); }
          else { if (content) content.classList.remove("term-maxed"); w = clamp(w, MIN, fullW - SNAP); panel.style.width = w + "px"; }
        } else {
          // 终端在底部：高度 = 面板底边 - 鼠标 Y
          const fullH = crect ? crect.height : window.innerHeight;
          let h = prect.bottom - e.clientY;
          if (h >= fullH - SNAP) { if (content) content.classList.add("term-maxed"); }
          else { if (content) content.classList.remove("term-maxed"); h = clamp(h, MIN, fullH - SNAP); panel.style.height = h + "px"; }
        }
        if (typeof window.termRefit === "function") { try { window.termRefit(); } catch {} }
      },
      onEnd: function () {
        // 铺满态不持久化尺寸（靠 .term-maxed 接管）
        if (content && content.classList.contains("term-maxed")) return;
        if (dockRight()) { const w = parseInt(panel.style.width, 10); if (w) localStorage.setItem("wb-term-w", w); }
        else { const h = parseInt(panel.style.height, 10); if (h) localStorage.setItem("wb-term-h", h); }
      }
    });
  }

  // ---------- 3) 编辑 / 预览 分屏宽度 ----------
  function initEditorSplit() {
    const wrap = $("#editor-wrap"), pane = $("#editor-pane"), handle = $("#editor-split-resizer");
    if (!wrap || !pane || !handle) return;
    // 用百分比持久化（窗口缩放后比例不变）。默认 50%。
    function applyPct(pct) {
      pct = clamp(pct, 15, 85);
      // 让编辑窗格按百分比占据，预览占剩余（两者 flex:1 → 改 flex-basis）
      pane.style.flex = "0 0 " + pct + "%";
    }
    const saved = parseFloat(localStorage.getItem("wb-edit-split") || "");
    if (saved >= 15 && saved <= 85) applyPct(saved); // 否则保持默认 flex:1（各半）
    let lastPct = (saved >= 15 && saved <= 85) ? saved : 50;
    bindDrag({
      handle, cursor: "col-resize",
      // 仅 Markdown 分屏模式（editor-wrap 可见且非 edit/preview 单栏）才允许拖
      canDrag: function () {
        return !wrap.classList.contains("hidden")
            && !wrap.classList.contains("mode-edit")
            && !wrap.classList.contains("mode-preview");
      },
      onMove: function (e) {
        const rect = wrap.getBoundingClientRect();
        if (rect.width <= 0) return;
        let pct = ((e.clientX - rect.left) / rect.width) * 100;
        pct = clamp(pct, 15, 85);
        lastPct = pct;
        applyPct(pct);
      },
      onEnd: function () {
        localStorage.setItem("wb-edit-split", lastPct.toFixed(2));
      }
    });
  }

  function init() {
    initSidebar();
    initTerminal();
    initEditorSplit();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
