# Loom 产品分析与演进路线

> 2026-07-01 · 基于 50+ 竞品调研与 6 个高相关性项目深度研究

---

## 一、项目现状

### 1.1 定位

Loom 是一个**轻量本地工作台**，目标是在 VS Code 风格的编辑器布局之上，叠加 Codex Desktop / Cursor / Devin 式的工作流生态——项目记忆、任务管理、Agent 会话、Skills/Playbooks。

核心差异化：**零运行时依赖**（纯 Python 标准库后端 + 原生 JS 前端），完全离线可用，单 EXE 交付。

### 1.2 技术指标

| 指标 | 数值 |
|------|------|
| 后端代码 | 3,361 行 Python（wb/ 包 15 个模块） |
| 前端代码 | 15,130 行 JS + 2,829 行 CSS + 584 行 HTML |
| 自研总量 | ~22,000 行 |
| API 路由 | 59 个（30 GET + 29 POST） |
| 注册能力 | 79+ |
| ActionState API | 16 个 |
| 文件查看器 | 7 种格式（PDF/EPUB/DOCX/Sheet/Font/Image/Archive） |
| 工具箱 | 12 个离线工具 |
| Smoke 测试 | 59 个 Playwright 脚本 |
| 桌面 EXE | ~78MB（PyInstaller + pywebview） |

### 1.3 架构

```
用户
  ↓
浏览器 / pywebview 原生窗口
  ↓ HTTP (127.0.0.1)
wb/ Python 包
  ├── handler.py ──── Mixin 组装 + 路由 + 安全（CSRF/CSP/DNS rebinding）
  ├── api_files.py ── 文件树/读写/搜索/便签
  ├── api_git.py ──── 25 项 Git 操作
  ├── api_terminal.py 终端/执行/上传
  ├── api_project.py ─ 项目记忆/任务/会话/生态/工作区
  ├── shell.py ────── ConPTY/winpty/pipe 终端会话
  └── 辅助模块 ────── config/paths/run/classify/constants/state
```

### 1.4 当前优势

1. **真正的零依赖**：后端纯 stdlib，前端无构建步骤，`python server.py` 一条命令启动
2. **安全纵深**：7 层防线（loopback 绑定 + CSRF 四重校验 + CSP + 路径穿越阻断 + DNS rebinding + 终端上限 + 搜索超时）
3. **能力注册表**：79+ 能力统一管理，每个有 risk/enabled/requires/actionState，命令面板三维过滤
4. **生态骨架完整**：项目记忆 4 维面板 + 任务工作流 + Agent 会话 + Skills/Playbooks + 恢复中心
5. **模块化架构**：Mixin 模式拆分后每个领域可独立维护

### 1.5 当前短板

1. **Playbook 只读**：定义了流程但不能执行，是"半成品"
2. **任务无依赖**：工作流是线性的，不支持任务图
3. **记忆无结构**：4 个 Markdown 文件，无时序、无标签、无分层
4. **无 hooks 机制**：能力注册表是封闭的，外部无法介入
5. **打包体积大**：78MB EXE（pywebview + Python 运行时），竞品 Pake 仅 5MB

---

## 二、竞品全景

### 2.1 直接竞品（功能重叠度最高）

| 项目 | Stars | 重叠点 | Loom 的差异 |
|------|-------|--------|------------|
| **ecode** | 2k | 终端+Git+项目一体化编辑器 | ecode 是 C++ 原生，Loom 是 Web 技术栈；ecode 有 LSP/DAP，Loom 有生态系统 |
| **Atheos** | 670 | 轻后端+原生 JS Web IDE | Atheos 是 PHP，Loom 是 Python；Loom 有更完整的 Git/终端/生态 |
| **JupyterLab** | 14k | Python 后端 + 浏览器工作台 | JupyterLab 面向数据科学，Loom 面向软件开发；JupyterLab 有重型扩展系统 |

### 2.2 生态参照（Loom 独特功能的灵感源）

