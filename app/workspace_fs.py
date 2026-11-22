
from __future__ import annotations

from pathlib import Path
from typing import Any

from sandbox_runner.jail import JailError, safe_relpath


def tree(root: Path) -> list[dict[str, Any]]:
    root = root.resolve()
    if not root.exists():
        return []
    nodes: list[dict[str, Any]] = []

    def walk(path: Path) -> dict[str, Any]:
        rel = "." if path == root else path.relative_to(root).as_posix()
        if path.is_dir():
            children = []
            for child in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
                if child.name in {".git", "node_modules", "__pycache__", ".venv"}:
                    continue
                children.append(walk(child))
            return {"name": path.name if path != root else path.name, "path": rel, "type": "dir", "children": children}
        return {"name": path.name, "path": rel, "type": "file", "size": path.stat().st_size}

    # return children of root plus the root
    return walk(root).get("children", [])


def read_file(root: Path, rel: str) -> str:
    target = safe_relpath(root, rel)
    if not target.exists() or not target.is_file():
        raise FileNotFoundError(rel)
    data = target.read_bytes()
    if b"\x00" in data:
        raise JailError("Non-UTF-8 / binary files are rejected")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise JailError("Non-UTF-8 content is rejected") from exc


def write_file(root: Path, rel: str, content: str) -> Path:
    if "\x00" in content:
        raise JailError("Non-UTF-8 content is rejected")
    target = safe_relpath(root, rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    return target


def flatten_files(root: Path, limit: int = 80_000) -> dict[str, str]:
    files: dict[str, str] = {}
    if not root.exists():
        return files
    for f in root.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(root).as_posix()
        if rel.startswith(".git") or "/.git/" in rel or rel.endswith(".pyc"):
            continue
        if f.stat().st_size > limit:
            continue
        try:
            files[rel] = f.read_text()[:limit]
        except (UnicodeDecodeError, OSError):
            continue
    return files
