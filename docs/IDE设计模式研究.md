# IDE 设计模式研究 — Loom 可学习的能力

> 基于 VS Code、Eclipse Theia、Lite XL、Atheos 四个项目的研究
> 编写日期：2026-07-01

---

## 一、Git/SCM 系统

### IDE 标准做法

**VS Code** 的 Git 集成围绕 `autoRepositoryDetection` 设置构建，支持四个模式：

| 模式 | 行为 |
|------|------|
| `true` | 扫描工作区根目录及打开的编辑器所在的仓库 |
| `false` | 完全禁用自动检测 |
| `subFolders` | 递归扫描工作区根目录的子目录寻找 `.git` |
| `openEditors` | 仅当打开的编辑器文件所在目录包含 `.git` 时才检测 |

多仓库并存时，VS Code 的 Source Control Repositories 视图可以同时显示多个仓库的状态，通过 `scm.repositories.selectionMode` 控制单仓库/多仓库切换。每个仓库有独立的暂存区、分支状态和提交历史。

**Theia** 复用了 VS Code 的 Git 扩展协议（通过 LSP 风格的 SCM Provider API），但以模块化方式实现，不依赖 VS Code 的闭源组件。

**Atheos** 内置了基本的 Git 支持（commit/push/pull），作为 PHP 后端的一个 component 模块实现。

### Loom 当前实现

- `find_repo()` 从当前目录向上查找 `.git`，**只返回一个仓库**（`paths.py:118-130`）
- `_resolve_repo()` 对每个 API 调用重新寻找仓库（`api_git.py:17-32`）
- 前端 `gitState` 只维护单一仓库状态（`git.js:10-22`）
- 没有仓库自动发现或子目录扫描机制

### 具体改进方案

1. **仓库缓存**：在 `wb/state.py` 增加 `GIT_REPOS: dict[Path, Path]` 缓存（工作区根 → 仓库根），避免每次 API 调用重新遍历
2. **子目录扫描**：加载工作区时一次性扫描 1-2 层子目录的 `.git`，填充 `GIT_REPOS`
3. **多仓库 UI**：当检测到 >1 个仓库时，在 Git 面板顶部增加仓库选择器下拉框
4. **API 适配**：所有 `/api/git/*` 端点接受可选的 `repo` 参数指定仓库路径

---

## 二、工作区概念

### IDE 标准做法

**VS Code** 的工作区分两种形态：

- **单文件夹工作区**：打开一个目录，设置存于 `.vscode/settings.json`
- **多根工作区**：`.code-workspace` 文件定义多个文件夹 + 共享设置

`.code-workspace` 文件格式：
```json
{
  "folders": [
    { "path": "frontend" },
    { "path": "backend" },
    { "path": "/absolute/path/to/shared-lib" }
  ],
  "settings": {
    "editor.tabSize": 2
  },
  "extensions": {
    "recommendations": ["dbaeumer.vscode-eslint"]
  }
}
```

**设置优先级链**（低到高）：User Settings → Workspace Settings（`.code-workspace` 文件）→ Folder Settings（`.vscode/settings.json`）。注意：只有「资源级」设置（如缩进、格式化）支持按文件夹覆盖，「窗口级」设置（如 UI 布局）只在 User/Workspace 级生效。

**Theia** 使用 `.theia/` 目录存储项目设置，避免与 VS Code 的 `.vscode/` 冲突，同时支持多根工作区。

### Loom 当前实现

- `config.py` 管理全局配置 `%APPDATA%/Loom/config.json`，包含 `lastRoot`、`recent`、`currentWorkspace`、`recentWorkspaces`
- `state.py` 的 `WORKSPACE_ROOTS` 支持多根（已有基础数据结构）
- 前端可以在工作区间切换（`/api/set-root`）
- **没有**项目级设置文件（`.loom/` 目录尚未实现，列在 P1 路线图中）

### Loom 应该怎么做

