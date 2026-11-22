
from __future__ import annotations

from pathlib import Path


class JailError(Exception):
    def __init__(self, message: str, code: int = 403):
        super().__init__(message)
        self.code = code


def resolve_worktree(cwd: str, workers_root: Path, expected_worker_id: str | None = None) -> Path:
    workers_root = workers_root.resolve()
    target = Path(cwd).resolve()
    try:
        target.relative_to(workers_root)
    except ValueError as exc:
        raise JailError(f"cwd {target} is outside {workers_root}") from exc
    rel = target.relative_to(workers_root)
    parts = rel.parts
    if not parts:
        raise JailError("cwd must be a worker worktree, not the workers root")
    worker_id = parts[0]
    if expected_worker_id and worker_id != expected_worker_id:
        raise JailError(f"cwd worker {worker_id} does not match {expected_worker_id}")
    # Disallow symlink escape of the worktree root itself
    worktree = (workers_root / worker_id).resolve()
    try:
        target.relative_to(worktree)
    except ValueError as exc:
        raise JailError(f"cwd escapes worker worktree {worktree}") from exc
    return target


def safe_relpath(worktree: Path, file_path: str) -> Path:
    if not file_path or file_path.startswith("/") or "\\" in file_path or ".." in Path(file_path).parts:
        raise JailError("Path must stay inside the worktree")
    target = (worktree / file_path).resolve()
    try:
        target.relative_to(worktree.resolve())
    except ValueError as exc:
        raise JailError("Path escapes the worktree") from exc
    return target
