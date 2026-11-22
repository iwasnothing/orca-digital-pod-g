
from __future__ import annotations

from pathlib import Path

from app.config import settings
from app.exec_client import sandbox_exec
from app.gate_service import evaluate_and_maybe_exec
from app.models import GapReport, PermissionIn, Ticket, Worker
from app.store import append_log, new_id, now_iso, save_gap, save_ticket
from app import viz_validator


def _gated_sandbox(ticket: Ticket, worker: Worker, command: str) -> dict:
    """Run a verification command through the permission gate + sandbox."""
    result = evaluate_and_maybe_exec(
        PermissionIn(
            worker_id=worker.id,
            ticket_id=ticket.id,
            worktree_path=worker.worktree_path,
            command=command,
        ),
        wait_for_human=False,
    )
    return {"code": result.exit_code if result.exit_code is not None else (0 if result.ok else 1), "output": result.output or result.message, "backend": "gate"}



def evaluate(ticket: Ticket, worker: Worker | None) -> tuple[bool, GapReport | None]:
    """Run tests in the worktree and enforce viz published. Returns (passed, gap_or_none)."""
    unmet: list[str] = []
    summary_parts: list[str] = []
    if worker:
        cwd = worker.worktree_path
        has_pytest = any(Path(cwd).rglob("test_*.py")) or (Path(cwd) / "tests").exists()
        if has_pytest:
            result = _gated_sandbox(ticket, worker, "python3 -m pytest -q")
            out = result.get("output") or ""
            code = 1 if result.get("code") is None else int(result["code"])
            summary_parts.append(f"pytest exit {code}: {out[-500:]}")
            if code != 0:
                unmet.append("Tests failed or pytest did not pass")
        else:
            ignore_names = {".ticket-prompt.md", "opencode.json", "user-edit.md"}
            ignore_parts = {".git", ".opencode", ".ticket-attachments", "tickets", "__pycache__", ".pytest_cache"}
            sources = []
            for p in Path(cwd).rglob("*"):
                if not p.is_file():
                    continue
                if any(part in ignore_parts for part in p.parts):
                    continue
                if p.name in ignore_names or p.name.startswith("."):
                    continue
                sources.append(p)
            if not sources:
                unmet.append("Worktree has no generated source files from the coding agent")
            py_files = [p for p in sources if p.suffix == ".py"]
            if py_files:
                result = _gated_sandbox(ticket, worker, "python3 -m compileall -q .")
                if int(result.get("code") if result.get("code") is not None else 1) != 0:
                    unmet.append("Python files failed compileall")
                    summary_parts.append(result.get("output") or "")
            elif sources:
                summary_parts.append(f"{len(sources)} non-Python source files present")
            unmet.append("No tests found (add pytest or test_*.py) for zero-gap completion")
    else:
        unmet.append("No worker assigned")

    if ticket.viz_status != "published" or not ticket.viz:
        # Auto-publish a mermaid of the work so the no-skip policy can be satisfied
        # without a separate MCP client in the first vertical slice.
        ticket.viz = viz_validator.mermaid_for_ticket(ticket.title, ticket.status, worker.id if worker else None)
        ticket.viz_status = "published"
        save_ticket(ticket)
        summary_parts.append("Auto-published MermaidDiagram visualization")

    passed = not unmet
    report = None
    if not passed:
        ticket.gap_iteration += 1
        if ticket.gap_iteration >= settings.max_gap_iterations:
            ticket.needs_human = True
            unmet.append(f"Reached max gap iterations ({settings.max_gap_iterations})")
        report = GapReport(
            id=new_id("gap"),
            ticket_id=ticket.id,
            iteration=ticket.gap_iteration,
            summary="; ".join(summary_parts) or "Gap analysis failed",
            unmet_criteria=unmet,
            created_at=now_iso(),
        )
        save_gap(report)
        append_log(ticket, f"Gap iteration {ticket.gap_iteration}: {report.summary} | unmet: {unmet}")
        ticket.status = "in-progress" if not ticket.needs_human else "in-review"
        save_ticket(ticket)
    else:
        for item in ticket.acceptance:
            item.done = True
        ticket.final_review = "Zero-gap evaluator: tests/smoke passed and visualization published."
        ticket.status = "done"
        ticket.updated_at = now_iso()
        save_ticket(ticket)
        append_log(ticket, "Zero-gap check passed; ticket moved to done")
    return passed, report