1. **`.loom/settings.json`** — 每个项目根目录下，存储编辑器偏好（缩进、自动保存、语言关联等）
2. **设置合并逻辑** — 全局 `config.json` → `.loom/settings.json`，用 `dict.update()` 简单覆盖即可（Loom 不需要 VS Code 那么复杂的资源级/窗口级区分）
3. **`.loom/workspace.json`** — 多根工作区定义文件（类似 `.code-workspace`），包含 `folders` 数组
4. **API 端点** — `GET /api/settings`（合并后设置）、`POST /api/settings`（写入项目级设置）

---

## 三、文件监视 (File Watcher)

### IDE 标准做法

**VS Code** 使用 `@parcel/watcher`（替代了早期的 chokidar）作为核心文件监视库：
- 利用 OS 原生 API（Windows: `ReadDirectoryChangesW`、macOS: `FSEvents`、Linux: `inotify`）
- 运行在独立的 `UtilityProcess` 中，不阻塞主线程
- 支持 `files.watcherExclude` 排除大目录（如 `node_modules`）
- 区分递归监视（整个工作区）和非递归监视（单个打开的文件）
- 自动去重：同一路径不会重复注册 watcher

**Lite XL** 使用 C 语言实现的 `dirmonitor` 模块：
- 平台原生后端（Windows: `ReadDirectoryChangesW`、Linux: `inotify`、macOS: `FSEvents`）
- 当 inotify watch 数量超限时自动降级为轮询模式
- 事件去抖（500ms）后通知 Lua 层刷新文件树

**Atheos** 作为 PHP Web IDE，不做文件监视——每次操作都重新读取文件系统。

### Loom 当前实现

- **没有文件监视**。Grep 搜索 `fileWatcher|auto.save|autoSave|onChange` 仅找到 auto-save 和 session snapshot，无 FS 监视代码
- 文件树只在用户手动刷新或执行操作后更新
- 外部编辑文件后，编辑器不感知变化

### 实现方案

**推荐方案：Python 标准库轮询（零依赖原则）**

```python
# wb/watcher.py
import threading, time
from pathlib import Path

class DirWatcher(threading.Thread):
    """轻量文件监视：定期扫描文件 mtime，检测变化。"""
    def __init__(self, roots, interval=2.0, on_change=None):
        super().__init__(daemon=True)
        self.roots = roots
        self.interval = interval
        self.on_change = on_change
        self._snapshot = {}  # path → mtime

    def run(self):
        self._snapshot = self._scan()
        while True:
            time.sleep(self.interval)
            current = self._scan()
            diff = self._diff(self._snapshot, current)
            if diff and self.on_change:
                self.on_change(diff)
            self._snapshot = current

    def _scan(self):
        result = {}
        for root in self.roots:
            for p in root.rglob("*"):
                if p.is_file() and not self._excluded(p):
                    try: result[str(p)] = p.stat().st_mtime
                    except OSError: pass
        return result

    def _excluded(self, p):
        parts = p.parts
        return any(x in ('.git','node_modules','__pycache__','.venv') for x in parts)
```

前端配合：新增 `GET /api/fs/changes` 端点返回变化列表，前端每 3-5 秒轮询，有变化时刷新文件树 + 弹出已打开文件的「文件已变化，是否重载」提示。

**进阶方案（如后续允许可选依赖）**：使用 `watchdog` 库利用 OS 原生事件，性能远优于轮询。

---

## 四、状态栏增强

### IDE 标准做法

**VS Code 状态栏布局：**

| 位置 | 左侧（工作区级） | 右侧（文件级/上下文级） |
|------|------------------|----------------------|
| 项目 | Git 分支 + 同步状态 | 行:列 |
| 项目 | 问题数/警告数 | 缩进（空格/Tab + 大小） |
| 项目 | 运行中的任务 | 编码（UTF-8/GBK 等） |
| | | 行尾序列（LF/CRLF） |
| | | 语言模式 |
| | | 通知铃铛 |

扩展通过 `window.createStatusBarItem(alignment, priority)` 添加项目，`priority` 数值越高越靠近边缘。每个项目可注册点击命令。

**Lite XL** 的状态栏由 Lua 插件驱动，默认显示：行:列、选区、缩进、文件类型、当前目录。

