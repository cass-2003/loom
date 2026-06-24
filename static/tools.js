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
