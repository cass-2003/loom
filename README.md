# 🛠 Workbench

一个零依赖的本地工作台：VS Code 风格三栏布局，文件树 + 多标签编辑器 + Markdown 实时预览 + Git 源代码管理 + 集成终端 + 工具箱。**纯 Python 标准库后端 + 原生 JS 前端，无任何第三方运行时依赖，完全离线可用。**

## 启动

```bash
# 默认恢复上次工作区；没有历史工作区时显示欢迎页
python server.py

# 指定根目录和端口
python server.py D:\notes --port 8200
```

Windows 可直接双击 `start.bat`，或把任意文件夹**拖到 `start.bat` 上**以该文件夹为根启动。
启动后浏览器打开 `http://127.0.0.1:8765/`（或你指定的端口）。

## 打包为 exe（免装 Python）

把整个工作台编译成一个独立的 `Workbench.exe`，分发到任意 Windows 机器双击即用，目标机**无需安装 Python**：

```powershell
pip install pyinstaller          # 仅构建期需要
powershell -ExecutionPolicy Bypass -File build_exe.ps1
```

产物 `dist\Workbench.exe`（约 77MB，内含 Python 运行时、pywebview、终端 PTY 组件与 `static/` 全部离线资源）。
双击运行会打开原生无边框 Workbench 窗口：优先恢复上次工作区；没有历史工作区时显示欢迎页，让你选择一个或多个文件夹。也可命令行指定工作区根目录：`Workbench.exe D:\notes`。

## 打包安装包

生成 Windows 安装包（`Setup.exe`）时，优先使用仓库自带的一键脚本：

```powershell
powershell -ExecutionPolicy Bypass -File build_installer.ps1
```

这个脚本会先构建 `dist\Workbench.exe`，再自动查找 Inno Setup 的 `ISCC.exe` 并生成安装包。
默认产物位置：

```text
installer\Output\Workbench-Setup-0.1.0.exe
```

如果本机还没安装 Inno Setup 6，需要先安装；脚本不再要求你手动把 `ISCC.exe` 加进 `PATH`。

## 功能

VS Code 风格布局：**活动栏（图标）→ 侧边栏（随图标切换）→ 中间编辑区（标签栏 + 内容）→ 状态栏**，底部可折叠**集成终端**。

### 编辑核心

- **多标签页**：同时打开多个文件，脏标记圆点，中键 / × 关闭，未保存关闭二次确认。
- **`Ctrl+P` 快速打开**：子序列模糊匹配，匹配字符高亮，↑↓ 选择，Enter 打开。
- **行号槽**：与编辑区同步滚动，当前行高亮。
- **`Ctrl+F` 文件内查找替换**：字符串 / 正则、区分大小写、计数、上一个/下一个、替换、全部替换。
- **全文搜索**（活动栏 🔍）：跨文件递归匹配，正则 / 大小写开关，结果按文件分组，点击精确跳转到行。
- **图片**：直接预览；二进制文件提示无法编辑。

### 文件操作

- 文件树右键菜单：新建文件 / 新建文件夹 / 重命名 / 删除（样式化模态 + 危险操作确认）。
- 资源管理器顶部按钮：根目录新建文件 / 文件夹 / 刷新。
- 重命名/删除联动更新已打开标签与编辑区。

### 源代码管理（Git，仿 Cursor 侧栏）

- **更改 / 暂存**：提交信息框 + 提交，`暂存的更改 / 更改` 可折叠分组（`M/A/D/U` 状态色）；文件行 hover 浮出 `打开 / 丢弃 / 暂存±`，单击看 diff，组级一键暂存/取消。`Ctrl+Enter` 快捷提交，可 `推送 / 初始化`。
- **图形**：侧栏紧凑提交图——SVG 多 lane 节点 + 连线（HEAD 空心环）+ 单行消息 + 分支/标签胶囊；分支选择器切「所有分支 / 某分支」；悬浮弹详情卡；**点提交行内联展开改动文件，点文件看该提交的 diff**。
- **深化**：单文件历史 · blame 逐行作者着色 · 分支新建/检出/删除 · stash 储藏/弹出。
- 侧栏宽度可**拖动调节**（记忆到本地）。

