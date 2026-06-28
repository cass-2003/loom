/* 压缩包查看器（archive）：用 window.JSZip 列出 zip 容器内容树。
 *
 * 支持扩展名：zip / jar / vsix / apk / crx / war / ipa / whl / nupkg —— 都是 ZIP 容器。
 *   crx：Chrome 扩展，前面有一段自定义头（魔数 "Cr24"），需跳过到内嵌 ZIP（"PK\x03\x04"）。
 *   其余均为标准 ZIP，JSZip 可直接 loadAsync。
 * 注：.7z / .rar / .tar.gz 等不是 ZIP 容器，JSZip 不支持 —— 不在此注册。
 *
 * mount：fetchRaw → JSZip.loadAsync → 把条目按路径组织成可折叠目录树
 *        （文件名 / 原始大小 / 压缩后大小），点文本类条目展开预览（前若干 KB）。
 * 契约见 _registry.js：registerViewer({ exts, label, mount, unmount, onTheme })。
 */
(function () {
  "use strict";

  var PREVIEW_LIMIT = 64 * 1024; // 文本预览最多取前 64KB
  var STYLE_ID = "viewer-archive-style";

  // —— 一次性注入样式（跟随主题 CSS 变量；不改 style.css） ——
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      ".arc-root{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;",
      "  font-family:'Inter','Segoe UI','Microsoft YaHei',system-ui,sans-serif;color:var(--text);background:var(--bg);}",
      ".arc-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;flex-shrink:0;",
      "  padding:10px 16px;border-bottom:1px solid var(--border-soft);background:var(--bg2);}",
      ".arc-title{font-weight:650;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".arc-stat{font-size:11.5px;color:var(--muted);white-space:nowrap;}",
      ".arc-actions{margin-left:auto;display:flex;gap:6px;}",
      ".arc-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer;",
      "  background:var(--panel);color:var(--text-dim);border:1px solid var(--border);transition:background .12s,color .12s;}",
      ".arc-btn:hover:not(:disabled){background:var(--hover);color:var(--text);}",
      ".arc-btn:disabled,.arc-btn.disabled{opacity:.5;cursor:not-allowed;color:var(--muted);background:var(--bg2);}",
      ".arc-tree{flex:1;min-height:0;overflow:auto;padding:6px 8px 14px;}",
      ".arc-row{display:flex;align-items:center;gap:7px;padding:3px 8px;border-radius:6px;",
      "  cursor:default;font-size:12.5px;color:var(--text-dim);white-space:nowrap;}",
      ".arc-row.clickable{cursor:pointer;}",
      ".arc-row:hover{background:var(--hover);}",
      ".arc-twist{width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;",
      "  flex-shrink:0;color:var(--muted);transition:transform .12s;}",
      ".arc-twist.open{transform:rotate(90deg);}",
      ".arc-twist.leaf{visibility:hidden;}",
      ".arc-ico{display:inline-flex;flex-shrink:0;width:15px;height:15px;}",
      ".arc-ico.dir{color:var(--warn);} .arc-ico.code{color:var(--accent);}",
      ".arc-ico.md{color:var(--cyan);} .arc-ico.img{color:var(--purple);}",
      ".arc-ico.text{color:#9aa5ce;} .arc-ico.bin{color:var(--muted);}",
      ".arc-name{overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0;}",
      ".arc-dir-row>.arc-name{color:var(--text);font-weight:600;}",
      ".arc-spacer{flex:1 1 auto;min-width:8px;}",
      ".arc-size{flex-shrink:0;font-family:'Cascadia Code',Consolas,monospace;font-size:11px;",
      "  color:var(--muted);text-align:right;min-width:62px;}",
      ".arc-csize{flex-shrink:0;font-family:'Cascadia Code',Consolas,monospace;font-size:11px;",
      "  color:var(--muted);opacity:.7;text-align:right;min-width:62px;}",
      ".arc-children{padding-left:15px;}",
      ".arc-children.collapsed{display:none;}",
      ".arc-prev{margin:2px 0 6px 22px;border:1px solid var(--border-soft);border-radius:7px;",
      "  background:var(--code-bg);overflow:hidden;}",
      ".arc-prev-bar{display:flex;align-items:center;gap:10px;padding:5px 10px;",
      "  background:var(--bg2);border-bottom:1px solid var(--border-soft);font-size:11px;color:var(--muted);}",
      ".arc-prev-bar .arc-prev-name{color:var(--text-dim);font-weight:600;}",
      ".arc-prev-pre{margin:0;padding:10px 12px;max-height:340px;overflow:auto;",
      "  font-family:'Cascadia Code','JetBrains Mono',Consolas,monospace;font-size:12px;line-height:1.55;",
      "  white-space:pre;color:var(--text);}",
      ".arc-prev-img{display:block;max-width:100%;max-height:340px;margin:10px auto;border-radius:5px;}",
      ".arc-prev-note{padding:10px 12px;font-size:12px;color:var(--muted);}",
      ".arc-msg{margin:auto;padding:24px;text-align:center;color:var(--text-dim);}",
      ".arc-msg.err{color:var(--danger);}",
      ".arc-msg .arc-sub{margin-top:6px;font-size:12px;color:var(--muted);}"
    ].join("\n");
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  // —— 小工具 ——
  function fmtSize(n) {
    if (n == null || isNaN(n)) return "";
    if (n < 1024) return n + " B";
    var u = ["KB", "MB", "GB", "TB"], i = -1, v = n;
    do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
    return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + " " + u[i];
  }

  function extOf(name) {
    var m = /\.([^.\/\\]+)$/.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  // 文本类扩展名（可预览内容）
  var TEXT_EXTS = {
    txt:1,md:1,markdown:1,json:1,jsonc:1,xml:1,html:1,htm:1,css:1,scss:1,less:1,
    js:1,mjs:1,cjs:1,ts:1,tsx:1,jsx:1,vue:1,svelte:1,py:1,rb:1,go:1,rs:1,java:1,
    kt:1,kts:1,c:1,h:1,cpp:1,hpp:1,cc:1,cs:1,php:1,pl:1,lua:1,sh:1,bash:1,zsh:1,
    bat:1,cmd:1,ps1:1,yml:1,yaml:1,toml:1,ini:1,cfg:1,conf:1,properties:1,env:1,
    sql:1,graphql:1,gradle:1,csv:1,tsv:1,log:1,gitignore:1,dockerignore:1,
    editorconfig:1,manifest:1,mf:1,classpath:1,project:1,plist:1,nuspec:1,
    svg:1,map:1,lock:1,license:1,readme:1,authors:1,changelog:1,notice:1
  };
  var IMG_EXTS = { png:1, jpg:1, jpeg:1, gif:1, webp:1, bmp:1, ico:1 };
  var IMG_MIME = {
    png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif",
    webp:"image/webp", bmp:"image/bmp", ico:"image/x-icon"
  };
  var CODE_EXTS = {
    js:1,mjs:1,cjs:1,ts:1,tsx:1,jsx:1,vue:1,svelte:1,py:1,rb:1,go:1,rs:1,java:1,
    kt:1,c:1,h:1,cpp:1,hpp:1,cc:1,cs:1,php:1,pl:1,lua:1,sh:1,bash:1,ps1:1,sql:1,
    json:1,xml:1,html:1,htm:1,css:1,scss:1,less:1,yml:1,yaml:1,toml:1
  };

  function isTextName(name) {
    var lower = (name || "").toLowerCase();
    var base = lower.replace(/^.*[\/\\]/, "");
    if (TEXT_EXTS[base]) return true;       // 形如 LICENSE / README（无扩展名靠全名）
    return !!TEXT_EXTS[extOf(name)];
  }
  function isImageName(name) { return !!IMG_EXTS[extOf(name)]; }

  function classFor(name, isDir) {
    if (isDir) return "dir";
    var e = extOf(name);
    if (e === "md" || e === "markdown") return "md";
    if (IMG_EXTS[e]) return "img";
    if (CODE_EXTS[e]) return "code";
    if (isTextName(name)) return "text";
    return "bin";
  }

  // —— 图标（内联 SVG，stroke=currentColor 跟随类配色） ——
  function svg(paths) {
    return '<svg class="icn" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      paths + '</svg>';
  }
  var ICO = {
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    file:   svg('<path d="M14 3v5h5"/><path d="M6 3h8l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>'),
    code:   svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    img:    svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
    twist:  svg('<polyline points="9 6 15 12 9 18"/>')
  };
  function iconFor(name, isDir) {
    if (isDir) return ICO.folder;
    var c = classFor(name, false);
    if (c === "code") return ICO.code;
    if (c === "img") return ICO.img;
    return ICO.file;
  }

  // —— crx：去掉 Chrome 扩展头，返回内嵌 ZIP 的 ArrayBuffer ——
  function stripCrxHeader(buf) {
    var bytes = new Uint8Array(buf);
    // 魔数 "Cr24"
    if (!(bytes[0] === 0x43 && bytes[1] === 0x72 && bytes[2] === 0x32 && bytes[3] === 0x34)) {
      return buf; // 不是 crx 头，原样
    }
    var dv = new DataView(buf);
    var version = dv.getUint32(4, true);
    var zipStart;
    if (version === 2) {
      var pubKeyLen = dv.getUint32(8, true);
      var sigLen = dv.getUint32(12, true);
      zipStart = 16 + pubKeyLen + sigLen;
    } else {
      // crx3：12 字节头后跟 uint32 header 长度，再跟 protobuf header
      var headerLen = dv.getUint32(8, true);
      zipStart = 12 + headerLen;
    }
    if (zipStart > 0 && zipStart < bytes.length) return buf.slice(zipStart);
    return buf;
  }

  // —— 把 JSZip 扁平条目构造成目录树 ——
  // 节点：{ name, path, dir:bool, size, csize, entry, children:Map }
  function buildTree(zip) {
    var root = { name: "", path: "", dir: true, children: new Map(), size: 0, csize: 0, entry: null };
    function ensureDir(parts) {
      var cur = root;
      var acc = "";
      for (var i = 0; i < parts.length; i++) {
        acc += parts[i] + "/";
        if (!cur.children.has(parts[i])) {
          cur.children.set(parts[i], {
            name: parts[i], path: acc, dir: true,
            children: new Map(), size: 0, csize: 0, entry: null
          });
        }
        cur = cur.children.get(parts[i]);
        cur.dir = cur.dir; // 已存在文件同名时保持
      }
      return cur;
    }
    Object.keys(zip.files).forEach(function (fullName) {
      var entry = zip.files[fullName];
      var norm = fullName.replace(/\\/g, "/");
      var isDir = entry.dir || /\/$/.test(norm);
      var parts = norm.split("/").filter(function (p) { return p.length > 0; });
      if (parts.length === 0) return;
      if (isDir) {
        ensureDir(parts);
        return;
      }
      var fileName = parts.pop();
      var parent = parts.length ? ensureDir(parts) : root;
      var data = entry._data || {};
      var node = {
        name: fileName, path: norm, dir: false,
        children: null,
        size: typeof data.uncompressedSize === "number" ? data.uncompressedSize : null,
        csize: typeof data.compressedSize === "number" ? data.compressedSize : null,
        entry: entry
      };
      parent.children.set(fileName, node);
    });
    return root;
  }

  // 子节点排序：目录优先，再按名称
  function sortedChildren(node) {
    var arr = Array.from(node.children.values());
    arr.sort(function (a, b) {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
    return arr;
  }

  // —— 渲染一个节点行 + 子树 ——
  function isCurrentPreview(root, prevEl) {
    return !!(root && state.root === root && prevEl && prevEl.isConnected);
  }

  function renderNode(node, depth, listeners, onTreeStateChange, root) {
    var wrap = document.createElement("div");

    var row = document.createElement("div");
    row.className = "arc-row" + (node.dir ? " arc-dir-row" : "");

    var twist = document.createElement("span");
    twist.className = "arc-twist" + (node.dir ? "" : " leaf");
    if (node.dir) twist.innerHTML = ICO.twist;
    row.appendChild(twist);

    var ico = document.createElement("span");
    ico.className = "arc-ico " + classFor(node.name, node.dir);
    ico.innerHTML = iconFor(node.name, node.dir);
    row.appendChild(ico);

    var nameEl = document.createElement("span");
    nameEl.className = "arc-name";
    nameEl.textContent = node.name;
    nameEl.title = node.path;
    row.appendChild(nameEl);

    var spacer = document.createElement("span");
    spacer.className = "arc-spacer";
    row.appendChild(spacer);

    if (!node.dir) {
      var sz = document.createElement("span");
      sz.className = "arc-size";
      sz.textContent = node.size != null ? fmtSize(node.size) : "";
      sz.title = (node.size != null ? node.size + " 字节" : "") +
        (node.csize != null ? " · 压缩后 " + fmtSize(node.csize) : "");
      row.appendChild(sz);

      var cz = document.createElement("span");
      cz.className = "arc-csize";
      cz.textContent = node.csize != null ? fmtSize(node.csize) : "";
      cz.title = "压缩后大小";
      row.appendChild(cz);
    }

    wrap.appendChild(row);

    if (node.dir) {
      var childWrap = document.createElement("div");
      // 顶层目录默认展开，更深的折叠
      var collapsed = depth >= 1;
      childWrap.className = "arc-children" + (collapsed ? " collapsed" : "");
      if (!collapsed) twist.classList.add("open");
      var built = false;
      function buildChildren() {
        if (built) return;
        built = true;
        sortedChildren(node).forEach(function (child) {
          childWrap.appendChild(renderNode(child, depth + 1, listeners, onTreeStateChange, root));
        });
      }
      if (!collapsed) buildChildren();
      var onToggle = function () {
        var nowCollapsed = childWrap.classList.toggle("collapsed");
        twist.classList.toggle("open", !nowCollapsed);
        if (!nowCollapsed) buildChildren();
        if (typeof onTreeStateChange === "function") onTreeStateChange();
      };
      row.classList.add("clickable");
      row.addEventListener("click", onToggle);
      listeners.push([row, "click", onToggle]);
      wrap.appendChild(childWrap);
    } else if (isTextName(node.name) || isImageName(node.name)) {
      // 可预览文件：点击切换预览
      row.classList.add("clickable");
      var prevEl = null;
      var onClick = function () {
        if (prevEl) { // 已展开 → 收起
          prevEl.remove();
          prevEl = null;
          return;
        }
        prevEl = document.createElement("div");
        prevEl.className = "arc-prev";
        prevEl.innerHTML = '<div class="arc-prev-note">加载中…</div>';
        wrap.appendChild(prevEl);
        loadPreview(node, prevEl, root);
      };
      row.addEventListener("click", onClick);
      listeners.push([row, "click", onClick]);
    }

    return wrap;
  }

  function loadPreview(node, prevEl, root) {
    if (!node.entry) {
      if (!isCurrentPreview(root, prevEl)) return;
      prevEl.innerHTML = '<div class="arc-prev-note">无法读取该条目</div>';
      return;
    }
    if (isImageName(node.name)) {
      node.entry.async("base64").then(function (b64) {
        if (!isCurrentPreview(root, prevEl)) return;
        var mime = IMG_MIME[extOf(node.name)] || "application/octet-stream";
        prevEl.innerHTML =
          '<div class="arc-prev-bar"><span class="arc-prev-name"></span>' +
          '<span></span></div>';
        prevEl.querySelector(".arc-prev-name").textContent = node.name;
        prevEl.querySelector(".arc-prev-bar span:last-child").textContent =
          node.size != null ? fmtSize(node.size) : "";
        var img = document.createElement("img");
        img.className = "arc-prev-img";
        img.alt = node.name;
        img.src = "data:" + mime + ";base64," + b64;
        prevEl.appendChild(img);
      }).catch(function (e) {
        if (!isCurrentPreview(root, prevEl)) return;
        prevEl.innerHTML = '<div class="arc-prev-note">预览失败：' +
          escapeHtml(String(e && e.message || e)) + "</div>";
      });
      return;
    }
    // 文本预览：取前若干 KB
    node.entry.async("uint8array").then(function (u8) {
      if (!isCurrentPreview(root, prevEl)) return;
      var truncated = u8.length > PREVIEW_LIMIT;
      var slice = truncated ? u8.subarray(0, PREVIEW_LIMIT) : u8;
      var text;
      try {
        text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      } catch (e) {
        text = "";
        for (var i = 0; i < slice.length; i++) text += String.fromCharCode(slice[i]);
      }
      prevEl.innerHTML = '<div class="arc-prev-bar">' +
        '<span class="arc-prev-name"></span><span class="arc-prev-info"></span></div>' +
        '<pre class="arc-prev-pre"></pre>';
      prevEl.querySelector(".arc-prev-name").textContent = node.name;
      prevEl.querySelector(".arc-prev-info").textContent =
        (node.size != null ? fmtSize(node.size) : "") +
        (truncated ? " · 仅显示前 " + fmtSize(PREVIEW_LIMIT) : "");
      prevEl.querySelector(".arc-prev-pre").textContent = text;
    }).catch(function (e) {
      if (!isCurrentPreview(root, prevEl)) return;
      prevEl.innerHTML = '<div class="arc-prev-note">预览失败：' +
        escapeHtml(String(e && e.message || e)) + "</div>";
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // —— 查看器实现 ——
  var state = { listeners: [], root: null };

  function clearListeners() {
    state.listeners.forEach(function (t) {
      try { t[0].removeEventListener(t[1], t[2]); } catch (e) {}
    });
    state.listeners = [];
  }

  function showMsg(root, text, sub, isErr) {
    root.innerHTML = "";
    var box = document.createElement("div");
    box.className = "arc-msg" + (isErr ? " err" : "");
    var main = document.createElement("div");
    main.textContent = text;
    box.appendChild(main);
    if (sub) {
      var s = document.createElement("div");
      s.className = "arc-sub";
      s.textContent = sub;
      box.appendChild(s);
    }
    root.appendChild(box);
  }

  registerViewer({
    exts: ["zip", "jar", "vsix", "apk", "crx", "war", "ipa", "whl", "nupkg"],
    label: "压缩包",

    mount: function (host, info) {
      ensureStyle();
      clearListeners();

      var root = document.createElement("div");
      root.className = "arc-root";
      host.appendChild(root);
      state.root = root;

      if (!window.JSZip) {
        if (window.wbViewer && typeof window.wbViewer.reportError === "function") {
          window.wbViewer.reportError(host, new Error("JSZip 未加载"));
        }
        showMsg(root, "JSZip 未加载", "压缩包查看器依赖 window.JSZip", true);
        return;
      }

      showMsg(root, "正在读取压缩包…", info.name || "");
      if (window.wbViewer && typeof window.wbViewer.reportLoading === "function") {
        window.wbViewer.reportLoading(host, "压缩包正在读取，暂不能创建验证任务");
      }

      window.fetchRaw(info.path).then(function (buf) {
        var ext = (info.ext || extOf(info.name || "")).toLowerCase().replace(/^\./, "");
        if (ext === "crx") buf = stripCrxHeader(buf);
        return window.JSZip.loadAsync(buf);
      }).then(function (zip) {
        if (state.root !== root) return; // 已被 unmount
        var tree = buildTree(zip);

        // 统计
        var fileCount = 0, totalSize = 0, totalC = 0;
        Object.keys(zip.files).forEach(function (k) {
          var e = zip.files[k];
          if (e.dir) return;
          fileCount++;
          var d = e._data || {};
          if (typeof d.uncompressedSize === "number") totalSize += d.uncompressedSize;
          if (typeof d.compressedSize === "number") totalC += d.compressedSize;
        });

        root.innerHTML = "";

        var head = document.createElement("div");
        head.className = "arc-head";
        var title = document.createElement("span");
        title.className = "arc-title";
        title.textContent = info.name || "压缩包";
        title.title = info.path || "";
        head.appendChild(title);
        var stat = document.createElement("span");
        stat.className = "arc-stat";
        var ratio = totalSize > 0 ? Math.round((1 - totalC / totalSize) * 100) : 0;
        stat.textContent = fileCount + " 个文件 · " + fmtSize(totalSize) +
          " → " + fmtSize(totalC) +
          (totalSize > 0 ? " (压缩率 " + ratio + "%)" : "");
        head.appendChild(stat);

        var actions = document.createElement("div");
        actions.className = "arc-actions";
        var expandBtn = document.createElement("button");
        expandBtn.className = "arc-btn";
        expandBtn.textContent = "全部展开";
        var collapseBtn = document.createElement("button");
        collapseBtn.className = "arc-btn";
        collapseBtn.textContent = "全部折叠";
        actions.appendChild(expandBtn);
        actions.appendChild(collapseBtn);
        head.appendChild(actions);
        root.appendChild(head);

        var treeWrap = document.createElement("div");
        treeWrap.className = "arc-tree";
        root.appendChild(treeWrap);

        if (fileCount === 0) {
          showMsg(root, "压缩包为空", info.name || "");
          if (window.wbViewer && typeof window.wbViewer.reportReady === "function") {
            window.wbViewer.reportReady(host);
          }
          return;
        }

        function setArchiveButtonState(btn, disabled, enabledTitle, disabledReason) {
          btn.disabled = !!disabled;
          btn.setAttribute("aria-disabled", disabled ? "true" : "false");
          btn.classList.toggle("disabled", !!disabled);
          btn.title = disabled ? disabledReason : enabledTitle;
        }

        function updateActionState() {
          setArchiveButtonState(
            expandBtn,
            !treeWrap.querySelector(".arc-children.collapsed"),
            "展开压缩包内所有目录",
            "当前没有可展开的目录"
          );
          setArchiveButtonState(
            collapseBtn,
            !treeWrap.querySelector(".arc-children:not(.collapsed)"),
            "折叠压缩包内所有目录",
            "当前没有可折叠的目录"
          );
        }

        sortedChildren(tree).forEach(function (child) {
          treeWrap.appendChild(renderNode(child, 0, state.listeners, updateActionState, root));
        });

        // 全部展开/折叠：操作所有 .arc-children + .arc-twist（仅目录）
        var onExpand = function () {
          if (expandBtn.disabled) return;
          treeWrap.querySelectorAll(".arc-children.collapsed").forEach(function (el) {
            var rowToggle = el.previousElementSibling;
            if (rowToggle && rowToggle.classList.contains("arc-row")) rowToggle.click();
          });
          // 反复点直到没有折叠的（懒构建可能多层）
          var pass = 0;
          while (treeWrap.querySelector(".arc-children.collapsed") && pass < 50) {
            treeWrap.querySelectorAll(".arc-children.collapsed").forEach(function (el) {
              var r = el.previousElementSibling;
              if (r && r.classList.contains("arc-row")) r.click();
            });
            pass++;
          }
          updateActionState();
        };
        var onCollapse = function () {
          if (collapseBtn.disabled) return;
          // 从最深处往外收：直接给所有 children 加 collapsed
          treeWrap.querySelectorAll(".arc-children:not(.collapsed)").forEach(function (el) {
            el.classList.add("collapsed");
            var r = el.previousElementSibling;
            if (r) {
              var tw = r.querySelector(".arc-twist");
              if (tw) tw.classList.remove("open");
            }
          });
          updateActionState();
        };
        expandBtn.addEventListener("click", onExpand);
        collapseBtn.addEventListener("click", onCollapse);
        state.listeners.push([expandBtn, "click", onExpand]);
        state.listeners.push([collapseBtn, "click", onCollapse]);
        updateActionState();
        if (window.wbViewer && typeof window.wbViewer.reportReady === "function") {
          window.wbViewer.reportReady(host);
        }
      }).catch(function (err) {
        if (state.root !== root) return;
        if (window.wbViewer && typeof window.wbViewer.reportError === "function") {
          window.wbViewer.reportError(host, err);
        }
        showMsg(root, "无法打开压缩包",
          (err && err.message ? err.message : String(err)) +
          "（仅支持 ZIP 容器格式；.7z/.rar/.tar.gz 暂不支持）", true);
      });
    },

    unmount: function () {
      clearListeners();
      state.root = null;
    }

    // onTheme 无需实现：全部用 CSS 变量，主题切换自动跟随。
  });
})();