| Loom 功能 | 最佳参照 | Stars | 核心借鉴 |
|-----------|----------|-------|----------|
| 项目记忆 | **Mem0** | 60k | 分层记忆（user/session/agent）+ 时序降权 + 实体标签 |
| 任务工作流 | **claude-task-master** | 21k | 依赖图 + expand 展开 + next 推荐 + 复杂度标注 |
| Playbooks | **Runme** | 2k | 命名 code block + 可执行步骤 + dry-run + 执行日志 |
| 能力注册表 | **Taskwarrior** | 5k | hooks 生命周期（on-add/on-modify）+ JSON stdio 协议 |
| 整体 UX | **AFFiNE** | 70k | 多视图同源 + 块组合 + 模板共享 + 本地优先 |

### 2.3 打包方案对比

| 方案 | 代表项目 | 产物大小 | 渲染引擎 | 与 Loom 关系 |
|------|----------|----------|----------|-------------|
| pywebview | Loom（当前） | ~78MB | 系统 WebView2 | 当前方案 |
| Tauri | Pake | ~5MB | 系统 WebView | 长期升级路径 |
| Wails | — | ~10MB | 系统 WebView | Go 版 pywebview |
| Electron | AFFiNE/思源 | ~150MB | Chromium | 太重，不考虑 |

---

## 三、功能增强详细方案

### 3.1 P0：Playbook 可执行化

**问题**：当前 Playbook（`.workbench/playbooks/*.md`）只能查看和复制命令，不能直接执行。用户必须手动复制命令到终端。

**参照**：Runme — 在 Markdown fenced code block 上加 `{ name=step-name }` 属性实现可执行。

**实现方案**：

1. **Playbook 格式扩展**

```markdown
# release-installer

## 步骤

```bash { name="build-exe", cwd="." }
powershell -ExecutionPolicy Bypass -File build_exe.ps1
```

```bash { name="build-installer", depends="build-exe" }
ISCC.exe installer/Loom.iss
```

```bash { name="verify", depends="build-installer" }
ls -la installer/Output/Loom-Setup-*.exe
```
```

2. **后端 API**
   - `POST /api/playbook/run` — 执行指定步骤 `{ playbook, step, dryRun? }`
   - 返回 `{ code, stdout, stderr, duration }`
   - 执行在工作区 ROOT 内，受现有安全约束（loopback + CSRF）

3. **前端 UI**
   - 生态面板中 Playbook 步骤旁加 ▶ 运行按钮
   - dry-run 按钮（只预览命令不执行）
   - 执行结果内联显示（退出码 + 输出）

4. **执行日志**
   - 每次执行写入 `state/PLAYBOOK-LOG.md`
   - 格式：`## YYYY-MM-DD HH:MM:SS — playbook/step — exit N — Ns`

**工作量**：后端 ~100 行，前端 ~150 行，约 1 天。

---

### 3.2 P0：任务依赖与图结构

**问题**：任务工作流是线性列表，无法表达"A 完成后才能开始 B"。

**参照**：claude-task-master — `depends_on` 字段 + 状态守卫。

**实现方案**：

1. **数据模型扩展**

```json
{
  "id": "task-003",
  "title": "构建安装包",
  "status": "todo",
  "depends_on": ["task-001", "task-002"],
  "complexity": "low",
  "subtasks": []
}
```

2. **状态守卫规则**
   - `todo` → `in-progress`：所有 `depends_on` 任务必须为 `done`
   - 未满足时 UI 显示"等待前置任务：task-001"
   - 命令面板中不可用的任务显示原因

3. **`expand` 命令**
   - 选中一个任务 → 右键"展开为子任务"
   - 输入子任务列表（每行一个标题）
   - 自动创建子任务并设 `depends_on` 为父任务

4. **`next` 推荐**
   - 状态栏或任务面板顶部显示"推荐下一步：[task-name]"
   - 逻辑：依赖满足 + 优先级最高 + 状态为 todo 的第一个

**工作量**：后端 ~80 行，前端 ~200 行，约 1.5 天。

---

