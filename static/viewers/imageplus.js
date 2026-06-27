/* 图片增强查看器（imageplus）：解码原生 <img> 看不了的图片格式。
 *
 * 注册扩展名：psd / heic / heif / tiff / tif
 *   - 普通图片（png/jpg/gif/webp/svg/bmp/ico）仍走 app.js 原 image 逻辑，本查看器不接管。
 *
 * 依赖（构建期 vendor 到 static/vendor/，运行时本地引用，按需懒加载）：
 *   - PSD     : static/vendor/ag-psd/bundle.js   （UMD 全局 window.agPsd，用 readPsd()）
 *   - HEIC/HEIF: static/vendor/heic2any/heic2any.min.js （UMD 全局 window.heic2any）
 *   - TIFF/TIF: static/vendor/utif/UTIF.js       （UMD 全局 window.UTIF）
 *
 * 契约见 _registry.js：mount(host, info) / unmount() / onTheme(t)。
 * 基建提供：window.registerViewer / window.fetchRaw(path)->Promise<ArrayBuffer>。
 */
(function () {
  "use strict";

  if (typeof window.registerViewer !== "function") return;

  // ---------- 懒加载 vendor 脚本（同一脚本只加载一次，缓存 Promise） ----------
  const SCRIPTS = {
    agPsd: "/static/vendor/ag-psd/bundle.js",
    heic2any: "/static/vendor/heic2any/heic2any.min.js",
    UTIF: "/static/vendor/utif/UTIF.js",
  };
  const loadCache = Object.create(null);

  function loadScript(globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (loadCache[globalName]) return loadCache[globalName];
    const src = SCRIPTS[globalName];
    const p = new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () {
        if (window[globalName]) resolve(window[globalName]);
        else reject(new Error("脚本已加载但未导出全局 " + globalName + "：" + src));
      };
      s.onerror = function () {
        reject(new Error("无法加载依赖脚本：" + src));
      };
      document.head.appendChild(s);
    });
    loadCache[globalName] = p;
    return p;
  }

  // ---------- 渲染辅助 ----------

  // 当前挂载状态（供 unmount 清理）
  let mountState = null; // { host, objectUrls:[], destroyed:bool }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 居中 + 适应容器的舞台容器
  function makeStage(host) {
    const stage = document.createElement("div");
    stage.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "overflow:auto;background:#1e1e1e;padding:12px;box-sizing:border-box;";
    // 让 host 自身可定位、占满
    host.style.position = host.style.position || "relative";
    if (!host.style.height) host.style.height = "100%";
    host.appendChild(stage);
    return stage;
  }

  // 把 <canvas>/<img> 适配进舞台（不放大超过容器，保持比例）
  function fitElement(el) {
    el.style.maxWidth = "100%";
    el.style.maxHeight = "100%";
    el.style.width = "auto";
    el.style.height = "auto";
    el.style.objectFit = "contain";
    el.style.display = "block";
    el.style.boxShadow = "0 1px 8px rgba(0,0,0,0.5)";
    el.style.background =
      "repeating-conic-gradient(#2a2a2a 0% 25%, #232323 0% 50%) 50% / 20px 20px";
  }

  function showLoading(stage, text) {
    stage.innerHTML =
      '<div style="color:#bbb;font:13px/1.6 system-ui,sans-serif;text-align:center;">' +
      escHtml(text || "正在解码…") +
      "</div>";
  }

  function showError(stage, title, detail) {
    if (mountState && mountState.host && window.wbViewer && typeof window.wbViewer.reportError === "function") {
      window.wbViewer.reportError(mountState.host, new Error(title + (detail ? ": " + detail : "")));
    }
    stage.innerHTML =
      '<div style="color:#e0e0e0;font:13px/1.7 system-ui,sans-serif;max-width:560px;text-align:center;">' +
      '<div style="font-size:34px;margin-bottom:10px;opacity:.55;">🖼️</div>' +
      '<div style="font-weight:600;margin-bottom:6px;">' +
      escHtml(title) +
      "</div>" +
      (detail
        ? '<div style="color:#999;font-size:12px;word-break:break-word;">' +
          escHtml(detail) +
          "</div>"
        : "") +
      "</div>";
  }

  function trackUrl(url) {
    if (mountState && url) mountState.objectUrls.push(url);
    return url;
  }

  // ---------- 各格式解码 ----------

  // PSD：ag-psd readPsd 取合成 canvas
  function renderPsd(stage, buf) {
    return loadScript("agPsd").then(function (agPsd) {
      let psd;
      try {
        psd = agPsd.readPsd(buf, {
          skipLayerImageData: true, // 只要合成图，省内存
          skipThumbnail: false,
          useImageData: false,
        });
      } catch (e) {
        // 退一步：把图层数据也读出来再试一次
        psd = agPsd.readPsd(buf, { skipThumbnail: false });
      }
      if (mountState && mountState.destroyed) return;
      const canvas = psd && (psd.canvas || (psd.imageResources && null));
      if (canvas && canvas.width) {
        fitElement(canvas);
        stage.innerHTML = "";
        stage.appendChild(canvas);
        return;
      }
      // 没有合成 canvas（部分 PSD 不含合成预览），尝试缩略图
      if (psd && psd.thumbnail) {
        const c = psd.thumbnail;
        fitElement(c);
        stage.innerHTML = "";
        stage.appendChild(c);
        return;
      }
      throw new Error("此 PSD 不含可渲染的合成图层或预览");
    });
  }

  // HEIC/HEIF：heic2any -> PNG blob -> objectURL -> <img>
  function renderHeic(stage, buf, name) {
    return loadScript("heic2any").then(function (heic2any) {
      const blob = new Blob([buf]); // 不强制 mime，heic2any 自行嗅探
      return heic2any({ blob: blob, toType: "image/png" }).then(function (out) {
        if (mountState && mountState.destroyed) return;
        // 动图/多帧 HEIC 可能返回数组，取第一帧
        const pngBlob = Array.isArray(out) ? out[0] : out;
        const url = trackUrl(URL.createObjectURL(pngBlob));
        const img = document.createElement("img");
        img.alt = name || "HEIC";
        img.onload = function () {
          if (mountState && mountState.destroyed) return;
          fitElement(img);
          stage.innerHTML = "";
          stage.appendChild(img);
        };
        img.onerror = function () {
          showError(stage, "HEIC 解码后无法显示", name || "");
        };
        img.src = url;
      });
    });
  }

  // TIFF/TIF：UTIF 解码首个 IFD -> RGBA -> canvas
  function renderTiff(stage, buf, name) {
    return loadScript("UTIF").then(function (UTIF) {
      if (mountState && mountState.destroyed) return;
      const ifds = UTIF.decode(buf);
      if (!ifds || !ifds.length) throw new Error("未能解析 TIFF 结构");
      const ifd = ifds[0];
      try {
        UTIF.decodeImage(buf, ifd, ifds);
      } catch (e) {
        // 压缩方式可能依赖 pako（deflate/zip 压缩的 TIFF）。pako 未打包 -> 友好提示。
        if (typeof self !== "undefined" && !self.pako) {
          throw new Error(
            "该 TIFF 使用了需要 pako 解压的压缩方式（deflate/zip），当前未内置该解码器"
          );
        }
        throw e;
      }
      const rgba = UTIF.toRGBA8(ifd); // Uint8Array
      const w = ifd.width,
        h = ifd.height;
      if (!w || !h || !rgba || !rgba.length) {
        throw new Error("TIFF 像素数据为空（可能为不支持的压缩/位深）");
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      const imgData = ctx.createImageData(w, h);
      imgData.data.set(rgba);
      ctx.putImageData(imgData, 0, 0);
      fitElement(canvas);
      stage.innerHTML = "";
      stage.appendChild(canvas);
    });
  }

  const DECODERS = {
    psd: renderPsd,
    heic: renderHeic,
    heif: renderHeic,
    tiff: renderTiff,
    tif: renderTiff,
  };

  const LABELS = {
    psd: "Photoshop PSD",
    heic: "HEIC 图像",
    heif: "HEIF 图像",
    tiff: "TIFF 图像",
    tif: "TIFF 图像",
  };

  // ---------- 查看器对象 ----------
  window.registerViewer({
    exts: ["psd", "heic", "heif", "tiff", "tif"],
    label: "图片增强(PSD/HEIC/TIFF)",

    mount: function (host, info) {
      mountState = { host: host, objectUrls: [], destroyed: false };
      const ext = (info && info.ext ? String(info.ext) : "")
        .toLowerCase()
        .replace(/^\./, "");
      const name = (info && info.name) || (info && info.path) || "";
      const stage = makeStage(host);
      showLoading(stage, "正在解码 " + (LABELS[ext] || ext.toUpperCase()) + " …");

      const decode = DECODERS[ext];
      if (!decode) {
        showError(stage, "不支持的图片格式", ext);
        return;
      }

      const path = info && info.path;
      if (!path) {
        showError(stage, "缺少文件路径");
        return;
      }

      window
        .fetchRaw(path)
        .then(function (buf) {
          if (mountState && mountState.destroyed) return;
          return decode(stage, buf, name);
        })
        .catch(function (e) {
          if (mountState && mountState.destroyed) return;
          showError(
            stage,
            (LABELS[ext] || "图片") + " 解码失败",
            e && e.message ? e.message : String(e)
          );
        });
    },

    unmount: function () {
      if (!mountState) return;
      mountState.destroyed = true;
      // 释放所有 objectURL
      for (const u of mountState.objectUrls) {
        try {
          URL.revokeObjectURL(u);
        } catch (e) {
          /* ignore */
        }
      }
      if (mountState.host) mountState.host.innerHTML = "";
      mountState = null;
    },

    onTheme: function (_t) {
      // 本查看器恒用深色舞台背景以适配各类图片（含透明），主题切换无需重渲。
    },
  });
})();
