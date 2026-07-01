"""文件分类与 Makefile 解析。"""
import re
from pathlib import Path

from wb.constants import TEXT_EXTS, IMAGE_EXTS


def classify(p: Path) -> str:
    ext = p.suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in TEXT_EXTS or p.name.lower() in {"dockerfile", "makefile", "readme"}:
        return "text"
    return "binary"


def parse_makefile_targets(text: str):
    """从 Makefile 文本里提取目标名。"""
    targets = []
    seen = set()
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9][\w.\-/]*)\s*:(?!=)", line)
        if not m:
            continue
        name = m.group(1)
        if name.startswith(".") or "%" in name or name in seen:
            continue
        seen.add(name)
        targets.append(name)
    return targets
