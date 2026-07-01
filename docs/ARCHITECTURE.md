# Loom 架构文档

> 最后更新：2026-07-01

## 概览

Loom 是一个**本地优先、完全离线**的桌面工作台。VS Code 风格布局，Codex/Cursor 式生态，零 pip 依赖。

```
┌────────────────────────────────────────────────────────┐
│                    桌面 Shell                           │
│            desktop.py (pywebview, 可选)                 │
├────────────────────────────────────────────────────────┤
│                   HTTP Server                          │
│         ThreadingHTTPServer @ 127.0.0.1                │
├───────────┬───────────┬───────────┬───────────────────┤
│  Handler  │  Mixin A  │  Mixin B  │   Mixin C/D       │
│  (路由)   │  (文件)   │  (Git)    │ (终端/项目)        │
├───────────┴───────────┴───────────┴───────────────────┤
│              wb/ Python Package                        │
│   state · config · paths · run · shell · classify      │
├────────────────────────────────────────────────────────┤
│              static/ 前端 (原生 JS)                     │
│   app · workbench · tasks · ecosystem · git · tools    │
│   viewers · terminal · project · notes · search        │
└────────────────────────────────────────────────────────┘
```

## 技术栈

| 层 | 技术 | 依赖 |
|---|------|------|
| 后端 | Python 3.12 标准库 (`http.server`, `subprocess`, `json`, `pathlib`) | 零 pip |
| 前端 | 原生 JavaScript (IIFE) + CSS Variables | 零构建 |
| 编辑器 | Vditor (Markdown WYSIWYG) + 自研代码编辑 | vendor 内置 |
| 桌面壳 | pywebview (可选) | 仅打包时 |
| 打包 | PyInstaller + Inno Setup | 构建时 |

## 目录结构

```
loom/
├── server.py              # 入口（12 行，import wb.main.main）
├── desktop.py             # pywebview 桌面壳（可选）
├── start.bat              # Windows 快捷启动
├── build_exe.ps1          # PyInstaller 构建脚本
├── Loom.spec              # PyInstaller 配置
│
├── wb/                    # 后端 Python 包（3,442 行）
│   ├── __init__.py        # 空包标记
│   ├── main.py            # main() + argparse（78 行）
│   ├── state.py           # 全局可变状态：ROOT, WORKSPACE_ROOTS, locks（28 行）
│   ├── constants.py       # 常量：TEXT_EXTS, IMAGE_EXTS, MAX_TEXT_BYTES（26 行）
│   ├── config.py          # 配置管理：load/save/workspace helpers（193 行）
│   ├── paths.py           # 路径安全：safe_resolve, within_root_real（130 行）
│   ├── handler.py         # HTTP Handler + Mixin 组装 + 路由（280 行）
│   ├── api_files.py       # FilesMixin：文件树/读写/搜索/便签（417 行）
│   ├── api_git.py         # GitMixin：25 个 Git 操作（479 行）
│   ├── api_terminal.py    # TerminalMixin：终端/执行/上传（286 行）
│   ├── api_project.py     # ProjectMixin：项目状态/任务/会话/生态/Playbook（688 行）
│   ├── shell.py           # TermSession：ConPTY/winpty/pipe 三后端（688 行）
│   ├── run.py             # 命令执行：run_shell, run_argv（99 行）
│   ├── git_utils.py       # run_git()（20 行）
│   └── classify.py        # 项目分类 + Makefile 解析（30 行）
│
├── static/                # 前端（10,466 行 JS + 2,829 行 CSS）
│   ├── index.html         # 单页 HTML 骨架
│   ├── style.css          # 全局样式 + CSS Variables 主题
│   ├── app.js             # 核心：编辑器/标签/文件树/侧栏/命令面板（3,653 行）
│   ├── workbench.js       # 黏合层：命令面板/设置/快捷键/状态栏（1,571 行）
│   ├── tasks.js           # 任务面板：工作流任务/Agent 会话（1,440 行）
│   ├── git.js             # Git 面板：暂存/提交/分支/历史/blame（1,207 行）
│   ├── ecosystem.js       # 生态面板：Skills/Playbooks 展示与执行（635 行）
│   ├── tools.js           # 工具箱：12 个离线开发工具（702 行）
│   ├── terminal.js        # 终端面板：xterm.js 前端（含 WebSocket 轮询）
│   ├── project.js         # 项目记忆面板
│   ├── search.js          # 全文搜索面板
│   ├── notes.js           # 便签面板
│   ├── split.js           # 分屏编辑逻辑
│   ├── splitter.js        # 拖拽分隔条
│   ├── icons.js           # SVG 图标注册
│   ├── desktop-ui.js      # 桌面壳 UI 适配
│   ├── viewers/           # 文件查看器
│   │   ├── _registry.js   # 查看器注册表
│   │   ├── pdf.js         # PDF 查看器 (pdf.js)
│   │   ├── epub.js        # EPUB 阅读器 (epub.js)
│   │   ├── docx.js        # DOCX 渲染 (docx-preview)
│   │   ├── sheet.js       # Excel/CSV (SheetJS)
│   │   ├── font.js        # 字体预览
│   │   ├── archive.js     # ZIP/JAR 浏览 (jszip)
│   │   └── imageplus.js   # 图片增强查看
│   └── vendor/            # 第三方库（本地内置，无 CDN）
│       ├── vditor/        # Markdown WYSIWYG 编辑器
│       ├── xterm/         # 终端模拟器
│       ├── pdfjs/         # PDF 渲染
│       ├── katex/         # 数学公式
│       ├── marked.min.js  # Markdown 解析
│       ├── highlight.min.js # 代码高亮
│       ├── mermaid.min.js # 流程图
│       └── ...            # docx-preview, sheetjs, epubjs, jszip 等
│
└── docs/                  # 项目文档
    ├── INDEX.md
    ├── ARCHITECTURE.md    # ← 本文件
    └── ...
```

