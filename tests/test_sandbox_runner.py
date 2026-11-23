
from pathlib import Path

import pytest

from sandbox_runner.jail import JailError, resolve_worktree, safe_relpath


def test_jail_accepts_worker_dir(tmp_path):
    root = tmp_path / "workers"
    wt = root / "abc"
    wt.mkdir(parents=True)
    (wt / "file.txt").write_text("hi")
    assert resolve_worktree(str(wt), root, "abc") == wt.resolve()
    assert safe_relpath(wt, "file.txt").read_text() == "hi"


def test_jail_blocks_escape(tmp_path):
    root = tmp_path / "workers"
    wt = root / "abc"
    wt.mkdir(parents=True)
    outside = tmp_path / "secret"
    outside.mkdir()
    with pytest.raises(JailError):
        resolve_worktree(str(outside), root, "abc")
    with pytest.raises(JailError):
        safe_relpath(wt, "../secret")
