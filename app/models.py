from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    def model_dump(self, *args, **kwargs):
        kwargs.setdefault("by_alias", True)
        return super().model_dump(*args, **kwargs)

    def model_dump_json(self, *args, **kwargs):
        kwargs.setdefault("by_alias", True)
        return super().model_dump_json(*args, **kwargs)

Status = Literal["backlog", "to-do", "planning", "in-progress", "in-review", "done"]
Harness = Literal["pi", "opencode", "deepseek"]
Risk = Literal["low", "medium", "high"]
WorkerStatus = Literal["idle", "healthy", "busy", "pending-approval", "stalled", "offline"]
Priority = Literal["low", "medium", "high", "critical"]
GateStatus = Literal["pending", "approved", "denied"]


class Acceptance(CamelModel):
    text: str
    done: bool = False


class Attachment(CamelModel):
    name: str
    content: str = ""


class LogLine(CamelModel):
    time: str
    message: str


class Ticket(CamelModel):
    id: str
    title: str
    status: Status = "backlog"
    priority: Priority = "medium"
    assigned_worker_id: str | None = None
    dispatch_id: str | None = None
    gap_iteration: int = 0
    needs_human: bool = False
    created_at: str
    updated_at: str
    objective: str = ""
    requirements: list[str] = Field(default_factory=list)
    context: str = ""
    acceptance: list[Acceptance] = Field(default_factory=list)
    attachments: list[Attachment] = Field(default_factory=list)
    viz: dict[str, Any] | None = None
    viz_status: Literal["none", "draft", "published"] = "none"
    execution_log: list[LogLine] = Field(default_factory=list)
    final_review: str = ""
    files: dict[str, str] = Field(default_factory=dict)


class Worker(CamelModel):
    id: str
    name: str
    harness: Harness
    model: str
    worktree_path: str
    status: WorkerStatus = "idle"
    current_ticket_id: str | None = None
    last_heartbeat: str
    auto_approve_tier: Risk = "low"
    orca_worktree_id: str | None = None
    harness_note: str = ""


class GateRequest(CamelModel):
    id: str
    worker_id: str
    ticket_id: str
    command: str
    risk_level: Risk
    status: GateStatus = "pending"
    reason: str = ""
    created_at: str
    output: str | None = None
    exit_code: int | None = None


class GapReport(CamelModel):
    id: str
    ticket_id: str
    iteration: int
    summary: str
    unmet_criteria: list[str] = Field(default_factory=list)
    created_at: str


class Heartbeat(CamelModel):
    component: str
    status: Literal["healthy", "degraded"]
    details: str = ""
    updated_at: str


class PodEvent(CamelModel):
    id: str
    time: str
    kind: str
    message: str


class Stall(CamelModel):
    output: str = ""
    hash: str = ""
    repeats: int = 0


class BoardState(CamelModel):
    workers: list[Worker]
    tickets: list[Ticket]
    gates: list[GateRequest]
    gaps: list[GapReport]
    events: list[PodEvent]
    heartbeats: list[Heartbeat]
    stall: dict[str, Stall] = Field(default_factory=dict)
    supervision: bool = True


class WorkerCreate(CamelModel):
    name: str
    harness: Harness
    model: str = ""
    auto_approve_tier: Risk = "low"


class ObjectiveIn(CamelModel):
    objective: str
    preferred_harness: Harness | None = None
    harness: Harness | None = None
    attachments: list[Attachment] = Field(default_factory=list)
    attachment: Attachment | None = None

    def normalized_harness(self) -> Harness | None:
        return self.preferred_harness or self.harness

    def normalized_attachments(self) -> list[Attachment]:
        items = list(self.attachments)
        if self.attachment:
            items.append(self.attachment)
        return items


class TicketPatch(CamelModel):
    status: Status | None = None
    assigned_worker_id: str | None = None
    gap_notes: str | None = None
    acceptance_index: int | None = None


class PermissionIn(CamelModel):
    worker_id: str
    ticket_id: str
    worktree_path: str = ""
    command: str


class FilePut(CamelModel):
    file_path: str
    content: str


class ActionIn(CamelModel):
    action: Literal["nudge", "resume", "restart"]


class ResolveIn(CamelModel):
    decision: Literal["approve", "deny"]


class ActionResult(CamelModel):
    ok: bool
    message: str
    ticket_id: str | None = None
    worker_id: str | None = None
    gap: bool = False
    conflict: bool = False
    pending: bool = False
    gate_id: str | None = None
    output: str | None = None
    exit_code: int | None = None
