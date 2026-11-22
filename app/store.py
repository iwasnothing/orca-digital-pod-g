
from __future__ import annotations

import json
import re
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.config import settings
from app.models import (
    Acceptance,
    Attachment,
    BoardState,
    GapReport,
    GateRequest,
    Heartbeat,
    LogLine,
    PodEvent,
    Stall,
    Ticket,
    Worker,
)

_lock = threading.RLock()
_supervision = True
_stall: dict[str, Stall] = {}
_events: list[PodEvent] = []


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:8]}"


def _connect() -> sqlite3.Connection:
    settings.ensure_dirs()
    conn = sqlite3.connect(settings.db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    settings.ensure_dirs()
    with _lock:
        conn = _connect()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS workers (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    harness TEXT NOT NULL,
                    model TEXT NOT NULL,
                    worktree_path TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'idle',
                    current_ticket_id TEXT,
                    last_heartbeat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    auto_approve_tier TEXT NOT NULL DEFAULT 'low',
                    orca_worktree_id TEXT,
                    harness_note TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS permission_requests (
                    id TEXT PRIMARY KEY,
                    worker_id TEXT NOT NULL,
                    ticket_id TEXT NOT NULL,
                    command TEXT NOT NULL,
                    risk_level TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    reason TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    output TEXT,
                    exit_code INTEGER
                );
                CREATE TABLE IF NOT EXISTS agent_heartbeats (
                    component TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    details TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS gap_reports (
                    id TEXT PRIMARY KEY,
                    ticket_id TEXT NOT NULL,
                    iteration INTEGER NOT NULL,
                    summary TEXT NOT NULL,
                    unmet_criteria TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS pod_events (
                    id TEXT PRIMARY KEY,
                    time TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    message TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )
            conn.commit()
        finally:
            conn.close()
        for component, details in (
            ("control-plane", "FastAPI listening"),
            ("orca-runtime", "checking"),
            ("sandbox-runner", "checking"),
            ("llm-proxy", "checking"),
            ("watchdog", "idle"),
        ):
            upsert_heartbeat(component, "degraded", details)


def set_supervision(on: bool) -> None:
    global _supervision
    with _lock:
        _supervision = on
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('supervision', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                ("1" if on else "0",),
            )
            conn.commit()
        finally:
            conn.close()


def supervision_enabled() -> bool:
    with _lock:
        conn = _connect()
        try:
            row = conn.execute("SELECT value FROM meta WHERE key='supervision'").fetchone()
            if row is None:
                return _supervision
            return row["value"] == "1"
        finally:
            conn.close()


def add_event(kind: str, message: str) -> PodEvent:
    ev = PodEvent(id=new_id("evt"), time=now_iso(), kind=kind, message=message)
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO pod_events(id, time, kind, message) VALUES(?,?,?,?)",
                (ev.id, ev.time, ev.kind, ev.message),
            )
            conn.commit()
        finally:
            conn.close()
        _events.insert(0, ev)
        del _events[200:]
    return ev


def list_events(limit: int = 50) -> list[PodEvent]:
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute("SELECT * FROM pod_events ORDER BY time DESC LIMIT ?", (limit,)).fetchall()
            return [PodEvent(**dict(r)) for r in rows]
        finally:
            conn.close()


def upsert_heartbeat(component: str, status: str, details: str) -> None:
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO agent_heartbeats(component, status, details, updated_at)
                VALUES(?,?,?,?)
                ON CONFLICT(component) DO UPDATE SET
                    status=excluded.status, details=excluded.details, updated_at=excluded.updated_at
                """,
                (component, status, details, now_iso()),
            )
            conn.commit()
        finally:
            conn.close()


def list_heartbeats() -> list[Heartbeat]:
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute("SELECT * FROM agent_heartbeats ORDER BY component").fetchall()
            return [Heartbeat(**dict(r)) for r in rows]
        finally:
            conn.close()


def ticket_path(ticket_id: str) -> Path:
    return settings.tickets_dir / f"{ticket_id}.md"


def ticket_to_markdown(ticket: Ticket) -> str:
    checks = "\n".join(f"- [{'x' if a.done else ' '}] {a.text}" for a in ticket.acceptance) or "- [ ] Define acceptance"
    reqs = "\n".join(f"- {r}" for r in ticket.requirements) or "- (none)"
    atts = "\n".join(f"- {a.name}" for a in ticket.attachments) or "- none"
    log = "\n".join(f"- {l.time}: {l.message}" for l in ticket.execution_log) or "- quiet"
    viz_line = "status: none"
    if ticket.viz:
        viz_line = f"status: {ticket.viz_status}\nwidget_type: {ticket.viz.get('widget', '')}"
    return f"""---
id: {ticket.id}
title: {ticket.title}
status: {ticket.status}
priority: {ticket.priority}
assigned_worker_id: {ticket.assigned_worker_id or ''}
dispatch_id: {ticket.dispatch_id or ''}
gap_iteration: {ticket.gap_iteration}
needs_human: {'true' if ticket.needs_human else 'false'}
created_at: '{ticket.created_at}'
updated_at: '{ticket.updated_at}'
viz_status: {ticket.viz_status}
---
# Objective
{ticket.objective}

# Requirements
{reqs}

# Context
{ticket.context}

# Acceptance Criteria
{checks}

# Attachments
{atts}

# Visualization
{viz_line}

# Execution Log
{log}

# Final Review
{ticket.final_review}
"""


def _section(md: str, heading: str) -> str:
    pat = rf"^# {re.escape(heading)}\s*\n(.*?)(?=^# |\Z)"
    m = re.search(pat, md, re.M | re.S)
    return (m.group(1).strip() if m else "")


def _bullets(text: str) -> list[str]:
    items = []
    for line in text.splitlines():
        s = re.sub(r"^-\s+", "", line.strip())
        if s and s not in {"(none)", "none", "quiet"}:
            items.append(s)
    return items


def parse_ticket_markdown(text: str, attachments: list[Attachment] | None = None) -> Ticket:
    fm: dict[str, str] = {}
    body = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    fm[k.strip()] = v.strip().strip("'\"")
            body = parts[2]
    acc = []
    for raw in _bullets(_section(body, "Acceptance Criteria")):
        done = raw.startswith("[x]") or raw.startswith("[X]")
        label = re.sub(r"^\[[ xX]\]\s*", "", raw)
        acc.append(Acceptance(text=label, done=done))
    logs = []
    for raw in _bullets(_section(body, "Execution Log")):
        if ": " in raw:
            t, msg = raw.split(": ", 1)
            logs.append(LogLine(time=t, message=msg))
        elif raw != "quiet":
            logs.append(LogLine(time="", message=raw))
    att_names = _bullets(_section(body, "Attachments"))
    atts = attachments if attachments is not None else [Attachment(name=n) for n in att_names if n != "none"]
    viz = None
    viz_block = _section(body, "Visualization")
    widget = ""
    for line in viz_block.splitlines():
        if line.lower().startswith("widget_type:"):
            widget = line.split(":", 1)[1].strip()
    if widget:
        viz = {"widget": widget, "revision": "md"}
    return Ticket(
        id=fm.get("id") or new_id("ORCA"),
        title=fm.get("title") or "Untitled",
        status=fm.get("status") or "backlog",  # type: ignore[arg-type]
        priority=fm.get("priority") or "medium",  # type: ignore[arg-type]
        assigned_worker_id=fm.get("assigned_worker_id") or None,
        dispatch_id=fm.get("dispatch_id") or None,
        gap_iteration=int(fm.get("gap_iteration") or 0),
        needs_human=fm.get("needs_human", "false").lower() == "true",
        created_at=fm.get("created_at", "").strip("'") or now_iso(),
        updated_at=fm.get("updated_at", "").strip("'") or now_iso(),
        objective=_section(body, "Objective"),
        requirements=_bullets(_section(body, "Requirements")),
        context=_section(body, "Context"),
        acceptance=acc,
        attachments=atts,
        viz=viz,
        viz_status=fm.get("viz_status") or ("published" if "status: published" in viz_block else "none"),  # type: ignore[arg-type]
        execution_log=logs,
        final_review=_section(body, "Final Review"),
    )


def save_ticket(ticket: Ticket) -> None:
    settings.tickets_dir.mkdir(parents=True, exist_ok=True)
    # persist attachment bodies separately
    tdir = settings.attachments_dir / ticket.id
    tdir.mkdir(parents=True, exist_ok=True)
    if ticket.viz:
        (tdir / "a2ui-v1.json").write_text(json.dumps(ticket.viz, indent=2))
    for att in ticket.attachments:
        if att.content:
            (tdir / att.name).write_text(att.content)
    ticket_path(ticket.id).write_text(ticket_to_markdown(ticket))


def load_ticket(ticket_id: str) -> Ticket | None:
    path = ticket_path(ticket_id)
    if not path.exists():
        return None
    tdir = settings.attachments_dir / ticket_id
    atts: list[Attachment] = []
    if tdir.exists():
        for f in sorted(tdir.iterdir()):
            if f.is_file() and f.name != "a2ui-v1.json" and f.suffix.lower() not in {".png", ".jpg", ".pdf", ".zip"}:
                try:
                    atts.append(Attachment(name=f.name, content=f.read_text()))
                except UnicodeDecodeError:
                    atts.append(Attachment(name=f.name, content=""))
    ticket = parse_ticket_markdown(path.read_text(), atts)
    viz_file = tdir / "a2ui-v1.json"
    if viz_file.exists():
        try:
            ticket.viz = json.loads(viz_file.read_text())
        except json.JSONDecodeError:
            pass
    return ticket


def list_tickets() -> list[Ticket]:
    settings.tickets_dir.mkdir(parents=True, exist_ok=True)
    tickets = []
    for path in sorted(settings.tickets_dir.glob("*.md")):
        if path.name == "TEMPLATE.md":
            continue
        t = load_ticket(path.stem)
        if t:
            tickets.append(t)
    tickets.sort(key=lambda t: t.created_at)
    return tickets


def append_log(ticket: Ticket, message: str) -> Ticket:
    ticket.execution_log.append(LogLine(time=now_iso(), message=message))
    ticket.updated_at = now_iso()
    save_ticket(ticket)
    return ticket


def save_worker(worker: Worker) -> None:
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO workers(id, name, harness, model, worktree_path, status, current_ticket_id,
                    last_heartbeat, auto_approve_tier, orca_worktree_id, harness_note)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name, harness=excluded.harness, model=excluded.model,
                    worktree_path=excluded.worktree_path, status=excluded.status,
                    current_ticket_id=excluded.current_ticket_id, last_heartbeat=excluded.last_heartbeat,
                    auto_approve_tier=excluded.auto_approve_tier, orca_worktree_id=excluded.orca_worktree_id,
                    harness_note=excluded.harness_note
                """,
                (
                    worker.id, worker.name, worker.harness, worker.model, worker.worktree_path,
                    worker.status, worker.current_ticket_id, worker.last_heartbeat,
                    worker.auto_approve_tier, worker.orca_worktree_id, worker.harness_note,
                ),
            )
            conn.commit()
        finally:
            conn.close()


def get_worker(worker_id: str) -> Worker | None:
    with _lock:
        conn = _connect()
        try:
            row = conn.execute("SELECT * FROM workers WHERE id=?", (worker_id,)).fetchone()
            return Worker(**dict(row)) if row else None
        finally:
            conn.close()


def list_workers() -> list[Worker]:
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute("SELECT * FROM workers ORDER BY name").fetchall()
            return [Worker(**dict(r)) for r in rows]
        finally:
            conn.close()


def save_gate(gate: GateRequest) -> None:
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO permission_requests(id, worker_id, ticket_id, command, risk_level, status, reason, created_at, output, exit_code)
                VALUES(?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    status=excluded.status, reason=excluded.reason, output=excluded.output, exit_code=excluded.exit_code
                """,
                (
                    gate.id, gate.worker_id, gate.ticket_id, gate.command, gate.risk_level,
                    gate.status, gate.reason, gate.created_at, gate.output, gate.exit_code,
                ),
            )
            conn.commit()
        finally:
            conn.close()


def get_gate(gate_id: str) -> GateRequest | None:
    with _lock:
        conn = _connect()
        try:
            row = conn.execute("SELECT * FROM permission_requests WHERE id=?", (gate_id,)).fetchone()
            return GateRequest(**dict(row)) if row else None
        finally:
            conn.close()


def list_gates(pending_only: bool = False) -> list[GateRequest]:
    with _lock:
        conn = _connect()
        try:
            sql = "SELECT * FROM permission_requests"
            if pending_only:
                sql += " WHERE status='pending'"
            sql += " ORDER BY created_at DESC"
            return [GateRequest(**dict(r)) for r in conn.execute(sql).fetchall()]
        finally:
            conn.close()


def save_gap(report: GapReport) -> None:
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO gap_reports(id, ticket_id, iteration, summary, unmet_criteria, created_at)
                VALUES(?,?,?,?,?,?)
                """,
                (report.id, report.ticket_id, report.iteration, report.summary, json.dumps(report.unmet_criteria), report.created_at),
            )
            conn.commit()
        finally:
            conn.close()


def list_gaps(ticket_id: str | None = None) -> list[GapReport]:
    with _lock:
        conn = _connect()
        try:
            if ticket_id:
                rows = conn.execute(
                    "SELECT * FROM gap_reports WHERE ticket_id=? ORDER BY created_at DESC", (ticket_id,)
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM gap_reports ORDER BY created_at DESC").fetchall()
            out = []
            for r in rows:
                d = dict(r)
                unmet = d.get("unmet_criteria") or "[]"
                d["unmet_criteria"] = json.loads(unmet) if isinstance(unmet, str) else unmet
                out.append(GapReport(**d))
            return out
        finally:
            conn.close()


def get_stall(worker_id: str) -> Stall:
    return _stall.get(worker_id, Stall())


def set_stall(worker_id: str, stall: Stall) -> None:
    _stall[worker_id] = stall


def board_state() -> BoardState:
    tickets = list_tickets()
    # attach a shallow files map from worktrees for the UI
    workers = {w.id: w for w in list_workers()}
    for t in tickets:
        wid = t.assigned_worker_id
        if not wid or wid not in workers:
            continue
        root = Path(workers[wid].worktree_path)
        files: dict[str, str] = {}
        if root.exists():
            for f in root.rglob("*"):
                if not f.is_file():
                    continue
                rel = f.relative_to(root).as_posix()
                if rel.startswith(".") or "/." in rel or rel.startswith(".git"):
                    continue
                if f.stat().st_size > 80_000:
                    continue
                try:
                    files[rel] = f.read_text()[:80_000]
                except (UnicodeDecodeError, OSError):
                    continue
        t.files = files
    return BoardState(
        workers=list_workers(),
        tickets=tickets,
        gates=list_gates(),
        gaps=list_gaps(),
        events=list_events(),
        heartbeats=list_heartbeats(),
        stall=_stall,
        supervision=supervision_enabled(),
    )