### 3.3 P0：Session 快照增强

**问题**：工作区恢复只保存标签/主题/侧栏，不保存面板状态、终端历史、滚动位置。

**参照**：ecode — 周期性 session 快照 + 自动恢复。

**实现方案**：

1. **快照内容扩展**

```json
{
  "tabs": [...],
  "activeTab": "server.py",
  "sidebarPanel": "explorer",
  "sidebarWidth": 280,
  "terminalOpen": true,
  "terminalHeight": 200,
  "scrollPositions": { "server.py": 1420, "app.js": 350 },
  "gitPanel": "changes",
  "searchQuery": "TODO"
}
```

2. **保存时机**
   - 标签切换、面板切换、滚动停止 500ms 后
   - 窗口关闭前（`beforeunload`）
   - 防抖合并，不频繁写磁盘

3. **恢复逻辑**
   - 启动时读快照 → 依次恢复面板 → 打开标签 → 滚动到位置
   - 文件不存在的标签静默跳过

**工作量**：前端 ~100 行，后端 ~30 行，约 0.5 天。

---

### 3.4 P1：Hooks 生命周期

**问题**：能力注册表是封闭的，外部脚本无法在事件发生时介入。

**参照**：Taskwarrior — `on-add`/`on-modify` hooks + JSON stdio。

**实现方案**：

1. **Hook 点定义**

| Hook | 触发时机 | stdin | stdout |
|------|----------|-------|--------|
| `on-file-save` | 文件保存后 | `{"path":"...", "size": N}` | 忽略 |
| `on-task-add` | 任务创建后 | task JSON | 修改后的 task |
| `on-task-done` | 任务完成后 | task JSON | 忽略 |
| `on-git-commit` | Git 提交后 | `{"hash":"...", "msg":"..."}` | 忽略 |
| `on-workspace-open` | 工作区打开后 | `{"roots":[...]}` | 忽略 |

2. **Hook 脚本位置**
   - `.workbench/hooks/on-file-save.py`（或 .sh/.js）
   - 按文件名匹配 hook 点
   - 超时 10s 自动终止

3. **执行方式**
   - 异步执行，不阻塞主操作
   - stdout/stderr 写入 `state/HOOK-LOG.md`

**工作量**：后端 ~150 行，约 1 天。

---

### 3.5 P1：记忆分层与结构化

**问题**：`state/MEMORY.md` 单文件，无分类、无时序、无过期机制。

**参照**：Mem0 — user/session/agent 三层 + 时序降权。

**实现方案**：

1. **文件拆分**

```
state/
├── REQUIREMENTS.md    # 不变
├── PROGRESS.md        # 不变
├── LOG.md             # 不变
├── memory/
│   ├── user.md        # Q 的偏好和习惯
│   ├── project.md     # 项目架构事实
│   └── decisions.md   # 架构决策记录（ADR 风格）
```

2. **条目格式**

```markdown
### [2026-07-01] 后端拆分为 Mixin 架构
- **决策**：Handler 拆为 4 个 Mixin（Files/Git/Terminal/Project）
- **原因**：server.py 3435 行超出单文件可维护极限
- **影响**：desktop.py import 需同步更新
- **状态**：active
```

3. **UI 面板增强**
   - 左侧选 user/project/decisions 子分类
   - 条目按时间倒序
   - 支持搜索和标签过滤

**工作量**：后端 ~60 行，前端 ~200 行，约 1.5 天。

---

### 3.6 P1：JSON 能力配置（per-project）

**问题**：能力注册在 JS 代码中硬编码，用户无法为不同项目定制。

**参照**：ecode — `linters.json` / `formatters.json` 让用户无需写代码注册能力。

**实现方案**：

1. **配置文件**

```json
// .workbench/capabilities.json
{
  "custom": [
    {
      "id": "project.deploy",
      "label": "部署到生产",
      "icon": "rocket",
      "risk": "exec",
      "command": "bash deploy.sh",
      "requires": ["workspace", "gitRepo"]
    }
  ],
  "disabled": ["editor.find"]
}
```

