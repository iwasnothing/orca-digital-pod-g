
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from app.config import settings
from app.store import new_id


def resolve_orca_bin() -> str | None:
    if settings.orca_bin and Path(settings.orca_bin).exists():
        return settings.orca_bin
    for name in ("orca-ide", "orca"):
        found = shutil.which(name)
        if found:
            # Avoid GNOME screen reader at /usr/bin/orca
            if name == "orca" and Path(found).resolve() == Path("/usr/bin/orca"):
                continue
            return found
    # Bundled install location used by this VM deploy
    bundled = Path.home() / "orca-server" / "bin" / "orca-ide"
    if bundled.exists():
        return str(bundled)
    return None


def orca_available() -> bool:
    return resolve_orca_bin() is not None


def _run(args: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    bin_ = resolve_orca_bin()
    if not bin_:
        raise FileNotFoundError("orca-ide is not installed")
    env = os.environ.copy()
    env["PATH"] = f"{Path(bin_).parent}:{env.get('PATH', '')}"
    return subprocess.run([bin_, *args], capture_output=True, text=True, timeout=timeout, env=env)


def status() -> dict[str, Any]:
    if settings.orca_mock_mode:
        return {"ok": True, "mock": True, "runtime": {"state": "mock", "reachable": False}}
    if not orca_available():
        return {"ok": False, "error": "orca-ide not found"}
    try:
        proc = _run(["status", "--json"], timeout=15)
        if proc.stdout.strip():
            return json.loads(proc.stdout)
        return {"ok": False, "error": proc.stderr.strip() or f"exit {proc.returncode}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def runtime_reachable() -> bool:
    st = status()
    result = st.get("result") or st
    runtime = result.get("runtime") or {}
    return bool(runtime.get("reachable") or runtime.get("state") == "running")


def maybe_add_repo(path: Path) -> dict[str, Any]:
    """Best-effort: register the pod repo with a running Orca runtime."""
    if settings.orca_mock_mode or not runtime_reachable():
        return {"ok": True, "skipped": True, "reason": "orca runtime not reachable; local worktree only"}
    try:
        proc = _run(["repo", "add", "--path", str(path.resolve()), "--json"], timeout=30)
        text = proc.stdout.strip() or proc.stderr.strip()
        try:
            return json.loads(text) if text.startswith("{") else {"ok": proc.returncode == 0, "raw": text}
        except json.JSONDecodeError:
            return {"ok": proc.returncode == 0, "raw": text}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def create_worktree(repo_path: Path, name: str, prompt: str | None = None, agent: str | None = None) -> dict[str, Any]:
    """Create an Orca-managed worktree when the runtime is up; otherwise a local folder."""
    dest = settings.workers_root / name
    dest.mkdir(parents=True, exist_ok=True)
    if settings.orca_mock_mode or not runtime_reachable():
        return {
            "ok": True,
            "mode": "local-folder",
            "path": str(dest),
            "orca_worktree_id": None,
            "note": "Orca runtime not reachable; created a local worker folder. ORCA_MOCK_MODE or start `orca-ide serve`.",
        }
    args = ["worktree", "create", "--name", name, "--json"]
    # Prefer creating under the given path when supported; still create dest.
    if agent:
        args.extend(["--agent", agent])
    if prompt:
        args.extend(["--prompt", prompt])
    try:
        proc = _run(args, timeout=60)
        text = proc.stdout.strip() or proc.stderr.strip()
        data: dict[str, Any]
        try:
            data = json.loads(text) if text.startswith("{") else {"raw": text, "ok": proc.returncode == 0}
        except json.JSONDecodeError:
            data = {"raw": text, "ok": proc.returncode == 0}
        data.setdefault("path", str(dest))
        data["mode"] = "orca"
        return data
    except Exception as exc:
        return {"ok": True, "mode": "local-folder", "path": str(dest), "error": str(exc)}


def worktree_ps() -> dict[str, Any]:
    if settings.orca_mock_mode or not runtime_reachable():
        return {"ok": True, "mock": True, "result": []}
    try:
        proc = _run(["worktree", "ps", "--json"], timeout=20)
        text = proc.stdout.strip() or "{}"
        return json.loads(text) if text.startswith("{") or text.startswith("[") else {"raw": text}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def worker_read(dispatch_id: str) -> str:
    if settings.orca_mock_mode or not runtime_reachable() or not dispatch_id:
        return ""
    try:
        proc = _run(["orchestration", "worker-read", dispatch_id, "--json"], timeout=20)
        return proc.stdout
    except Exception:
        return ""


def terminal_send(selector: str, text: str) -> dict[str, Any]:
    if settings.orca_mock_mode or not runtime_reachable():
        return {"ok": True, "mock": True, "sent": text}
    try:
        proc = _run(["terminal", "send", selector, text, "--json"], timeout=20)
        return {"ok": proc.returncode == 0, "raw": proc.stdout or proc.stderr}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def health_details() -> tuple[str, str]:
    bin_ = resolve_orca_bin()
    if not bin_:
        return "degraded", "orca-ide not installed"
    st = status()
    result = st.get("result") or st
    runtime = result.get("runtime") or {}
    if runtime.get("reachable") or runtime.get("state") == "running":
        return "healthy", f"orca-ide {Path(bin_).name} runtime reachable"
    if st.get("mock"):
        return "degraded", "ORCA_MOCK_MODE=true (in-process mock)"
    return "degraded", f"orca-ide installed, runtime not running ({runtime.get('state') or st.get('error') or 'not_running'})"