## 后端架构

### Mixin 模式

Handler 类通过 Python 多重继承组合 4 个 Mixin，每个 Mixin 负责一组 API：

```python
class Handler(FilesMixin, GitMixin, TerminalMixin, ProjectMixin, BaseHTTPRequestHandler):
```

| Mixin | 职责 | API 数量 |
|-------|------|----------|
| `FilesMixin` | 文件树、读写、搜索、FS 操作、便签 | 11 |
| `GitMixin` | 暂存/提交/推送/分支/stash/blame/log | 18 |
| `TerminalMixin` | 终端会话、命令执行、文件运行、任务运行 | 9 |
| `ProjectMixin` | 项目状态、任务工作流、Agent 会话、生态、Playbook、工作区 | 16 |

**依赖规则**：
- 所有 Mixin 可调用 `self._json()`, `self._err()`, `self._read_json_body()` — 定义在 Handler 基类
- Mixin 之间**不互相调用**
- 共享逻辑通过 `wb.*` 模块级函数：`safe_resolve`, `run_git`, `run_shell` 等

### 全局状态

`wb/state.py` 集中管理全局可变状态：

```python
ROOT: Path | None       # 当前活跃工作区根目录
WORKSPACE_ROOTS: list   # 多工作区根目录列表
_CFG_LOCK: RLock        # 配置读写锁（RLock 防嵌套死锁）
BUNDLE_DIR: Path        # 应用资源目录（打包时 sys._MEIPASS）
STATIC_DIR: Path        # 静态文件目录
```

**跨模块修改约定**：使用 `import wb.state` 然后 `wb.state.ROOT = ...`，避免 `from wb.state import ROOT` 的值拷贝陷阱。

### 路由表

Handler 中的 `_dispatch_get` / `_dispatch_post` 维护路径→方法名的映射字典，通过 `getattr(self, method_name)` 解析到各 Mixin 的方法。

### 终端架构

`wb/shell.py` 的 `TermSession` 支持三种后端：

| 后端 | 平台 | 特点 |
|------|------|------|
| ConPTY | Windows 10+ | 原生伪终端，完整 ANSI 支持 |
| winpty | Windows 旧版 | 回退方案 |
| pipe | 跨平台 | subprocess + pty，最小实现 |

终端通过 HTTP 轮询（非 WebSocket）传输，前端 xterm.js 渲染。

## 前端架构

### 模块组织

前端使用 IIFE (立即调用函数表达式) 模式隔离模块，通过 `window.*` 导出公共接口：

```
index.html 按顺序加载：
  icons.js → style.css → app.js → workbench.js →
  tasks.js → git.js → ecosystem.js → tools.js →
  terminal.js → project.js → search.js → notes.js →
  split.js → splitter.js → desktop-ui.js → viewers/*
```

### 关键子系统