2. **加载逻辑**
   - 工作区打开时读 `.workbench/capabilities.json`
   - `custom` 条目合并到注册表
   - `disabled` 条目在命令面板中隐藏

3. **执行**
   - 自定义能力的 `command` 通过 `/api/exec` 执行
   - 受现有安全约束

**工作量**：后端 ~40 行，前端 ~100 行，约 0.5 天。

---

## 四、演进路线图

### Phase 1：可执行生态（2 周）

| 序号 | 功能 | 工作量 | 优先级 |
|------|------|--------|--------|
| 1.1 | Playbook 可执行化 | 1 天 | P0 |
| 1.2 | 任务依赖图 + 状态守卫 | 1.5 天 | P0 |
| 1.3 | Session 快照增强 | 0.5 天 | P0 |
| 1.4 | Playbook 执行日志 | 0.5 天 | P1 |
| 1.5 | 任务 expand + next | 1.5 天 | P1 |

**Phase 1 完成标志**：Playbook 步骤可一键执行 + 任务支持依赖关系 + 重启完整恢复。

### Phase 2：开放生态（2 周）

| 序号 | 功能 | 工作量 | 优先级 |
|------|------|--------|--------|
| 2.1 | Hooks 生命周期 | 1 天 | P1 |
| 2.2 | 记忆分层重构 | 1.5 天 | P1 |
| 2.3 | JSON 能力配置 | 0.5 天 | P1 |
| 2.4 | 能力输出多视图 | 2 天 | P2 |

**Phase 2 完成标志**：外部脚本可介入工作流 + 记忆有分类和时序 + 用户可自定义能力。

### Phase 3：智能化（4 周）

| 序号 | 功能 | 工作量 | 优先级 |
|------|------|--------|--------|
| 3.1 | `loom next` 智能推荐 | 1 天 | P2 |
| 3.2 | 记忆实体标签 + 降权 | 1 天 | P2 |
| 3.3 | Playbook dry-run | 0.5 天 | P2 |
| 3.4 | 任务 complexity → 模型选择 | 1 天 | P2 |
| 3.5 | LSP 集成（代码补全/跳转） | 5 天 | P2 |
| 3.6 | 多语言语法高亮（tree-sitter WASM） | 3 天 | P2 |

### Phase 4：轻量化（长期）

| 序号 | 功能 | 说明 |
|------|------|------|
| 4.1 | Tauri 重写替代 pywebview | 78MB → 5MB |
| 4.2 | CodeMirror 6 替代 textarea | 专业编辑体验 |
| 4.3 | CRDT 协作（可选） | 多人协作 |

---

## 五、竞争定位建议

### 5.1 不做什么

- **不做 VS Code 克隆**：不追 LSP/DAP/扩展市场的完整度
- **不做云 Agent**：不引入 API Key、不联网、不做 SaaS
- **不做重型框架**：不引入 React/Vue/Webpack/npm

### 5.2 做什么

- **做本地 Agent 工作台**：让 Agent 的输入/输出/记忆/恢复有可视化界面
- **做轻量 Runbook 平台**：Playbook 从只读到可执行，是开发者日常自动化的入口
- **做零依赖的极致**：`python server.py` 就能跑的本地开发工具，运维/教育/离线场景的唯一选择

### 5.3 定位一句话

> **Loom 是给 AI Agent 用的轻量工作台**：让 Agent 有记忆、有任务、有流程、有恢复能力——而不是一个更轻的 VS Code。

---

## 六、参考项目索引

详见项目 memory 中的三份研究文档：

1. **README 设计参考**（8 个项目）：Pake/Zed/Tabby/Lapce/Aide/AstroNvim/Topgrade/Neovide
2. **竞品全景**（50+ 项目）：按编辑器/Web IDE/零依赖/Agent/任务管理/知识管理/Playbook/中文工具分类
3. **深度研究**（6 个项目）：Mem0/claude-task-master/Runme/ecode/Taskwarrior/AFFiNE
