
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import settings


@pytest.fixture(autouse=True)
def isolated_data(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_root", tmp_path / "workspace")
    monkeypatch.setattr(settings, "tickets_dir", tmp_path / "tickets")
    monkeypatch.setattr(settings, "attachments_dir", tmp_path / "ticket-attachments")
    monkeypatch.setattr(settings, "docker_sandbox", False)
    monkeypatch.setattr(settings, "orca_mock_mode", True)
    monkeypatch.setattr(settings, "force_echo_harness", True)
    monkeypatch.setattr(settings, "sync_dispatch", True)
    monkeypatch.setattr(settings, "watchdog_interval_sec", 5)
    settings.ensure_dirs()
    from app.store import init_db
    init_db()
    yield tmp_path
