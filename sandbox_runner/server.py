
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# Allow `python -m sandbox_runner.server` from repo root
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import settings  # noqa: E402
from sandbox_runner.jail import JailError, resolve_worktree  # noqa: E402

app = FastAPI(title="Orca Pod Sandbox Runner")

SCRUB_KEYS = (
    "CUSTOM_LLM_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_USER_API_KEY",
    "OPENROUTER_KANBAN_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "GITHUB_TOKEN",
    "TAILSCALE_AUTH_KEY",
    "BETTER_AUTH_SECRET",
    "GROK_AUTH_CLIENT_SECRET",
)


class ExecIn(BaseModel):
    command: str
    cwd: str
    worker_id: str | None = None
    timeout: int | None = None
    allow_network: bool = False


class ExecOut(BaseModel):
    code: int
    output: str
    backend: str


def docker_available() -> bool:
    return shutil.which("docker") is not None and Path("/var/run/docker.sock").exists()


def scrubbed_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in SCRUB_KEYS and "SECRET" not in k and "TOKEN" not in k and "API_KEY" not in k}
    env.setdefault("HOME", "/tmp")
    env.setdefault("LANG", "C.UTF-8")
    py_dir = str(Path(sys.executable).resolve().parent)
    env["PATH"] = f"{py_dir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    return env


def exec_docker(cwd: Path, command: str, timeout: int, allow_network: bool) -> tuple[int, str, str]:
    uid = os.getuid()
    gid = os.getgid()
    network = "bridge" if allow_network else "none"
    args = [
        "docker", "run", "--rm",
        "--network", network,
        "--memory", "512m",
        "--pids-limit", "256",
        "--user", f"{uid}:{gid}",
        "-e", "HOME=/tmp",
        "-e", "LANG=C.UTF-8",
        "-v", f"{cwd}:/work:rw",
        "-w", "/work",
        settings.docker_image,
        "bash", "-lc", command,
    ]
    proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    output = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
    return proc.returncode, output[-20000:], "docker"


def exec_host(cwd: Path, command: str, timeout: int) -> tuple[int, str, str]:
    # Prefer the interpreter that is running the control plane (venv) so
    # pytest and project deps resolve on the host-jail fallback.
    if command.startswith("python3 ") or command.startswith("python "):
        command = f"{sys.executable} " + command.split(" ", 1)[1]
    proc = subprocess.run(
        ["bash", "-lc", command],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
        env=scrubbed_env(),
        start_new_session=True,
    )
    output = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
    return proc.returncode, output[-20000:], "host-jail"


@app.post("/exec", response_model=ExecOut)
def exec_command(body: ExecIn) -> ExecOut:
    try:
        cwd = resolve_worktree(body.cwd, settings.workers_root, body.worker_id)
    except JailError as exc:
        raise HTTPException(status_code=exc.code, detail=str(exc)) from exc
    timeout = body.timeout or settings.sandbox_timeout_sec
    use_docker = settings.docker_sandbox and docker_available()
    try:
        if use_docker:
            code, output, backend = exec_docker(cwd, body.command, timeout, body.allow_network)
        else:
            code, output, backend = exec_host(cwd, body.command, timeout)
    except subprocess.TimeoutExpired:
        return ExecOut(code=124, output=f"timed out after {timeout}s", backend="timeout")
    except FileNotFoundError as exc:
        if use_docker:
            code, output, backend = exec_host(cwd, body.command, timeout)
            output = f"(docker unavailable: {exc}; fell back to host-jail)\n{output}"
        else:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
    return ExecOut(code=code, output=output, backend=backend)


@app.get("/health")
def health() -> dict:
    docker = docker_available() and settings.docker_sandbox
    return {"ok": True, "docker": docker, "backend": "docker" if docker else "host-jail"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=settings.sandbox_port)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
