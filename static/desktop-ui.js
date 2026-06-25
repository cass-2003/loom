/* Workbench 桌面版前端：自绘标题栏的窗口按钮 + 打开文件夹。
   仅在 pywebview（桌面 exe）环境生效；浏览器里这些元素保持隐藏、本文件静默退出。 */
(function () {
  const $ = (s) => document.querySelector(s);

  function setMaxState(state) {
    const max = state === "max";
    document.body.classList.toggle("maximized", max);
    const btn = $("#win-max");
    if (btn && window.svgIcon) {
      btn.innerHTML = window.svgIcon(max ? "winRestore" : "winMax", 15);
    }
  }

  function init() {
    const pw = window.pywebview;
    if (!pw || !pw.api) return;            // 浏览器模式：不启用
    document.body.classList.add("desktop");
    const api = pw.api;

    const min = $("#win-min");
    if (min) min.onclick = () => api.minimize();

    const maxBtn = $("#win-max");
    async function toggleMax() {
      try { setMaxState(await api.toggle_maximize()); } catch (e) { console.error(e); }
    }
    if (maxBtn) maxBtn.onclick = toggleMax;

    const close = $("#win-close");
    if (close) close.onclick = () => api.close();

    // 拖拽区双击 = 最大化 / 还原（标准标题栏行为）
    document.querySelectorAll(".pywebview-drag-region").forEach((el) => {
      el.addEventListener("dblclick", toggleMax);
    });

    // 打开文件夹 → 切换工作根
    const of = $("#btn-open-folder");
    if (of) {
      of.onclick = async () => {
        try {
          const p = await api.open_folder();
          if (p && window.reloadRoot) await window.reloadRoot(p);
        } catch (e) { console.error(e); }
      };
    }

    setupResizeZones(api);
  }

  // 无边框窗口的四边四角缩放：窗口边缘四边四角铺透明热区，拖动 → 原生 MoveWindow。
  // 不加任何可见原生边框，外观零变化。物理像素 ↔ CSS 像素用 devicePixelRatio 换算。
  function setupResizeZones(api) {
    if (!api.get_window_rect || !api.set_window_rect) return;
    const EDGE = 6, CORNER = 10, MINW = 900, MINH = 600;
    const ZONES = [
      { e: { top: 1 },               cur: "ns-resize",   css: { top: 0, left: CORNER + "px", right: CORNER + "px", height: EDGE + "px" } },
      { e: { bottom: 1 },            cur: "ns-resize",   css: { bottom: 0, left: CORNER + "px", right: CORNER + "px", height: EDGE + "px" } },
      { e: { left: 1 },              cur: "ew-resize",   css: { left: 0, top: CORNER + "px", bottom: CORNER + "px", width: EDGE + "px" } },
      { e: { right: 1 },             cur: "ew-resize",   css: { right: 0, top: CORNER + "px", bottom: CORNER + "px", width: EDGE + "px" } },
      { e: { top: 1, left: 1 },      cur: "nwse-resize", css: { top: 0, left: 0, width: CORNER + "px", height: CORNER + "px" } },
      { e: { top: 1, right: 1 },     cur: "nesw-resize", css: { top: 0, right: 0, width: CORNER + "px", height: CORNER + "px" } },
      { e: { bottom: 1, left: 1 },   cur: "nesw-resize", css: { bottom: 0, left: 0, width: CORNER + "px", height: CORNER + "px" } },
      { e: { bottom: 1, right: 1 },  cur: "nwse-resize", css: { bottom: 0, right: 0, width: CORNER + "px", height: CORNER + "px" } },
    ];
    let drag = null, raf = 0, pending = null, overlay = null;

    function showOverlay(cursor) {
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:transparent;";
        document.body.appendChild(overlay);
      }
      overlay.style.cursor = cursor;
      overlay.style.display = "block";
    }
    function hideOverlay() { if (overlay) overlay.style.display = "none"; }

    function apply() {
      raf = 0;
      if (pending) {
        // 桥调用是 Promise；不挂 .catch 桥异常会变成未处理拒绝
        Promise.resolve(api.set_window_rect(pending[0], pending[1], pending[2], pending[3])).catch(() => {});
      }
    }
    function onMove(ev) {
      if (!drag) return;
      const dpr = drag.dpr;
      const dx = (ev.screenX - drag.mx) * dpr, dy = (ev.screenY - drag.my) * dpr;
      const minW = MINW * dpr, minH = MINH * dpr;
      let nx = drag.x, ny = drag.y, nw = drag.w, nh = drag.h;
      if (drag.e.right)  nw = drag.w + dx;
      if (drag.e.bottom) nh = drag.h + dy;
      if (drag.e.left)  { nw = drag.w - dx; nx = drag.x + dx; }
      if (drag.e.top)   { nh = drag.h - dy; ny = drag.y + dy; }
      if (nw < minW) { if (drag.e.left) nx = drag.x + (drag.w - minW); nw = minW; }
      if (nh < minH) { if (drag.e.top)  ny = drag.y + (drag.h - minH); nh = minH; }
      pending = [Math.round(nx), Math.round(ny), Math.round(nw), Math.round(nh)];
      if (!raf) raf = requestAnimationFrame(apply);
    }
    function onUp() {
      if (!drag) return;
      drag = null;
      hideOverlay();
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    }
    function onDown(z, ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      // 取窗口几何是异步(pywebview 桥)。若 await 期间用户已松开鼠标，绝不能再起拖——
      // 否则 drag 被置上但按键已抬起，之后无按键的移动也会缩放窗口(幽灵缩放)。
      let aborted = false;
      const cancelIfUp = () => { aborted = true; };
      window.addEventListener("mouseup", cancelIfUp, { once: true, capture: true });
      Promise.resolve(api.get_window_rect()).then((r) => {
        window.removeEventListener("mouseup", cancelIfUp, true);
        if (aborted || !r) return;
        drag = { e: z.e, x: r.x, y: r.y, w: r.w, h: r.h,
                 mx: ev.screenX, my: ev.screenY, dpr: window.devicePixelRatio || 1 };
        showOverlay(z.cur);
        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("mouseup", onUp, true);
      }).catch(() => { window.removeEventListener("mouseup", cancelIfUp, true); });
    }
    ZONES.forEach((z) => {
      const d = document.createElement("div");
      let css = "position:fixed;z-index:2147483647;background:transparent;cursor:" + z.cur + ";";
      for (const k in z.css) css += k + ":" + z.css[k] + ";";
      d.style.cssText = css;
      d.addEventListener("mousedown", (ev) => onDown(z, ev));
      document.body.appendChild(d);
    });
  }

  // pywebview 注入 api 后会派发 pywebviewready；若已就绪直接初始化
  function boot() {
    if (window.pywebview && window.pywebview.api) init();
    else window.addEventListener("pywebviewready", init, { once: true });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
