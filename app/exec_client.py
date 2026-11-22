
from __future__ import annotations

import httpx

from app.config import settings


def _inline(command: str, cwd: str, worker_id: str | None, allow_network: bool, timeout: int | None) -> dict:
    from sandbox_runner.jail import JailError, resolve_worktree
    from sandbox_runner.server import docker_available, exec_docker, exec_host

    try:
        path = resolve_worktree(cwd, settings.workers_root, worker_id)
    except JailError as exc:
        return {"code": 403, "output": str(exc), "backend": "jail"}
    t = timeout or settings.sandbox_timeout_sec
    try:
        if settings.docker_sandbox and docker_available():
            code, output, backend = exec_docker(path, command, t, allow_network)
        else:
            code, output, backend = exec_host(path, command, t)
    except Exception as exc:
        return {"code": 1, "output": str(exc), "backend": "error"}
    return {"code": code, "output": output, "backend": backend + "-inline"}


def sandbox_exec(command: str, cwd: str, worker_id: str | None = None, allow_network: bool = False, timeout: int | None = None) -> dict:
    # Tests and host-jail-only mode skip the HTTP runner so they cannot hit
    # a live server whose WORKSPACE_ROOT is a different directory.
    if not settings.docker_sandbox:
        return _inline(command, cwd, worker_id, allow_network, timeout)
    url = settings.sandbox_exec_url
    payload = {
        "command": command,
        "cwd": cwd,
        "worker_id": worker_id,
        "allow_network": allow_network,
        "timeout": timeout or settings.sandbox_timeout_sec,
    }
    try:
        with httpx.Client(timeout=(timeout or settings.sandbox_timeout_sec) + 10) as client:
            resp = client.post(url, json=payload)
            if resp.status_code == 403:
                return {"code": 403, "output": resp.text, "backend": "jail"}
            resp.raise_for_status()
            return resp.json()
    except (httpx.HTTPError, OSError):
        return _inline(command, cwd, worker_id, allow_network, timeout)
