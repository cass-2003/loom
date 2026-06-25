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