### Loom 当前实现

状态栏（`index.html:538-548`）已有：
- 左侧：`#status-file`（文件名）、`#status-branch`（Git 分支）、`#status-msg`（消息）
- 右侧：`#status-term`（终端切换）、`#status-words`（字数）、`#status-lang`（语言）、`#status-pos`（行:列）、`#status-enc`（编码，硬编码 "UTF-8"）

### Loom 可加的信息项

| 新增项 | 位置 | 实现复杂度 | 说明 |
|--------|------|-----------|------|
| 缩进显示（Spaces:4 / Tabs） | 右侧 | 低 | 从编辑器内容检测，点击可切换 |
| 行尾序列（LF/CRLF） | 右侧 | 低 | 后端读取文件时返回 EOL 信息 |
| 选区信息（N 字符选中 / N 行选中） | 右侧 | 低 | 替代或扩展当前行:列显示 |
| Git 同步状态（↑2 ↓3） | 左侧 | 中 | `git rev-list --count --left-right @{u}...HEAD` |
| 文件大小 | 右侧 | 低 | 后端 `/api/file` 响应中已可获取 |
| 可点击的语言模式 | 右侧 | 中 | 点击弹出语言选择器，手动切换高亮 |
| 问题/警告计数 | 左侧 | 高 | 需要集成 linter，暂缓 |

**实现建议**：在 `updateStatusBar()` 中增加缩进检测逻辑（扫描前 20 行判断 tab vs spaces），添加 `#status-indent` 和 `#status-eol` 元素。

---

## 五、Auto-Save

### IDE 标准做法

**VS Code** 的 `files.autoSave` 支持四种模式：

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `off` | 手动 Ctrl+S | 精确控制 |
| `afterDelay` | 修改后 N 毫秒自动保存（默认 1000ms） | 最常用 |
| `onFocusChange` | 编辑器失去焦点时保存 | 平衡型 |
| `onWindowChange` | 窗口失去焦点时保存 | 保守型 |

`afterDelay` 模式下，`files.autoSaveDelay` 可配置延迟（100-∞ ms）。自动保存与 `formatOnSave` 交互：仅在手动保存时触发格式化，自动保存不触发（避免光标跳动）。

### Loom 当前实现

`workbench.js:116-134` 已实现基本的 auto-save：
- `settings.autoSave` 布尔开关
- 检测编辑器 `input` 事件，1500ms 延迟后自动调用 `window.saveFile()`
- 设置面板有开关按钮

### 配置方案

Loom 的 auto-save 已经可用，但可以增强：

1. **模式扩展** — 将 `autoSave: boolean` 改为 `autoSave: "off" | "afterDelay" | "onFocusChange"`
2. **延迟可配** — 增加 `autoSaveDelay` 设置项（默认 1500ms），在设置面板中用滑块或输入框
3. **焦点保存** — 监听 `blur` 事件：
   ```javascript
   editor.addEventListener("blur", () => {
     if (settings.autoSave === "onFocusChange" && state.dirty) saveFile();
   });
   ```
4. **保存指示器** — 自动保存时在状态栏闪现「已自动保存」而非完全静默，给用户信心

---

## 六、Breadcrumb 导航

### IDE 标准做法

**VS Code** 的面包屑导航栏位于编辑器标题之上，显示两层信息：

1. **文件路径面包屑** — 工作区根 → 文件夹 → ... → 文件名，每个段可点击展开同级目录列表
2. **符号面包屑** — 当前光标所在的符号路径（类 → 方法 → 闭包），依赖 Language Server 的 `DocumentSymbolProvider`

配置项：
- `breadcrumbs.enabled` — 总开关
- `breadcrumbs.filePath` — `on` / `off` / `last`（仅显示最后一段）
- `breadcrumbs.symbolPath` — 同上
- `breadcrumbs.symbolSortOrder` — 符号排序方式

快捷键 `Ctrl+Shift+.` 聚焦面包屑，方向键导航，Enter 展开/确认。

### Loom 当前实现

