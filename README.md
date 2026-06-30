# Loom

A lightweight, local-first desktop workbench. VS Code-style layout with an integrated ecosystem inspired by Codex Desktop, Cursor, and Devin — project memory, task workflows, agent sessions, and skills/playbooks. **Pure Python stdlib backend + vanilla JS frontend, zero runtime dependencies, fully offline.**

一个零依赖的本地工作台。VS Code 风格三栏布局 + Codex/Cursor/Devin 式生态骨架（项目记忆、任务工作流、Agent 会话、Skills/Playbooks）。纯 Python 标准库后端 + 原生 JS 前端，完全离线可用。

## Quick Start

```bash
python server.py                    # restore last workspace
python server.py D:\projects        # open specific directory
python server.py --port 8200        # custom port
```

On Windows, double-click `start.bat` or drag a folder onto it. Opens at `http://127.0.0.1:8765/`.

## Desktop App

```powershell
pip install pyinstaller pywebview    # build-time only
powershell -ExecutionPolicy Bypass -File build_exe.ps1
```

Produces `dist\Loom.exe` (~77MB standalone). For an installer:

```powershell
powershell -ExecutionPolicy Bypass -File build_installer.ps1
# -> installer\Output\Loom-Setup-0.1.0.exe
```

## Features

### Editor Core

- **Multi-tab editor** with dirty markers, unsaved-close confirmation, drag reorder
- **`Ctrl+P` Quick Open** — fuzzy subsequence match with highlight
- **`Ctrl+F` Find & Replace** — string/regex, case-sensitive, count, replace all
- **Full-text search** — cross-file recursive, regex, results grouped by file
- **Split pane editing** — horizontal/vertical, independent focus and state
- **Line numbers** — synced scroll, current line highlight

### Markdown

- **Vditor WYSIWYG** editor — single editing surface, compact toolbar, embedded outline
- **Mermaid** diagrams, **KaTeX** math, **TOC** navigation
- **Export** to HTML / print to PDF
- **Paste images** — auto-save to `assets/` and insert link
- **Task lists** — click to toggle `[ ]` ⇄ `[x]` in preview, synced back to source

### Source Control (Git)

- Stage/unstage, commit (`Ctrl+Enter`), push, init
- **Commit graph** — SVG multi-lane with branch/tag chips, inline file expansion, per-commit diff
- File history, blame (per-line author coloring), branch create/checkout/delete, stash save/pop
- Resizable sidebar with memory

### Integrated Terminal

- Collapsible bottom panel with ConPTY/winpty shell
- Run current file (`.py` / `.js` / `.sh` / `.ps1`)
- Task runner — auto-detect `package.json` scripts and `Makefile` targets
- Commands execute on `127.0.0.1` only, with CSRF protection

### File Viewers

| Format | Capabilities |
|--------|-------------|
| PDF | Embedded pdf.js viewer |
| EPUB | Paginated reader + TOC sidebar |
| DOCX | Rendered document preview |
| Excel/CSV | Sheet tabs, cell navigation |
| Font | Glyph preview, custom text testing |
| Image | Enhanced viewer (HEIC/PSD/TIFF support) |
| Archive | ZIP/JAR browser with text/image preview |

### Productivity

- **Command Palette** (`Ctrl+Shift+P`) — 79+ capabilities, filter by risk/kind/source
- **Settings** — font size, tab width, accent color, word wrap, auto-save
- **Workspace memory** — restore tabs, theme, sidebar width on reopen
- **Status bar** — line/col, word count, language, encoding, Git branch
- **Notes / Todo** — add, edit, check, drag-reorder, persisted
- **Toolbox** — JSON, Base64, URL, Hash, Diff, Regex, Color, UUID, Cron, Markdown table (12 tools)

### Ecosystem (Codex/Cursor/Devin-inspired)

| Surface | Description |
|---------|-------------|
| **Capability Registry** | 79+ registered actions with `requires`, `risk` labels, disabled reasons |
| **Project Memory** | `state/*.md` visualized in UI — Requirements, Progress, Log, Memory |
| **Task Workflows** | Goal → Plan → Evidence → Log → Status, multi-context creation |
| **Agent Sessions** | Session brief/recovery packages, result import to tasks + memory |
| **Skills / Playbooks** | `.workbench/` definitions, execution preview (view/copy only, no auto-exec) |
| **Recovery Center** | Resume last task, view recent validation, recommended next step |

## Architecture

```
loom/
├─ server.py           # Backend — stdlib http.server (3400 lines)
├─ desktop.py          # pywebview native window shell
├─ AGENTS.md           # Project rules: boundaries, safety, validation
├─ .workbench/         # Local ecosystem definitions
│  ├─ playbooks/       #   Workflow playbooks
│  └─ skills/          #   Skill definitions
├─ docs/               # Roadmap, audit reports
├─ state/              # Project memory (viewable/editable in UI)
├─ scripts/            # 59 Playwright smoke tests
└─ static/
   ├─ app.js           # Core UI: file tree, tabs, editor, Markdown, Quick Open (3500 lines)
   ├─ workbench.js     # Capability registry, command palette, settings (1500 lines)
   ├─ project.js       # Project memory panel
   ├─ tasks.js         # Task/Agent workflow panel
   ├─ ecosystem.js     # Skills/Playbooks panel
   ├─ git.js           # Source control
   ├─ terminal.js      # Integrated terminal + task runner
   ├─ viewers/         # 7 file viewers (PDF/EPUB/DOCX/Sheet/Font/Image/Archive)
   └─ vendor/          # Bundled frontend libs (Vditor, xterm, highlight.js, KaTeX, Mermaid)
```

**Backend**: Pure Python standard library. No pip dependencies at runtime. Optional: `pywebview` (desktop shell), `pyinstaller` (packaging).

**Frontend**: Vanilla JS with IIFE modules. No build step, no bundler, no framework. 15 vendor libraries bundled locally in `static/vendor/`.

## Security

- All file I/O confined to workspace root — `../` traversal blocked via `resolve()` + `realpath()` containment check
- Write/exec operations require **CSRF validation** (Content-Type + Origin + Host + Sec-Fetch-Site)
- **DNS rebinding protection** — strict loopback Host whitelist
- **CSP** — no `unsafe-inline` for scripts, `object-src 'none'`
- Default bind `127.0.0.1` — non-loopback requires explicit `WORKBENCH_ALLOW_REMOTE=1`
- Search timeout (10s), terminal input cap (1MB), atomic file writes
- SheetJS output sanitized against XSS
- 67 interactive buttons have `aria-label` for screen reader accessibility
- **2 audit reports** with full findings and remediation tracking

## Smoke Tests

59 Playwright-driven browser smoke scripts covering: no-workspace state, Git/non-Git/empty-repo scenarios, Markdown, all 7 viewers, tasks, sessions, ecosystem, command palette, status bar, split pane, keyboard navigation, and action contract consistency.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-browser-smoke.ps1 scripts\cmdpalette-smoke.js
```

## Design Principles

- **Local-first** — no cloud services, no accounts, no telemetry
- **Zero runtime deps** — stdlib Python backend, vendor-bundled frontend
- **Offline-capable** — everything works without internet
- **Safe by default** — Skills/Playbooks are view/copy only until a proper execution model exists
- **Action contract** — every button either works or is disabled with a reason
- **Single-user** — designed as a personal workstation, not a multi-tenant service

## License

Private project.
