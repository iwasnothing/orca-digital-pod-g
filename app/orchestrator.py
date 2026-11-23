
from __future__ import annotations

from pathlib import Path

from app.config import ROOT, settings
from app.harness_runner import dispatch
from app.models import ActionResult, Attachment, Harness, ObjectiveIn, Ticket, Worker, WorkerCreate
from app.orca_bridge import create_worktree, maybe_add_repo
from app.store import (
    add_event,
    append_log,
    get_worker,
    list_workers,
    load_ticket,
    new_id,
    now_iso,
    save_ticket,
    save_worker,
)
from app.workspace_fs import write_file


DEFAULT_MODELS = {
    "pi": "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    "opencode": "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    "deepseek": "openrouter/deepseek/deepseek-chat",
}


def register_worker(body: WorkerCreate) -> ActionResult:
    name = body.name.strip() or f"{body.harness}-worker"
    slug = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in name.lower()).strip("-") or body.harness
    worker_id = new_id(slug[:24] or body.harness)
    worktree = settings.workers_root / worker_id
    worktree.mkdir(parents=True, exist_ok=True)
    maybe_add_repo(ROOT)
    orca = create_worktree(ROOT, worker_id)
    note = orca.get("note") or orca.get("mode") or ""
    if orca.get("error"):
        note = f"{note} ({orca['error']})"
    worker = Worker(
        id=worker_id,
        name=name,
        harness=body.harness,
        model=body.model or DEFAULT_MODELS.get(body.harness, "default"),
        worktree_path=str(Path(orca.get("path") or worktree).resolve()),
        status="idle",
        current_ticket_id=None,
        last_heartbeat=now_iso(),
        auto_approve_tier=body.auto_approve_tier,
        orca_worktree_id=str(orca.get("orca_worktree_id") or orca.get("id") or "") or None,
        harness_note=str(note),
    )
    Path(worker.worktree_path).mkdir(parents=True, exist_ok=True)
    (Path(worker.worktree_path) / ".ticket-attachments").mkdir(exist_ok=True)
    save_worker(worker)
    add_event("dispatch", f"Registered worker {worker.name} ({worker.harness}) at {worker.worktree_path}")
    return ActionResult(ok=True, message=f"Registered {worker.name}", worker_id=worker.id)


def _is_stub_worker(worker: Worker) -> bool:
    model = (worker.model or "").lower()
    name = (worker.name or "").lower()
    return model.startswith("echo") or "stub" in model or "stub" in name


def _pick_worker(preferred: Harness | None) -> Worker | None:
    workers = list_workers()
    if not workers:
        return None
    if preferred:
        matching = [w for w in workers if w.harness == preferred]
        pool = matching or workers
    else:
        pool = workers
    idle = [w for w in pool if w.status in {"idle", "healthy"}]
    if not settings.force_echo_harness:
        live = [w for w in idle if not _is_stub_worker(w)]
        if live:
            live.sort(key=lambda w: w.last_heartbeat or "")
            return live[-1]
    return (idle or pool)[0]


def _title_from(objective: str) -> str:
    line = objective.strip().splitlines()[0].strip().lstrip("-# ").strip()
    return (line[:80] or "Untitled objective")


def intake(body: ObjectiveIn) -> ActionResult:
    objective = body.objective.strip()
    if len(objective) < 3:
        return ActionResult(ok=False, message="Objective is too short")
    worker = _pick_worker(body.normalized_harness())
    ticket_id = new_id("ORCA")
    reqs = [ln.lstrip("- ").strip() for ln in objective.splitlines()[1:] if ln.strip()]
    ticket = Ticket(
        id=ticket_id,
        title=_title_from(objective),
        status="backlog",
        priority="medium",
        assigned_worker_id=worker.id if worker else None,
        dispatch_id=None,
        gap_iteration=0,
        needs_human=False,
        created_at=now_iso(),
        updated_at=now_iso(),
        objective=objective,
        requirements=reqs or ["Complete the stated objective"],
        context="Created by the Orca Digital Pod orchestrator.",
        acceptance=[{"text": "Worktree contains the delivered artifacts", "done": False},
                    {"text": "Verification / tests pass in the sandbox", "done": False}],
        attachments=body.normalized_attachments(),
        final_review="",
    )
    save_ticket(ticket)
    if not worker:
        append_log(ticket, "No worker registered yet; ticket stays in backlog")
        add_event("dispatch", f"Ingested {ticket.id} into backlog (no worker)")
        return ActionResult(ok=True, message="Ticket created in backlog. Register a worker to dispatch it.", ticket_id=ticket.id)

    ticket.status = "to-do"
    ticket.dispatch_id = new_id("disp")
    save_ticket(ticket)
    # Copy attachments into the worker worktree and attachments dir
    dest = Path(worker.worktree_path) / ".ticket-attachments"
    dest.mkdir(parents=True, exist_ok=True)
    att_dir = settings.attachments_dir / ticket.id
    att_dir.mkdir(parents=True, exist_ok=True)
    for att in body.normalized_attachments():
        safe = Path(att.name).name
        if att.content:
            (att_dir / safe).write_text(att.content)
            write_file(Path(worker.worktree_path), f".ticket-attachments/{safe}", att.content)
    append_log(ticket, f"Assigned to {worker.name} and attachments synced")
    add_event("dispatch", f"{ticket.id} assigned to {worker.name} ({worker.harness})")
    prompt = (
        f"You are the {worker.harness} coding agent for Orca Digital Pod ticket {ticket.id}.\n"
        f"Work only inside this worktree: {worker.worktree_path}\n"
        f"Objective:\n{ticket.objective}\n\n"
        f"Requirements:\n- " + "\n- ".join(ticket.requirements) + "\n"
        "Attachments are in .ticket-attachments/. Shell commands are intercepted by the "
        "permission gate and executed in a sandbox. When finished, leave tests if you can."
    )
    ticket.status = "planning"
    save_ticket(ticket)
    dispatch(worker, ticket, prompt)
    return ActionResult(ok=True, message=f"Dispatched to {worker.name}", ticket_id=ticket.id, worker_id=worker.id)
