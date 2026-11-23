
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app import orca_bridge
from app.config import settings
from app.events import hub
from app.gap_evaluator import evaluate
from app.gate_service import evaluate_and_maybe_exec, resolve
from app.models import (
    ActionIn,
    ActionResult,
    BoardState,
    FilePut,
    ObjectiveIn,
    PermissionIn,
    ResolveIn,
    TicketPatch,
    WorkerCreate,
)
from app import orchestrator
from app.store import (
    add_event,
    append_log,
    board_state,
    get_worker,
    init_db,
    list_gates,
    list_heartbeats,
    list_tickets,
    list_workers,
    load_ticket,
    now_iso,
    save_ticket,
    save_worker,
    set_supervision,
    supervision_enabled,
    upsert_heartbeat,
)
from app.workspace_fs import flatten_files, read_file, tree, write_file
from app import viz_validator
from app import watchdog
from sandbox_runner.jail import JailError

app = FastAPI(title="Orca Digital Pod Control Plane")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    settings.ensure_dirs()
    init_db()
    status, details = orca_bridge.health_details()
    upsert_heartbeat("orca-runtime", status, details)
    upsert_heartbeat("control-plane", "healthy", f"FastAPI :{settings.port}")
    upsert_heartbeat("watchdog", "healthy", f"interval {settings.watchdog_interval_sec}s")

    async def loop() -> None:
        await asyncio.sleep(3)
        while True:
            try:
                watchdog.cycle()
                await hub.broadcast({"type": "board", "payload": json.loads(board_state().model_dump_json(by_alias=True))})
            except Exception as exc:
                upsert_heartbeat("watchdog", "degraded", str(exc))
            await asyncio.sleep(max(5, settings.watchdog_interval_sec))

    asyncio.create_task(loop())


async def push() -> None:
    try:
        await hub.broadcast({"type": "board", "payload": json.loads(board_state().model_dump_json(by_alias=True))})
    except Exception:
        pass


def _ticket_or_404(ticket_id: str):
    t = load_ticket(ticket_id)
    if not t:
        raise HTTPException(404, "ticket not found")
    return t


def _worker_or_404(worker_id: str):
    w = get_worker(worker_id)
    if not w:
        raise HTTPException(404, "worker not found")
    return w


@app.get("/api/board", response_model=BoardState)
def get_board() -> BoardState:
    return board_state()


@app.get("/api/workers")
def get_workers() -> list:
    return [json.loads(w.model_dump_json(by_alias=True)) for w in list_workers()]


@app.get("/api/agents/health")
def agents_health() -> dict:
    status, details = orca_bridge.health_details()
    upsert_heartbeat("orca-runtime", status, details)
    return {"heartbeats": [json.loads(h.model_dump_json(by_alias=True)) for h in list_heartbeats()], "orca": orca_bridge.status()}


@app.post("/api/workers", response_model=ActionResult)
async def post_workers(body: WorkerCreate) -> ActionResult:
    result = orchestrator.register_worker(body)
    await push()
    return result


@app.post("/api/workers/{worker_id}/action", response_model=ActionResult)
async def post_worker_action(worker_id: str, body: ActionIn) -> ActionResult:
    worker = _worker_or_404(worker_id)
    ticket = load_ticket(worker.current_ticket_id) if worker.current_ticket_id else None
    if body.action in {"nudge", "resume", "restart"}:
        if ticket:
            append_log(ticket, f"Manual {body.action} from the console")
            if body.action in {"resume", "restart"}:
                from app.harness_runner import dispatch

                dispatch(worker, ticket, f"{body.action.title()} work on {ticket.id}: {ticket.objective}")
        worker.status = "busy" if ticket else "healthy"
        worker.last_heartbeat = now_iso()
        save_worker(worker)
        add_event(body.action, f"{body.action} {worker.name}")
        await push()
        return ActionResult(ok=True, message=f"{body.action} sent", worker_id=worker.id)
    return ActionResult(ok=False, message="Unknown action")


@app.post("/api/objectives", response_model=ActionResult)
async def post_objectives(body: ObjectiveIn) -> ActionResult:
    result = orchestrator.intake(body)
    await push()
    return result


@app.get("/api/tickets/{ticket_id}")
def get_ticket(ticket_id: str) -> dict:
    ticket = _ticket_or_404(ticket_id)
    worker = get_worker(ticket.assigned_worker_id) if ticket.assigned_worker_id else None
    if worker:
        ticket.files = flatten_files(Path(worker.worktree_path))
    return json.loads(ticket.model_dump_json(by_alias=True))


@app.patch("/api/tickets/{ticket_id}", response_model=ActionResult)
async def patch_ticket(ticket_id: str, body: TicketPatch) -> ActionResult:
    ticket = _ticket_or_404(ticket_id)
    if body.acceptance_index is not None and 0 <= body.acceptance_index < len(ticket.acceptance):
        ticket.acceptance[body.acceptance_index].done = not ticket.acceptance[body.acceptance_index].done
    if body.assigned_worker_id is not None:
        ticket.assigned_worker_id = body.assigned_worker_id or None
    if body.gap_notes:
        append_log(ticket, body.gap_notes)
    if body.status:
        if body.status == "done":
            worker = get_worker(ticket.assigned_worker_id) if ticket.assigned_worker_id else None
            passed, report = evaluate(ticket, worker)
            await push()
            if not passed:
                return ActionResult(
                    ok=False,
                    gap=True,
                    ticket_id=ticket.id,
                    message="Zero-gap check failed; ticket remains in review/in-progress",
                )
            return ActionResult(ok=True, message="Moved to done", ticket_id=ticket.id)
        ticket.status = body.status
        ticket.updated_at = now_iso()
        save_ticket(ticket)
        add_event("move", f"{ticket.id} -> {ticket.status}")
    await push()
    return ActionResult(ok=True, message="Updated", ticket_id=ticket.id)


