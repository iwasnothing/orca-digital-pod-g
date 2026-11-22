
from __future__ import annotations

import time

from app.exec_client import sandbox_exec
from app.models import ActionResult, GateRequest, PermissionIn
from app.permission_gate import classify, jail_violation
from app.store import (
    add_event,
    append_log,
    get_gate,
    get_worker,
    list_gates,
    load_ticket,
    new_id,
    now_iso,
    save_gate,
    save_ticket,
    save_worker,
)
from app import events as ev


def evaluate_and_maybe_exec(body: PermissionIn, *, wait_for_human: bool = True) -> ActionResult:
    worker = get_worker(body.worker_id)
    ticket = load_ticket(body.ticket_id)
    cwd = body.worktree_path or (worker.worktree_path if worker else "")
    risk, pending, reason = classify(body.command, ticket, worker)
    gate = GateRequest(
        id=new_id("gate"),
        worker_id=body.worker_id,
        ticket_id=body.ticket_id,
        command=body.command,
        risk_level=risk,
        status="pending" if pending else "approved",
        reason=reason,
        created_at=now_iso(),
    )
    save_gate(gate)
    if ticket:
        append_log(ticket, f"Gate {gate.status} ({risk}): {body.command} — {reason}")
    if worker and pending:
        worker.status = "pending-approval"
        save_worker(worker)
    add_event("gate", f"{gate.status} {risk} for {body.command}")
    if pending:
        return ActionResult(ok=True, message=reason, pending=True, gate_id=gate.id, ticket_id=body.ticket_id)
    return _run_approved(gate, cwd)


def _run_approved(gate: GateRequest, cwd: str) -> ActionResult:
    jail = jail_violation(gate.command)
    if jail:
        gate.status = "denied"
        gate.reason = jail
        gate.exit_code = 403
        gate.output = jail
        save_gate(gate)
        return ActionResult(ok=False, message=jail, gate_id=gate.id, exit_code=403, output=jail)
    allow_net = gate.risk_level in {"medium", "high"} and any(tok in gate.command.lower() for tok in ("pip", "npm", "curl", "wget", "uv "))
    result = sandbox_exec(gate.command, cwd, gate.worker_id, allow_network=allow_net)
    gate.output = result.get("output") or ""
    gate.exit_code = int(result.get("code") or 0)
    backend = result.get("backend") or "?"
    save_gate(gate)
    ticket = load_ticket(gate.ticket_id)
    if ticket:
        append_log(ticket, f"Sandbox {backend} exit {gate.exit_code}: {gate.command}")
    add_event("sandbox", f"{gate.command} -> {gate.exit_code} via {backend}")
    worker = get_worker(gate.worker_id)
    if worker and worker.status == "pending-approval":
        worker.status = "busy" if worker.current_ticket_id else "healthy"
        worker.last_heartbeat = now_iso()
        save_worker(worker)
    ok = gate.exit_code == 0
    return ActionResult(
        ok=ok,
        message=f"Executed via {backend} (exit {gate.exit_code})",
        gate_id=gate.id,
        ticket_id=gate.ticket_id,
        output=gate.output,
        exit_code=gate.exit_code,
    )


def resolve(gate_id: str, decision: str) -> ActionResult:
    gate = get_gate(gate_id)
    if not gate:
        return ActionResult(ok=False, message="Unknown gate request")
    if gate.status != "pending":
        return ActionResult(ok=False, message=f"Gate already {gate.status}")
    if decision == "deny":
        gate.status = "denied"
        save_gate(gate)
        ticket = load_ticket(gate.ticket_id)
        if ticket:
            append_log(ticket, f"Denied: {gate.command}")
        worker = get_worker(gate.worker_id)
        if worker:
            worker.status = "healthy"
            save_worker(worker)
        add_event("gate", f"Denied {gate.command}")
        return ActionResult(ok=True, message="Denied", gate_id=gate.id)
    gate.status = "approved"
    save_gate(gate)
    worker = get_worker(gate.worker_id)
    cwd = worker.worktree_path if worker else ""
    return _run_approved(gate, cwd)


def auto_resolve_eligible() -> list[str]:
    """Orchestrator risk-based approval: auto-approve pending gates within policy."""
    messages = []
    for gate in list_gates(pending_only=True):
        worker = get_worker(gate.worker_id)
        ticket = load_ticket(gate.ticket_id)
        risk, pending, reason = classify(gate.command, ticket, worker)
        # High risk still needs a person unless the orchestrator judges it safe-read.
        if pending and risk != "high":
            # Give humans a tiny window; watchdog will retry.
            continue
        if not pending:
            result = resolve(gate.id, "approve")
            messages.append(result.message)
        elif risk == "high" and jail_violation(gate.command):
            resolve(gate.id, "deny")
            messages.append(f"Auto-denied jail violation: {gate.command}")
    return messages