| 子系统 | 文件 | 说明 |
|--------|------|------|
| 编辑器 | app.js | 多标签、Vditor/代码双模式、语法高亮 |
| 命令面板 | workbench.js | Ctrl+Shift+P，79+ 注册动作，风险标签 |
| 文件树 | app.js | 虚拟滚动、拖拽、右键菜单 |
| Git | git.js | 暂存/提交/推送、提交图、文件历史、blame |
| 任务 | tasks.js | 工作流任务 + Agent 会话，依赖图 |
| 生态 | ecosystem.js | Skills/Playbooks 展示、风险过滤、执行 |
| 终端 | terminal.js | xterm.js + HTTP 轮询 |
| 查看器 | viewers/*.js | 7 种格式：PDF/EPUB/DOCX/Excel/字体/图片/ZIP |
| 工具箱 | tools.js | 12 个离线工具 |
| 分屏 | split.js | 水平/垂直分屏编辑 |
| Session | app.js 尾部 | 自动保存/恢复工作区快照 |

### 主题系统

CSS Variables 驱动，深色/浅色双主题。通过 `data-theme` 属性切换：

```css
:root[data-theme="dark"]  { --bg: #1e1e1e; --fg: #cccccc; ... }
:root[data-theme="light"] { --bg: #ffffff; --fg: #333333; ... }
```

`--on-accent` 变量确保强调色背景上的文字对比度。

## API 清单

### GET 端点

| 路径 | 说明 |
|------|------|
| `/api/config` | 获取配置和工作区信息 |
| `/api/tree?path=` | 文件树（目录内容） |
| `/api/file?path=` | 读取文件内容 |
| `/api/raw?path=` | 原始二进制文件 |
| `/api/files/flat` | 扁平文件列表（模糊搜索用） |
| `/api/search?q=&regex=&case=` | 全文搜索 |
| `/api/notes` | 获取便签 |
| `/api/git/status` | Git 状态 |
| `/api/git/diff` | Git diff |
| `/api/git/branches` | 分支列表 |
| `/api/git/log?ref=` | 提交历史 |
| `/api/git/show?h=` | 提交详情 |
| `/api/git/commit-files?h=` | 提交文件列表 |
| `/api/git/commit-diff?h=&path=` | 单文件 diff |
| `/api/git/file-log?path=` | 文件历史 |
| `/api/git/blame?path=` | blame 注解 |
| `/api/git/stash` | stash 列表 |
| `/api/tasks` | npm/make 任务列表 |
| `/api/term/shells` | 可用 Shell 列表 |
| `/api/project-state/:name` | 项目状态文件内容 |
| `/api/project-state-file/:name` | 项目状态文件原始内容 |
| `/api/project-roadmap` | 路线图文件内容 |
| `/api/workflow-tasks` | 工作流任务列表 |
| `/api/agent-sessions` | Agent 会话列表 |
| `/api/ecosystem` | Skills + Playbooks 生态 |

### POST 端点

| 路径 | 说明 |
|------|------|
| `/api/save` | 保存文件 |
| `/api/fs/create` | 创建文件/目录 |
| `/api/fs/rename` | 重命名 |
| `/api/fs/delete` | 删除 |
| `/api/notes` | 保存便签 |
| `/api/upload-image` | 上传图片 |
| `/api/exec` | 执行 Shell 命令 |
| `/api/run-file` | 运行当前文件 |
| `/api/run-task` | 运行 npm/make 任务 |
| `/api/workflow-tasks` | 保存工作流任务 |
| `/api/agent-sessions` | 保存 Agent 会话 |
| `/api/playbook/run` | 执行 Playbook 步骤 |
| `/api/git/commit` | Git 提交 |
| `/api/git/push` | Git 推送 |
| `/api/git/init` | Git 初始化 |
| `/api/git/stage` | 暂存文件 |
| `/api/git/unstage` | 取消暂存 |
| `/api/git/discard` | 丢弃修改 |
| `/api/git/checkout` | 切换分支 |
| `/api/git/branch-create` | 创建分支 |
| `/api/git/branch-delete` | 删除分支 |
| `/api/git/stash-save` | 保存 stash |
| `/api/git/stash-pop` | 弹出 stash |
| `/api/set-root` | 设置工作区根 |
| `/api/create-workspace` | 创建新工作区 |
| `/api/recent/remove` | 移除最近工作区 |
| `/api/project-state/append` | 追加项目状态 |
| `/api/project-state/save` | 保存项目状态 |
| `/api/term/open` | 打开终端 |
| `/api/term/input` | 终端输入 |
| `/api/term/resize` | 终端调整大小 |
| `/api/term/close` | 关闭终端 |

## 安全模型

### 绑定

服务器默认绑定 `127.0.0.1`，仅本机可访问。`--host` 参数可改，但不建议。

### CSRF 防护（四重校验）

所有 POST 请求经过 `_check_csrf()`：

1. **Content-Type** — 必须是 `application/json`（阻止 HTML form 提交）
2. **Host** — 必须解析为 loopback 地址
3. **Sec-Fetch-Site** — 如果存在，必须是 `same-origin`
4. **Origin** — 如果存在，必须匹配 Host

### CSP (Content Security Policy)

```
default-src 'self';
script-src 'self';              # 无 unsafe-eval/unsafe-inline
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
object-src 'none';
base-uri 'none';
form-action 'none';
```

### 其他防护

| 机制 | 说明 |
|------|------|
| `Cross-Origin-Resource-Policy: same-origin` | 防跨域嵌入 |
| `X-Frame-Options: DENY` | 防 clickjacking |
| `X-Content-Type-Options: nosniff` | 防 MIME 嗅探 |
| `safe_resolve()` | 路径遍历双重阻断（resolve + parent 检查） |
| `SANITIZE_DROP` | XSS 标签黑名单（含 SVG/MATH/FOREIGNOBJECT） |
| `escHtml()` | 统一 HTML 转义函数 |
| Playbook 目录限制 | `/api/playbook/run` 仅允许执行 playbooks/ 下的文件 |

## 工作流功能

### 任务依赖图

任务支持 `depends_on` 字段（最多 10 个任务 ID），状态守卫阻止前置任务未完成时开始。

```json
{
  "id": "task-20260701-143000-a1b2",
  "title": "实现登录页",
  "status": "todo",
  "depends_on": ["task-20260701-142900-c3d4"],
  "complexity": "medium"
}
```

### 任务展开

"展开子任务" 按钮将大任务拆分为 3 个链式子任务，自动设置 `depends_on` 形成执行序列。

### Playbook 执行

Playbook Markdown 文件中的命名代码块可直接执行：

````markdown
```bash name=check-deps
npm outdated
```

```bash name=run-tests
npm test
```
````

执行结果记录到 `state/PLAYBOOK-LOG.md`。

### Session 快照

自动每 30 秒保存工作区快照到 `localStorage`：
- 打开的标签页列表和活跃标签
- 当前活跃文件
- UI 状态（侧栏折叠、主题）

页面重新加载时自动恢复（同工作区）。

## 构建与打包

### 开发模式

```bash
python server.py --port 8800        # 启动开发服务器
python server.py D:\my-project      # 打开指定工作区
```

### 桌面应用

```powershell
# 构建 EXE
powershell -File build_exe.ps1

# 输出：dist\Loom.exe (~78MB)
```

PyInstaller 通过 `Loom.spec` 配置，`desktop.py` 作为入口，内嵌 pywebview 提供原生窗口。

### Inno Setup 安装包

构建完成后可通过 Inno Setup 打包为 `.exe` 安装程序。

## 代码统计

| 模块 | 行数 | 文件数 |
|------|------|--------|
| wb/ (后端) | 3,442 | 14 |
| static/*.js (前端) | 10,466 | 19 |
| static/style.css | 2,829 | 1 |
| desktop.py | ~100 | 1 |
| **总计** | **~16,800** | **35** |

不含 vendor/ 第三方库和查看器。

## 演进路线

详见 `docs/Loom 产品分析与演进路线.md`。

### 已完成

- [x] Mixin 架构拆分（server.py → wb/ 包）
- [x] 全量安全审计与加固
- [x] Playbook 可执行步骤 + 执行日志
- [x] 任务依赖图 + 展开子任务
- [x] Session 快照自动持久化

### 下一步 (P1)

- [ ] Hooks 生命周期 (`on-add`/`on-modify` + JSON stdio)
- [ ] 记忆三层分区 (user/session/agent)
- [ ] `.loom/` per-project JSON 能力配置

### 长期 (P2)

- [ ] `loom next` 智能推荐下一任务
- [ ] Playbook dry-run 模式
- [ ] 能力输出多视图（列表/看板/表格）
- [ ] Tauri 重写替代 pywebview（78MB → 5MB）
