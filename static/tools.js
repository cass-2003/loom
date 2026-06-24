/* Workbench 工具箱 —— 纯前端，离线可用 */

const TOOLS = [
  {
    id: "json", name: "JSON",
    render(box) {
      box.innerHTML = `
        <label>输入</label>
        <textarea id="t-json-in" placeholder='{"a":1}'></textarea>
        <div class="tool-row">
          <button class="btn" id="t-json-pretty">格式化</button>
          <button class="btn" id="t-json-min">压缩</button>
          <button class="btn" id="t-json-esc">转义</button>
        </div>
        <label>输出</label>
        <textarea id="t-json-out" readonly></textarea>`;
      const inp = box.querySelector("#t-json-in");
      const out = box.querySelector("#t-json-out");
      const run = (fn) => {
        try { out.value = fn(JSON.parse(inp.value)); out.classList.remove("err"); }
        catch (e) { out.value = "❌ " + e.message; }
      };
      box.querySelector("#t-json-pretty").onclick = () => run(o => JSON.stringify(o, null, 2));
      box.querySelector("#t-json-min").onclick = () => run(o => JSON.stringify(o));
      box.querySelector("#t-json-esc").onclick = () => {
        out.value = JSON.stringify(inp.value);
      };
    },
  },
  {
    id: "base64", name: "Base64",
    render(box) {
      box.innerHTML = `
        <label>文本 / Base64</label>
        <textarea id="t-b64-in"></textarea>
        <div class="tool-row">
          <button class="btn" id="t-b64-enc">编码 →</button>
          <button class="btn" id="t-b64-dec">← 解码</button>
        </div>
        <label>结果</label>
        <textarea id="t-b64-out" readonly></textarea>`;
      const inp = box.querySelector("#t-b64-in");
      const out = box.querySelector("#t-b64-out");
      box.querySelector("#t-b64-enc").onclick = () => {
        try { out.value = btoa(unescape(encodeURIComponent(inp.value))); }
        catch (e) { out.value = "❌ " + e.message; }
      };
      box.querySelector("#t-b64-dec").onclick = () => {
        try { out.value = decodeURIComponent(escape(atob(inp.value.trim()))); }
        catch (e) { out.value = "❌ 非法 Base64"; }
      };
    },
  },
  {
    id: "url", name: "URL",
    render(box) {
      box.innerHTML = `
        <label>文本 / URL 编码串</label>
        <textarea id="t-url-in"></textarea>
        <div class="tool-row">
          <button class="btn" id="t-url-enc">编码 →</button>
          <button class="btn" id="t-url-dec">← 解码</button>
        </div>
        <label>结果</label>
        <textarea id="t-url-out" readonly></textarea>`;
      const inp = box.querySelector("#t-url-in");
      const out = box.querySelector("#t-url-out");
      box.querySelector("#t-url-enc").onclick = () => out.value = encodeURIComponent(inp.value);
      box.querySelector("#t-url-dec").onclick = () => {
        try { out.value = decodeURIComponent(inp.value); }
        catch { out.value = "❌ 非法编码"; }
      };
    },
  },
  {
    id: "time", name: "时间戳",
    render(box) {
      box.innerHTML = `
        <label>Unix 时间戳 (秒/毫秒)</label>
        <input id="t-time-ts" placeholder="1735000000">
        <div class="tool-row"><button class="btn" id="t-time-toDate">→ 日期</button></div>
        <label>日期 (本地)</label>
        <input id="t-time-date" placeholder="2026-06-24 12:00:00">
        <div class="tool-row"><button class="btn" id="t-time-toTs">→ 时间戳</button></div>
        <label>结果</label>
        <textarea id="t-time-out" readonly></textarea>
        <div class="tool-row"><button class="btn" id="t-time-now">当前时间</button></div>`;
      const out = box.querySelector("#t-time-out");
      box.querySelector("#t-time-toDate").onclick = () => {
        let v = parseInt(box.querySelector("#t-time-ts").value.trim());
        if (isNaN(v)) { out.value = "❌ 无效"; return; }
        if (v < 1e12) v *= 1000;
        const d = new Date(v);
        out.value = `本地: ${d.toLocaleString()}\nUTC:  ${d.toUTCString()}\nISO:  ${d.toISOString()}`;
      };
      box.querySelector("#t-time-toTs").onclick = () => {
        const d = new Date(box.querySelector("#t-time-date").value.replace(/-/g, "/"));
        if (isNaN(d)) { out.value = "❌ 无法解析"; return; }
        out.value = `秒:   ${Math.floor(d.getTime() / 1000)}\n毫秒: ${d.getTime()}`;
      };
      box.querySelector("#t-time-now").onclick = () => {
        const d = new Date();
        out.value = `秒:   ${Math.floor(d.getTime() / 1000)}\n毫秒: ${d.getTime()}\n本地: ${d.toLocaleString()}`;
      };
    },
  },
  {
    id: "hash", name: "Hash",
    render(box) {
      box.innerHTML = `
        <label>输入文本</label>
        <textarea id="t-hash-in"></textarea>
        <label>算法</label>
        <select id="t-hash-alg">
          <option>SHA-256</option><option>SHA-1</option>
          <option>SHA-384</option><option>SHA-512</option>
        </select>
        <div class="tool-row"><button class="btn" id="t-hash-go">计算</button></div>
        <label>结果 (hex)</label>
        <textarea id="t-hash-out" readonly></textarea>
        <div class="tool-note">浏览器 SubtleCrypto 不含 MD5，故未提供。</div>`;
      box.querySelector("#t-hash-go").onclick = async () => {
        const alg = box.querySelector("#t-hash-alg").value;
        const data = new TextEncoder().encode(box.querySelector("#t-hash-in").value);
        const buf = await crypto.subtle.digest(alg, data);
        const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
        box.querySelector("#t-hash-out").value = hex;
      };
    },
  },
  {
    id: "count", name: "字数",
    render(box) {
      box.innerHTML = `
        <label>统计文本</label>
        <textarea id="t-cnt-in" placeholder="粘贴文本…"></textarea>
        <div class="tool-row"><button class="btn" id="t-cnt-cur">载入当前文件</button></div>
        <div class="tool-out" id="t-cnt-out"></div>`;
      const inp = box.querySelector("#t-cnt-in");
      const out = box.querySelector("#t-cnt-out");
      const calc = () => {
        const t = inp.value;
        const chars = [...t].length;
        const noSpace = [...t.replace(/\s/g, "")].length;
        const words = (t.trim().match(/[\w一-龥]+/g) || []).length;
        const lines = t ? t.split(/\r?\n/).length : 0;
        const cjk = (t.match(/[一-龥]/g) || []).length;
        out.innerHTML = `
          <p>字符数: <b>${chars}</b>（不含空白 ${noSpace}）</p>
          <p>中文字: <b>${cjk}</b></p>
          <p>词数: <b>${words}</b></p>
          <p>行数: <b>${lines}</b></p>`;
      };
      inp.addEventListener("input", calc);
      box.querySelector("#t-cnt-cur").onclick = () => {
        const ed = document.querySelector("#editor");
        inp.value = ed ? ed.value : ""; calc();
      };
      calc();
    },
  },
  {
    id: "diff", name: "文本对比",
    render(box) {
      box.innerHTML = `
        <label>原文 (A)</label>
        <textarea id="t-diff-a" placeholder="第一段文本…"></textarea>
        <label>新文 (B)</label>
        <textarea id="t-diff-b" placeholder="第二段文本…"></textarea>
        <div class="tool-row"><button class="btn" id="t-diff-go">对比</button></div>
        <div class="tool-diff" id="t-diff-out"></div>`;
      const out = box.querySelector("#t-diff-out");
      const esc = window.escapeHtml || (s => s);
      // 逐行 LCS diff
      const lcsDiff = (a, b) => {
        const n = a.length, m = b.length;
        const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
        for (let i = n - 1; i >= 0; i--)
          for (let j = m - 1; j >= 0; j--)
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1
              : Math.max(dp[i + 1][j], dp[i][j + 1]);
        const res = [];
        let i = 0, j = 0;
        while (i < n && j < m) {
          if (a[i] === b[j]) { res.push(["eq", a[i]]); i++; j++; }
          else if (dp[i + 1][j] >= dp[i][j + 1]) { res.push(["del", a[i]]); i++; }
          else { res.push(["add", b[j]]); j++; }
        }
        while (i < n) res.push(["del", a[i++]]);
        while (j < m) res.push(["add", b[j++]]);
        return res;
      };
      box.querySelector("#t-diff-go").onclick = () => {
        const a = box.querySelector("#t-diff-a").value.split("\n");
        const b = box.querySelector("#t-diff-b").value.split("\n");
        const rows = lcsDiff(a, b);
        let adds = 0, dels = 0;
        let html = "";
        for (const [t, line] of rows) {
          if (t === "add") adds++; else if (t === "del") dels++;
          const sign = t === "add" ? "+" : t === "del" ? "-" : " ";
          html += `<div class="td-line td-${t}"><span class="td-sign">${sign}</span>${esc(line) || "&nbsp;"}</div>`;
        }
        out.innerHTML = `<div class="td-stat"><span class="td-stat-add">+${adds}</span> <span class="td-stat-del">−${dels}</span></div>` + html;
      };
    },
  },
  {
    id: "regex", name: "正则",
    render(box) {
      box.innerHTML = `
        <label>正则模式</label>
        <input id="t-re-pat" placeholder="\\b\\w+@\\w+\\.\\w+\\b">
        <div class="tool-row" style="margin-top:6px">
          <label class="reg-flag"><input type="checkbox" id="t-re-g" checked> g</label>
          <label class="reg-flag"><input type="checkbox" id="t-re-i"> i</label>
          <label class="reg-flag"><input type="checkbox" id="t-re-m"> m</label>
          <label class="reg-flag"><input type="checkbox" id="t-re-s"> s</label>
        </div>
        <label>测试文本</label>
        <textarea id="t-re-txt" placeholder="在这里粘贴要匹配的文本…"></textarea>
        <div class="tool-out" id="t-re-info"></div>
        <label>高亮结果</label>
        <div class="tool-diff" id="t-re-out"></div>`;
      const esc = window.escapeHtml || (s => s);
      const pat = box.querySelector("#t-re-pat");
      const txt = box.querySelector("#t-re-txt");
      const out = box.querySelector("#t-re-out");
      const info = box.querySelector("#t-re-info");
      const flags = () => (box.querySelector("#t-re-g").checked ? "g" : "")
        + (box.querySelector("#t-re-i").checked ? "i" : "")
        + (box.querySelector("#t-re-m").checked ? "m" : "")
        + (box.querySelector("#t-re-s").checked ? "s" : "");
      const run = () => {
        const p = pat.value;
        if (!p) { out.innerHTML = ""; info.textContent = ""; info.style.color = ""; return; }
        let re;
        try { re = new RegExp(p, flags()); }
        catch (e) { info.textContent = "❌ " + e.message; info.style.color = "var(--danger)"; out.innerHTML = ""; return; }
        const s = txt.value;
        let matches = [], m, count = 0, guard = 0;
        if (re.global) {
          while ((m = re.exec(s)) !== null) {
            matches.push(m); count++;
            if (m.index === re.lastIndex) re.lastIndex++;
            if (++guard > 100000) break;
          }
        } else { m = re.exec(s); if (m) { matches.push(m); count = 1; } }
        // 构造高亮
        let html = "", last = 0;
        for (const mm of matches) {
          html += esc(s.slice(last, mm.index));
          html += `<mark class="re-hit">${esc(mm[0]) || "∅"}</mark>`;
          last = mm.index + mm[0].length;
        }
        html += esc(s.slice(last));
        out.innerHTML = html.replace(/\n/g, "<br>") || "<span class='muted'>（无文本）</span>";
        // 信息：匹配数 + 第一个匹配的分组
        let txtInfo = `匹配 ${count} 处`;
        if (matches.length && matches[0].length > 1) {
          const groups = matches[0].slice(1).map((g, i) => `$${i + 1}=${g === undefined ? "∅" : JSON.stringify(g)}`);
          txtInfo += "　首个分组: " + groups.join(", ");
        }
        info.textContent = txtInfo; info.style.color = "";
      };
      [pat, txt].forEach(el => el.addEventListener("input", run));
      box.querySelectorAll(".reg-flag input").forEach(c => c.addEventListener("change", run));
    },
  },
  {
    id: "color", name: "颜色",
    render(box) {
      box.innerHTML = `
        <label>选择 / 输入颜色</label>
        <div class="tool-row" style="margin-top:0;align-items:center">
          <input type="color" id="t-col-pick" value="#2f81f7" style="width:46px;height:34px;padding:2px;flex:0 0 auto">
          <input id="t-col-text" placeholder="#2f81f7 / rgb(...) / hsl(...)" style="flex:1">
        </div>
        <div class="color-preview" id="t-col-prev"></div>
        <div class="tool-out" id="t-col-out"></div>
        <label>常用色板</label>
        <div class="color-swatches" id="t-col-pal"></div>`;
      const pick = box.querySelector("#t-col-pick");
      const text = box.querySelector("#t-col-text");
      const prev = box.querySelector("#t-col-prev");
      const out = box.querySelector("#t-col-out");
      const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
      const toHex = (r, g, b) => "#" + [r, g, b].map(x => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0")).join("");
      const rgb2hsl = (r, g, b) => {
        r /= 255; g /= 255; b /= 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        let h = 0, s = 0; const l = (mx + mn) / 2;
        if (mx !== mn) {
          const d = mx - mn;
          s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
          if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
          else if (mx === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h *= 60;
        }
        return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
      };
      const hsl2rgb = (h, s, l) => {
        h /= 360; s /= 100; l /= 100;
        const hue = (p, q, t) => {
          if (t < 0) t += 1; if (t > 1) t -= 1;
          if (t < 1 / 6) return p + (q - p) * 6 * t;
          if (t < 1 / 2) return q;
          if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
          return p;
        };
        if (s === 0) { const v = l * 255; return [v, v, v]; }
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
      };
      const parse = (str) => {
        str = str.trim();
        let m;
        if ((m = str.match(/^#?([0-9a-f]{3})$/i))) {
          const h = m[1]; return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
        }
        if ((m = str.match(/^#?([0-9a-f]{6})$/i))) {
          const h = m[1]; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
        }
        if ((m = str.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i)))
          return [+m[1], +m[2], +m[3]];
        if ((m = str.match(/hsla?\(\s*(\d+)[,\s]+(\d+)%?[,\s]+(\d+)%?/i)))
          return hsl2rgb(+m[1], +m[2], +m[3]);
        return null;
      };
      const show = (r, g, b) => {
        const hex = toHex(r, g, b);
        const [h, s, l] = rgb2hsl(r, g, b);
        prev.style.background = hex;
        pick.value = hex;
        out.innerHTML =
          `<div class="col-line"><b>HEX</b> <code>${hex}</code></div>`
          + `<div class="col-line"><b>RGB</b> <code>rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})</code></div>`
          + `<div class="col-line"><b>HSL</b> <code>hsl(${h}, ${s}%, ${l}%)</code></div>`;
      };
      const fromText = () => { const c = parse(text.value); if (c) show(...c); };
      text.addEventListener("input", fromText);
      pick.addEventListener("input", () => { text.value = pick.value; show(...parse(pick.value)); });
      const pal = ["#2f81f7", "#3fb950", "#d29922", "#a371f7", "#ec6a5e", "#56b6c2",
        "#e879f9", "#fb923c", "#ef4444", "#10b981", "#6366f1", "#f59e0b",
        "#000000", "#ffffff", "#64748b", "#0ea5e9"];
      const palEl = box.querySelector("#t-col-pal");
      pal.forEach(c => {
        const sw = document.createElement("button");
        sw.className = "color-sw"; sw.style.background = c; sw.title = c;
        sw.onclick = () => { text.value = c; show(...parse(c)); };
        palEl.appendChild(sw);
      });
      show(47, 129, 247);
    },
  },
  {
    id: "uuid", name: "UUID",
    render(box) {
      box.innerHTML = `
        <div class="tool-row" style="margin-top:0;align-items:center">
          <label style="margin:0">数量</label>
          <input id="t-uuid-n" type="number" value="5" min="1" max="500" style="width:80px">
          <label class="reg-flag"><input type="checkbox" id="t-uuid-uc"> 大写</label>
          <label class="reg-flag"><input type="checkbox" id="t-uuid-nd"> 去横线</label>
        </div>
        <div class="tool-row">
          <button class="btn" id="t-uuid-go">生成 UUID v4</button>
          <button class="btn" id="t-uuid-copy">复制</button>
        </div>
        <label>结果</label>
        <textarea id="t-uuid-out" readonly></textarea>`;
      const out = box.querySelector("#t-uuid-out");
      const gen = () => {
        if (crypto.randomUUID) return crypto.randomUUID();
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        const h = [...b].map(x => x.toString(16).padStart(2, "0"));
        return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
      };
      const run = () => {
        const n = Math.min(500, Math.max(1, parseInt(box.querySelector("#t-uuid-n").value) || 1));
        const uc = box.querySelector("#t-uuid-uc").checked;
        const nd = box.querySelector("#t-uuid-nd").checked;
        const arr = [];
        for (let i = 0; i < n; i++) {
          let u = gen();
          if (nd) u = u.replace(/-/g, "");
          if (uc) u = u.toUpperCase();
          arr.push(u);
        }
        out.value = arr.join("\n");
      };
      box.querySelector("#t-uuid-go").onclick = run;
      box.querySelector("#t-uuid-copy").onclick = () => {
        out.select();
        navigator.clipboard?.writeText(out.value).catch(() => document.execCommand("copy"));
      };
      run();
    },
  },
  {
    id: "cron", name: "Cron",
    render(box) {
      box.innerHTML = `
        <label>Cron 表达式（5 段：分 时 日 月 周）</label>
        <input id="t-cron-in" value="*/15 9-17 * * 1-5" placeholder="*/15 9-17 * * 1-5">
        <div class="tool-out" id="t-cron-desc"></div>
        <label>接下来 5 次执行（本地时间，近似）</label>
        <div class="tool-out" id="t-cron-next"></div>`;
      const inp = box.querySelector("#t-cron-in");
      const desc = box.querySelector("#t-cron-desc");
      const nextEl = box.querySelector("#t-cron-next");
      const MON = ["", "一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
      const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      // 解析一段 -> 允许值集合
      const parseField = (f, min, max) => {
        const set = new Set();
        for (const part of f.split(",")) {
          let step = 1, range = part;
          const sl = part.split("/");
          if (sl.length === 2) { range = sl[0]; step = parseInt(sl[1]) || 1; }
          let lo, hi;
          if (range === "*") { lo = min; hi = max; }
          else if (range.includes("-")) { const [a, b] = range.split("-"); lo = +a; hi = +b; }
          else { lo = hi = +range; }
          if (isNaN(lo) || isNaN(hi)) throw new Error("字段非法: " + part);
          for (let v = lo; v <= hi; v += step) set.add(v);
        }
        return set;
      };
      const human = (f, min, max, names) => {
        if (f === "*") return null;
        try {
          const s = [...parseField(f, min, max)].sort((a, b) => a - b);
          return s.map(v => names ? names[v] : v).join(", ");
        } catch { return "?"; }
      };
      const run = () => {
        const parts = inp.value.trim().split(/\s+/);
        if (parts.length !== 5) { desc.textContent = "❌ 需要正好 5 段"; desc.style.color = "var(--danger)"; nextEl.textContent = ""; return; }
        const [mi, hr, dom, mon, dow] = parts;
        let fields;
        try {
          fields = {
            mi: parseField(mi, 0, 59), hr: parseField(hr, 0, 23),
            dom: parseField(dom, 1, 31), mon: parseField(mon, 1, 12),
            dow: parseField(dow.replace(/7/g, "0"), 0, 6),
          };
        } catch (e) { desc.textContent = "❌ " + e.message; desc.style.color = "var(--danger)"; nextEl.textContent = ""; return; }
        desc.style.color = "";
        // 人话
        const bits = [];
        const hm = human(mi, 0, 59), hh = human(hr, 0, 23);
        if (mi === "*" && hr === "*") bits.push("每分钟");
        else {
          bits.push("在 " + (hh ? hh + " 时" : "每小时") + " 的 " + (hm ? hm + " 分" : "每分钟"));
        }
        const hdom = human(dom, 1, 31), hmon = human(mon, 1, 12, MON), hdow = human(dow.replace(/7/g, "0"), 0, 6, WD);
        if (hdom) bits.push("每月 " + hdom + " 号");
        if (hmon) bits.push(hmon);
        if (hdow) bits.push(hdow);
        desc.textContent = bits.join("，") + " 执行";
        // 计算接下来 5 次（逐分钟扫描，最多查 ~2 年）
        const matches = (d) =>
          fields.mi.has(d.getMinutes()) && fields.hr.has(d.getHours()) &&
          fields.mon.has(d.getMonth() + 1) &&
          ((dom === "*" && dow === "*") ||
            (dom !== "*" && fields.dom.has(d.getDate())) ||
            (dow !== "*" && fields.dow.has(d.getDay())) ||
            (dom !== "*" && dow !== "*" && (fields.dom.has(d.getDate()) || fields.dow.has(d.getDay()))));
        const res = [];
        const d = new Date(); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
        let guard = 0;
        while (res.length < 5 && guard < 366 * 24 * 60 * 2) {
          if (matches(d)) res.push(d.toLocaleString());
          d.setMinutes(d.getMinutes() + 1); guard++;
        }
        nextEl.textContent = res.length ? res.join("\n") : "（未来 2 年内无匹配）";
      };
      inp.addEventListener("input", run);
      run();
    },
  },
  {
    id: "mdtable", name: "MD 表格",
    render(box) {
      box.innerHTML = `
        <div class="tool-row" style="margin-top:0;align-items:center">
          <label style="margin:0">行</label>
          <input id="t-mt-rows" type="number" value="3" min="1" max="50" style="width:70px">
          <label style="margin:0">列</label>
          <input id="t-mt-cols" type="number" value="3" min="1" max="20" style="width:70px">
          <label style="margin:0">对齐</label>
          <select id="t-mt-align" style="flex:0 0 auto;width:auto">
            <option value="left">左</option><option value="center">居中</option><option value="right">右</option>
          </select>
        </div>
        <div class="tool-row"><button class="btn" id="t-mt-build">生成网格</button></div>
        <div class="mt-grid" id="t-mt-grid"></div>
        <div class="tool-row">
          <button class="btn" id="t-mt-gen">生成 Markdown</button>
          <button class="btn" id="t-mt-copy">复制</button>
        </div>
        <label>结果</label>
        <textarea id="t-mt-out" readonly></textarea>`;
      const grid = box.querySelector("#t-mt-grid");
      const out = box.querySelector("#t-mt-out");
      let R = 3, C = 3;
      const build = () => {
        R = Math.min(50, Math.max(1, parseInt(box.querySelector("#t-mt-rows").value) || 1));
        C = Math.min(20, Math.max(1, parseInt(box.querySelector("#t-mt-cols").value) || 1));
        grid.style.gridTemplateColumns = `repeat(${C}, 1fr)`;
        grid.innerHTML = "";
        for (let r = 0; r <= R; r++)
          for (let c = 0; c < C; c++) {
            const i = document.createElement("input");
            i.className = "mt-cell"; i.dataset.r = r; i.dataset.c = c;
            i.placeholder = r === 0 ? `表头${c + 1}` : `r${r}c${c + 1}`;
            if (r === 0) i.classList.add("mt-head");
            grid.appendChild(i);
          }
      };
      const gen = () => {
        const align = box.querySelector("#t-mt-align").value;
        const sep = align === "center" ? ":---:" : align === "right" ? "---:" : ":---";
        const cell = (r, c) => {
          const el = grid.querySelector(`.mt-cell[data-r="${r}"][data-c="${c}"]`);
          return (el && el.value.trim()) || (r === 0 ? `列${c + 1}` : "");
        };
        const lines = [];
        lines.push("| " + Array.from({ length: C }, (_, c) => cell(0, c)).join(" | ") + " |");
        lines.push("| " + Array.from({ length: C }, () => sep).join(" | ") + " |");
        for (let r = 1; r <= R; r++)
          lines.push("| " + Array.from({ length: C }, (_, c) => cell(r, c)).join(" | ") + " |");
        out.value = lines.join("\n");
      };
      box.querySelector("#t-mt-build").onclick = build;
      box.querySelector("#t-mt-gen").onclick = gen;
      box.querySelector("#t-mt-copy").onclick = () => {
        out.select(); navigator.clipboard?.writeText(out.value).catch(() => document.execCommand("copy"));
      };
      build();
    },
  },
];

function initTools() {
  const tabs = document.querySelector("#tool-tabs");
  const body = document.querySelector("#tool-body");
  TOOLS.forEach((tool, i) => {
    const tab = document.createElement("div");
    tab.className = "tool-tab" + (i === 0 ? " active" : "");
    tab.textContent = tool.name;
    tab.onclick = () => {
      tabs.querySelectorAll(".tool-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      tool.render(body);
    };
    tabs.appendChild(tab);
  });
  TOOLS[0].render(body);
}
