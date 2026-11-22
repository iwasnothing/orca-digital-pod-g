
from __future__ import annotations

import argparse
import hashlib
import time

from app.config import settings
from app.gate_service import auto_resolve_eligible
from app.gap_evaluator import evaluate
from app.harness_runner import dispatch
from app.models import Stall
from app.orca_bridge import health_details, worker_read, worktree_ps
from app.store import (
    add_event,
    append_log,
    get_stall,
    get_worker,
    init_db,
    list_tickets,
    list_workers,
    load_ticket,
    now_iso,
    save_worker,
    set_stall,
    supervision_enabled,
    upsert_heartbeat,
)


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]


def _output_snapshot(worker) -> str:
    parts = []
    if worker.current_ticket_id:
        raw = worker_read(worker.current_ticket_id)
        if raw:
            parts.append(raw)
    ps = worktree_ps()
    parts.append(str(ps)[:2000])
    # Also hash worktree mtimes so local (non-Orca) workers can stall-detect
    from pathlib import Path

    root = Path(worker.worktree_path)
    if root.exists():
        entries = []
        for f in sorted(root.rglob("*")):
            if f.is_file() and ".git" not in f.parts:
                try:
                    st = f.stat()
                    entries.append(f"{f.relative_to(root)}:{st.st_mtime_ns}:{st.st_size}")
                except OSError:
                    continue
        parts.append("\n".join(entries[-200:]))
    return "\n".join(parts) or "(empty)"


def cycle() -> dict:
    if not supervision_enabled():
        upsert_heartbeat("watchdog", "degraded", "supervision paused")
        return {"ok": True, "paused": True}

    status, details = health_details()
    upsert_heartbeat("orca-runtime", status, details)

    try:
        import httpx
        from app.config import settings as _s
        with httpx.Client(timeout=2) as _c:
            sh = _c.get(f"http://127.0.0.1:{_s.sandbox_port}/health")
            data = sh.json()
            upsert_heartbeat("sandbox-runner", "healthy" if data.get("ok") else "degraded", f"backend={data.get('backend')}")
            lh = _c.get(f"http://127.0.0.1:{_s.llm_proxy_port}/health")
            data = lh.json()
            upsert_heartbeat("llm-proxy", "healthy" if data.get("configured") else "degraded", "sidecar configured" if data.get("has_key") else "no upstream key")
    except Exception as exc:
        upsert_heartbeat("sandbox-runner", "degraded", str(exc))

    messages: list[str] = []
    messages.extend(auto_resolve_eligible())

    for worker in list_workers():
        snap = _output_snapshot(worker)
        digest = _hash(snap)
        prev = get_stall(worker.id)
        if prev.hash == digest:
            repeats = prev.repeats + 1
        else:
            repeats = 0
        set_stall(worker.id, Stall(output=snap[-400:], hash=digest, repeats=repeats))
        worker.last_heartbeat = now_iso()
        if worker.status == "pending-approval":
            save_worker(worker)
            continue
        if worker.status == "busy" and repeats >= 3:
            worker.status = "stalled"
            save_worker(worker)
            add_event("restart", f"Hard restart after 3 unchanged cycles: {worker.name}")
            ticket = load_ticket(worker.current_ticket_id) if worker.current_ticket_id else None
            if ticket:
                append_log(ticket, "Watchdog hard-restarted a stalled worker in the same worktree")
                prompt = f"Resume work on {ticket.id}: {ticket.objective}\nThe previous run stalled. Continue from the current files."
                dispatch(worker, ticket, prompt)
                messages.append(f"restarted {worker.id}")
            continue
        if worker.status == "busy" and repeats == 2:
            worker.status = "stalled"
            save_worker(worker)
            add_event("nudge", f"Soft nudge: {worker.name} output unchanged")
            ticket = load_ticket(worker.current_ticket_id) if worker.current_ticket_id else None
            if ticket:
                append_log(ticket, "Watchdog nudged a stalled worker")
            messages.append(f"nudged {worker.id}")
            continue
        if worker.status != "pending-approval":
            if worker.current_ticket_id:
                worker.status = "busy"
            elif worker.status not in {"offline"}:
                worker.status = "healthy" if worker.status != "idle" else "idle"
            save_worker(worker)

    for ticket in list_tickets():
        if ticket.status != "in-review":
            continue
        if ticket.needs_human:
            continue
        worker = get_worker(ticket.assigned_worker_id) if ticket.assigned_worker_id else None
        passed, report = evaluate(ticket, worker)
        if passed:
            add_event("gap", f"{ticket.id} passed zero-gap review and moved to done")
            messages.append(f"done {ticket.id}")
            if worker:
                worker.current_ticket_id = None
                worker.status = "healthy"
                save_worker(worker)
        elif report:
            add_event("gap", f"{ticket.id} gap iteration {report.iteration}: {report.summary}")
            if worker and not ticket.needs_human:
                prompt = (
                    f"Gap analysis for {ticket.id} (iteration {report.iteration}):\n"
                    f"{report.summary}\nUnmet:\n- " + "\n- ".join(report.unmet_criteria) +
                    "\nPlease fill the gaps in the worktree."
                )
                dispatch(worker, ticket, prompt)
                messages.append(f"gap-dispatch {ticket.id}")
    upsert_heartbeat("watchdog", "healthy", f"cycle complete; {len(messages)} actions")
    return {"ok": True, "actions": messages}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--interval", type=int, default=settings.watchdog_interval_sec)
    args = parser.parse_args()
    init_db()
    while True:
        try:
            cycle()
        except Exception as exc:
            upsert_heartbeat("watchdog", "degraded", str(exc))
        time.sleep(max(5, args.interval))


if __name__ == "__main__":
    main()