### Markdown 全家桶

- 左源码右渲染**实时预览**，顶栏切换 `分屏 / 源码 / 预览`，代码块语法高亮。
- **Mermaid** 流程图 · **KaTeX** 数学公式 · **大纲 TOC** 跳转 · 导出 **HTML / 打印 PDF**。
- **任务清单**预览中可点击勾选，回写源码 `[ ] ⇄ [x]`。
- **粘贴图片**自动存盘到 `assets/` 并插入 `![](...)` 链接。
- 分屏下**编辑 ↔ 预览滚动同步**。

### 生产力

- **命令面板 `Ctrl+Shift+P`**：模糊搜索并执行全部动作。
- **设置面板**：字号 / Tab 宽度 / 强调色 / 自动换行 / 自动保存（持久化）。
- **工作区记忆**：重开自动恢复上次打开的标签、主题、侧栏宽度。
- **状态栏**：行列、字数、语言/类型、编码、Git 分支。
- **快捷键帮助**（`?`）。
- **便签 / Todo**（活动栏 📓）：待办增删改勾选拖拽排序 + 自由便签，后端持久化。
- **工具箱**（活动栏 🧰，纯前端）：JSON 格式化/压缩、Base64、URL 编解码、时间戳 ⇄ 日期、Hash（SHA-1/256/384/512）、字数统计、文本对比（diff）、正则测试器、颜色转换（HEX/RGB/HSL）、UUID 生成、Cron 解析、Markdown 表格生成。

### 集成终端（本机）

- 底部可折叠终端面板：命令输入 + 输出（stderr 标红）、命令历史（↑↓）、清屏、cwd 显示。
- **运行当前文件**（`.py` / `.js` / `.sh` / `.ps1`）：编辑区按钮，输出进终端。
- **任务运行器**：自动读取 `package.json` scripts 与 `Makefile` 目标，一键运行 npm / make。
- ⚠️ 命令**仅在服务器本机 `127.0.0.1` 执行**，复用 CSRF + 路径约束 + 任务名白名单。UI 明确标注"在服务器本机执行命令"。

## 安全

- 所有文件读写、终端 cwd、运行文件均限制在根目录内，`..` 路径穿越被拒绝。
- 写操作 / 命令执行经 **CSRF 校验**（要求 `Content-Type: application/json` + 同源 Origin/Host + `Sec-Fetch-Site`）。
- 默认只监听 `127.0.0.1`，不对外网开放。
- 保存使用字节写入，保留原始换行（不强制 CRLF）；文件切换有竞态令牌；图片 blob URL 及时释放。

## 目录结构

```
workbench/
├─ server.py          # 后端 (标准库 http.server)：文件/搜索/Git/终端/上传/便签 API
├─ start.bat          # Windows 一键启动
└─ static/
   ├─ index.html
   ├─ style.css
   ├─ app.js          # 视图/文件树/标签/编辑/预览/diff/Markdown/搜索跳转
   ├─ git.js          # 源代码管理（图形/提交详情/历史/blame/分支/stash）
   ├─ search.js       # 全文搜索视图
   ├─ workbench.js    # 命令面板/设置/工作区记忆/状态栏
   ├─ terminal.js     # 集成终端/运行文件/任务运行器
   ├─ tools.js        # 工具箱（12 个工具）
   ├─ icons.js        # 线性图标集 (Lucide)
   └─ vendor/         # marked + highlight.js + katex + mermaid (本地, 离线)
```

## 技术约束

- 后端只用 Python 标准库，无 `pip` 依赖。
- 前端无 CDN，第三方库本地 vendor 到 `static/vendor/`。
- 单用户本地开发工具，非多租户/公网服务。
