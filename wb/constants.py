"""Loom 常量定义。"""
import subprocess
import sys

TEXT_EXTS = {
    ".md", ".markdown", ".txt", ".json", ".js", ".ts", ".jsx", ".tsx",
    ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".css",
    ".scss", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini",
    ".cfg", ".conf", ".sh", ".bash", ".ps1", ".bat", ".sql", ".csv",
    ".log", ".env", ".gitignore", ".dockerfile", ".vue", ".svelte",
    ".spec", ".properties", ".editorconfig", ".gitattributes", ".dockerignore",
    ".rb", ".php", ".lua", ".kt", ".kts", ".swift", ".dart", ".r", ".pl",
    ".tex", ".rst", ".diff", ".patch", ".tsv", ".proto", ".graphql", ".gql",
    ".tf", ".gradle", ".cmake", ".mk", ".lock", ".cs", ".scala", ".clj",
}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"}
MAX_TEXT_BYTES = 5 * 1024 * 1024
PROJECT_STATE_FILES = {
    "requirements": "REQUIREMENTS.md",
    "progress": "PROGRESS.md",
    "log": "LOG.md",
    "memory": "MEMORY.md",
}
ROADMAP_FILE = "轻量生态化路线.md"
EXEC_TIMEOUT = 120
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
