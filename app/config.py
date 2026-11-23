from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", env_file_encoding="utf-8", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8877
    orca_daemon_port: int = 6768
    llm_proxy_port: int = 4000
    sandbox_port: int = 9090

    workspace_root: Path = ROOT / "workspace"
    tickets_dir: Path = ROOT / "tickets"
    attachments_dir: Path = ROOT / "ticket-attachments"
    catalogs_dir: Path = ROOT / "catalogs"

    sandbox_exec_url: str = "http://127.0.0.1:9090/exec"
    orca_daemon_url: str = "http://127.0.0.1:6768"

    custom_llm_api_key: str = ""
    custom_llm_endpoint: str = "https://openrouter.ai/api/v1"
    custom_llm_model: str = "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"

    orca_mock_mode: bool = False
    orca_bin: str = ""
    watchdog_interval_sec: int = 180
    max_gap_iterations: int = 5
    log_level: str = "INFO"

    docker_sandbox: bool = True
    docker_image: str = "orca-pod-sandbox:local"
    sandbox_timeout_sec: int = 60

    # When true, dispatch uses the in-process echo harness (deterministic tests).
    force_echo_harness: bool = False
    sync_dispatch: bool = False

    @property
    def db_path(self) -> Path:
        return self.workspace_root / ".kanban" / "state.db"

    @property
    def workers_root(self) -> Path:
        return self.workspace_root / "workers"

    def ensure_dirs(self) -> None:
        for path in (
            self.workspace_root,
            self.workspace_root / ".kanban",
            self.workers_root,
            self.tickets_dir,
            self.attachments_dir,
            self.catalogs_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)


settings = Settings()