`#crumb` 元素（`index.html:20`）仅显示**纯文本路径**（`app.js:1622`：`$("#crumb").textContent = path`），不可交互，不可导航。在 blame/diff 视图会覆盖显示前缀（`git.js:1152`）。

### 轻量实现方案

```javascript
function renderBreadcrumb(filePath) {
  const crumb = $("#crumb");
  crumb.innerHTML = "";
  const parts = filePath.split("/").filter(Boolean);
  parts.forEach((part, i) => {
    if (i > 0) crumb.appendChild(Object.assign(
      document.createElement("span"), { textContent: " › ", className: "crumb-sep" }));
    const seg = document.createElement("span");
    seg.className = "crumb-segment";
    seg.textContent = part;
    seg.title = parts.slice(0, i + 1).join("/");
    // 点击路径段 → 在文件树中定位并展开该目录
    if (i < parts.length - 1) {
      seg.classList.add("crumb-clickable");
      seg.onclick = () => revealInTree(parts.slice(0, i + 1).join("/"));
    }
    crumb.appendChild(seg);
  });
}
```

- **第一阶段**：路径段可点击，定位到文件树对应目录
- **第二阶段**：点击路径段展开下拉列表，显示同级文件和目录
- **符号导航**：暂不实现（需要 LSP 或 Tree-sitter，超出零依赖范围）

---

## 七、语言检测与文件关联

### IDE 标准做法

**VS Code** 的语言检测使用三级策略：

1. **文件扩展名** — 扩展通过 `contributes.languages` 注册 `extensions` 数组（如 `.py` → Python）
2. **文件名精确匹配** — `filenames` 数组（如 `Dockerfile`、`Makefile`、`.gitignore`）
3. **首行正则** — `firstLine` 字段（如 `^#!/.*\\bpython` → Python、`^<\\?xml` → XML）

每种语言有唯一 `id`（如 `python`、`javascript`），用于设置关联和语法高亮选择。用户可通过 `files.associations` 手动覆盖（如 `"*.wxss": "css"`）。

### Loom 当前实现

- `langOf(path)`（`workbench.js:152-156`）——纯扩展名映射表 `EXT_LANG`，约 25 个条目，无名称匹配或首行检测
- `fileIcon(entry)`（`app.js:247-255`）——5 个图标类别：folder / markdown / image / binary / code / text
- 高亮使用 `highlight.js` 自动检测（`hljs.highlightAuto`），不受上面映射影响

### Loom 的 highlight.js 如何增强

1. **扩展映射表** — 将 `EXT_LANG` 扩展到 50+ 条目，增加：
   - 无扩展名文件名映射：`Dockerfile` → Docker、`Makefile` → Makefile、`.gitignore` → Git Ignore、`Vagrantfile` → Ruby
   - 配置文件：`.yml`/`.yaml` → YAML、`.toml` → TOML、`.env` → Properties

2. **首行检测** — 在后端 `/api/file` 响应中增加 `detectedLang` 字段：
   ```python
   FIRST_LINE_PATTERNS = [
       (r'^#!.*\bpython', 'python'),
       (r'^#!.*\bnode',    'javascript'),
       (r'^#!.*\bbash',    'bash'),
       (r'^#!.*\bsh\b',    'shell'),
       (r'^<\?xml',        'xml'),
       (r'^<\!DOCTYPE',    'html'),
   ]
   ```

3. **手动切换** — 状态栏语言标签可点击，弹出语言选择列表，手动设置当前文件高亮语言：
   ```javascript
   statusLang.onclick = () => showLanguagePicker(lang => {
     hljs.highlightElement(editor, { language: lang });
     statusLang.textContent = lang;
   });
   ```

---

## 八、设置系统

### IDE 标准做法

**VS Code** 的设置系统：

| 层级 | 文件位置 | 优先级 |
|------|---------|--------|
| 默认 | 内置 JSON Schema | 最低 |
| 用户 | `~/.config/Code/User/settings.json` | ↑ |
| 工作区 | `.code-workspace` 内嵌 | ↑ |
| 文件夹 | `.vscode/settings.json` | 最高 |