@app.post("/api/tickets/{ticket_id}/attachments", response_model=ActionResult)
async def post_attachment(ticket_id: str, file: UploadFile = File(...)) -> ActionResult:
    ticket = _ticket_or_404(ticket_id)
    data = await file.read()
    if b"\x00" in data:
        raise HTTPException(400, "Binary files are rejected")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(400, "Non-UTF-8 content is rejected") from exc
    name = Path(file.filename or "attachment.txt").name
    dest = settings.attachments_dir / ticket.id
    dest.mkdir(parents=True, exist_ok=True)
    (dest / name).write_text(text)
    ticket.attachments.append({"name": name, "content": text})  # type: ignore[arg-type]
    save_ticket(ticket)
    worker = get_worker(ticket.assigned_worker_id) if ticket.assigned_worker_id else None
    if worker:
        write_file(Path(worker.worktree_path), f".ticket-attachments/{name}", text)
    append_log(ticket, f"Attached {name}")
    await push()
    return ActionResult(ok=True, message=f"Attached {name}", ticket_id=ticket.id)


@app.get("/api/workspaces/{worker_id}/tree")
def workspace_tree(worker_id: str) -> dict:
    worker = _worker_or_404(worker_id)
    return {"root": worker.worktree_path, "tree": tree(Path(worker.worktree_path))}


@app.get("/api/workspaces/{worker_id}/file")
def workspace_file(worker_id: str, path: str) -> dict:
    worker = _worker_or_404(worker_id)
    try:
        content = read_file(Path(worker.worktree_path), path)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except JailError as exc:
        raise HTTPException(403, str(exc)) from exc
    return {"path": path, "content": content}


@app.put("/api/workspaces/{worker_id}/file", response_model=ActionResult)
async def put_workspace_file(worker_id: str, body: FilePut) -> ActionResult:
    worker = _worker_or_404(worker_id)
    try:
        write_file(Path(worker.worktree_path), body.file_path, body.content)
    except JailError as exc:
        raise HTTPException(403, str(exc)) from exc
    if worker.current_ticket_id:
        ticket = load_ticket(worker.current_ticket_id)
        if ticket:
            append_log(ticket, f"Saved {body.file_path}")
    await push()
    return ActionResult(ok=True, message=f"Saved {body.file_path}", worker_id=worker_id)


@app.post("/api/permission-gate", response_model=ActionResult)
async def post_permission_gate(body: PermissionIn) -> ActionResult:
    result = evaluate_and_maybe_exec(body)
    await push()
    return result


@app.get("/api/permission-gate/pending")
def pending_gates() -> list:
    return [json.loads(g.model_dump_json(by_alias=True)) for g in list_gates(pending_only=True)]


@app.post("/api/permission-gate/{gate_id}/resolve", response_model=ActionResult)
async def resolve_gate(gate_id: str, body: ResolveIn) -> ActionResult:
    result = resolve(gate_id, body.decision)
    await push()
    return result


@app.get("/api/tickets/{ticket_id}/visualization")
def get_viz(ticket_id: str) -> dict:
    ticket = _ticket_or_404(ticket_id)
    return {"viz": ticket.viz, "status": ticket.viz_status}


@app.put("/api/tickets/{ticket_id}/visualization")
async def put_viz(ticket_id: str, payload: dict[str, Any]) -> ActionResult:
    ticket = _ticket_or_404(ticket_id)
    try:
        clean = viz_validator.validate(payload, skipped=bool(payload.get("skipped")))
    except viz_validator.VizError as exc:
        raise HTTPException(400, str(exc)) from exc
    if ticket.viz and payload.get("revision") and ticket.viz.get("revision") not in {payload.get("revision"), None}:
        # 409 on SHA conflict when a stale revision is supplied and current differs
        current_rev = ticket.viz.get("revision")
        if current_rev and current_rev != payload.get("revision") and payload.get("base_revision") not in {current_rev, None}:
            raise HTTPException(409, "revision conflict")
    ticket.viz = clean
    ticket.viz_status = "published"
    save_ticket(ticket)
    append_log(ticket, f"Published visualization {clean.get('widget')}")
    add_event("viz", f"{ticket.id} published {clean.get('widget')}")
    await push()
    return ActionResult(ok=True, message="Visualization published", ticket_id=ticket.id)


@app.post("/api/watchdog/tick")
async def watchdog_tick() -> dict:
    result = watchdog.cycle()
    await push()
    return result


@app.post("/api/supervision")
async def set_sup(body: dict) -> dict:
    set_supervision(bool(body.get("on", True)))
    await push()
    return {"ok": True, "supervision": supervision_enabled()}


@app.websocket("/ws/events")
async def ws_events(ws: WebSocket) -> None:
    await hub.connect(ws)
    try:
        await ws.send_text(json.dumps({"type": "board", "payload": json.loads(board_state().model_dump_json(by_alias=True))}))
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        await hub.disconnect(ws)
    except Exception:
        await hub.disconnect(ws)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "control-plane"}