每个设置项有 JSON Schema 定义（类型、默认值、枚举、描述），设置 UI 从 Schema 动态生成表单。

**Theia** 使用 `.theia/settings.json`，格式与 VS Code 兼容但目录名不同，避免冲突。

**Atheos** 设置存储在数据库（SQLite/JSON 文件），通过 PHP 后端管理，分为用户级和项目级。

### Loom 的 `.loom/` 配置方案

**已有**（`config.py`）：
- 全局配置 `%APPDATA%/Loom/config.json` — lastRoot、recent、currentWorkspace

**应新增**：

```
项目根/
└── .loom/
    ├── settings.json    # 项目级设置
    └── tasks.json       # 工作流任务（从 state/ 移出）
```

`settings.json` Schema：
```json
{
  "editor.tabSize": 4,
  "editor.insertSpaces": true,
  "editor.autoSave": "afterDelay",
  "editor.autoSaveDelay": 1500,
  "files.exclude": ["node_modules", ".git", "__pycache__"],
  "git.autoRepositoryDetection": true,
  "theme": "dark"
}
```

**合并逻辑**（`config.py` 新增）：
```python
def merged_settings(project_root: Path) -> dict:
    """全局设置 + 项目 .loom/settings.json 合并，项目级优先。"""
    result = dict(DEFAULT_SETTINGS)
    result.update(_global_settings())
    loom_dir = project_root / ".loom" / "settings.json"
    if loom_dir.is_file():
        try: result.update(json.loads(loom_dir.read_text("utf-8")))
        except: pass
    return result
```

---

## 九、Explorer 增强

### IDE 标准做法

**VS Code Explorer 关键特性：**

| 特性 | VS Code 实现 | 复杂度 |
|------|-------------|--------|
| 拖拽移动/复制 | 拖拽文件/文件夹到目标目录，按住 Ctrl 为复制 | 中 |
| 多选操作 | Ctrl+Click 多选、Shift+Click 范围选、右键菜单支持批量操作 | 中 |
| 文件图标主题 | Seti（内置默认）、Material Icon Theme（扩展），通过 `iconDefinitions` JSON 映射扩展名→图标 | 高 |
| 文件嵌套 | `explorer.fileNesting.enabled` + 模式规则（如 `.ts` 下嵌套 `.js`/`.d.ts`/`.map`） | 中 |
| 紧凑文件夹 | `explorer.compactFolders` — 单子目录链合并显示 `src/main/java` 为一行 | 低 |
| 筛选/聚焦 | 输入字符实时筛选文件树 | 中 |

**Lite XL** 的文件树通过 Lua 插件实现 `treeview`，支持基本的文件操作但无拖拽。

**Atheos** 的文件树是 PHP+JS 实现，支持右键菜单（新建/重命名/删除），通过 AJAX 异步操作。

### Loom 当前实现

- 文件树有虚拟滚动、右键菜单（新建/重命名/删除）
- 标签栏有拖拽重排（`app.js:1550-1598`）
- 文件树**无拖拽移动**
- **无多选操作**
- 文件图标仅 5 类（folder/markdown/image/binary/code/text）
- 无文件嵌套、无紧凑文件夹

### 可实现的增强列表

**低成本高价值（P1）：**

1. **紧凑文件夹** — 当目录仅含一个子目录时，合并显示为 `parent/child`。改 `renderNode()` 递归检查即可
2. **文件图标细化** — 将 5 类扩展到 15-20 类（增加：JSON、YAML、Docker、Git、Config、HTML、CSS、Image 细分等），每类一个 SVG 图标
3. **键盘筛选** — 文件树获得焦点时，输入字符高亮匹配的文件名

**中等成本（P2）：**

4. **文件树拖拽移动** — 给 `.node` 添加 `draggable`，drop 时调用 `/api/fs/rename`（即移动）
5. **多选操作** — Ctrl+Click 添加到选区，Shift+Click 范围选，右键菜单「删除选中的 N 个文件」

**高成本（P3）：**

6. **文件嵌套** — 按规则将 `.js.map`、`.d.ts` 等嵌套到 `.ts` 下（需要配置系统支持）

---

## 十、优先级排序

按 **用户价值 × 实现可行性** 排序的 Top 10 改进列表：

| 排名 | 改进项 | 价值 | 可行性 | 估算工作量 | 说明 |
|------|--------|------|--------|-----------|------|
| 1 | **`.loom/settings.json` 项目级设置** | ★★★★★ | ★★★★★ | 0.5 天 | 路线图 P1 已规划，纯 JSON 读写，前端设置面板已有雏形 |
| 2 | **面包屑可交互化** | ★★★★ | ★★★★★ | 0.5 天 | 已有 `#crumb` 元素，改为可点击路径段即可 |
| 3 | **状态栏增强（缩进/EOL/选区）** | ★★★★ | ★★★★★ | 0.5 天 | 已有 `updateStatusBar()` 框架，加 3 个检测函数 |
| 4 | **语言检测增强** | ★★★★ | ★★★★★ | 0.5 天 | 扩展 `EXT_LANG` + 增加无扩展名文件识别 + 首行检测 |
| 5 | **文件图标细化** | ★★★★ | ★★★★ | 1 天 | 需要设计/收集 15-20 个 SVG 图标，注册新图标映射 |
| 6 | **Auto-Save 模式扩展** | ★★★ | ★★★★★ | 0.3 天 | 已有 afterDelay，加 onFocusChange 和可配延迟 |
| 7 | **文件监视（轮询方案）** | ★★★★★ | ★★★ | 1.5 天 | 后端轮询线程 + 前端轮询端点 + 重载提示 UI |
| 8 | **紧凑文件夹显示** | ★★★ | ★★★★ | 0.5 天 | 改 `renderNode()` 递归检查单子目录 |
| 9 | **文件树拖拽移动** | ★★★ | ★★★ | 1 天 | HTML5 Drag API + 后端 rename 已有 |
| 10 | **Git 仓库缓存 + 多仓库 UI** | ★★★★ | ★★ | 2 天 | 需要重构 Git API 和前端状态管理 |

### 速赢清单（1-2 天可完成）

前 4 项（设置系统、面包屑、状态栏、语言检测）总计约 2 天工作量，覆盖了用户日常编辑体验的核心短板。建议作为下一个 sprint 的目标。

### 中期目标（1-2 周）

文件图标、文件监视、Git 增强、文件树拖拽。这些改进将 Loom 从「能用的编辑器」提升到「舒适的开发环境」。

### 长期方向

多仓库管理、文件嵌套、符号级面包屑、语言服务集成。这些需要更深层的架构支持（如 LSP 客户端、Tree-sitter 集成），适合在 Tauri 重写后规划。

---

## 附录：参考 IDE 架构对比

| 维度 | VS Code | Theia | Lite XL | Atheos | **Loom** |
|------|---------|-------|---------|--------|----------|
| 前端 | Electron + Monaco | Electron/Browser + Monaco | SDL2 + Lua | 原生 JS + Ace | 原生 JS + textarea/Vditor |
| 后端 | Node.js | Node.js | C (嵌入 Lua) | PHP | Python stdlib |
| 构建 | 需要编译 | 需要编译 | 需要编译 | 零构建 | **零构建** |
| 扩展 | Extension API | Extension API | Lua 插件 | PHP 插件 | Playbook + Skills |
| Git | SCM Provider API | SCM Provider API | 插件 | 内置 component | 内置 Mixin |
| 文件监视 | parcel-watcher (原生) | nsfw/chokidar | dirmonitor (C 原生) | 无 | **无** |
| 设置层级 | 4 层 | 3 层 | 2 层 (DATADIR/USERDIR) | 2 层 | **1 层**（全局） |
| 代码量 | ~100 万行 | ~50 万行 | ~2 万行 | ~5 万行 | **~1.7 万行** |

Loom 的独特优势在于零依赖 + Python stdlib + 零构建，这决定了改进方案必须在这个约束内工作。上述所有改进方案都遵守了这个原则——不引入任何外部包依赖。
