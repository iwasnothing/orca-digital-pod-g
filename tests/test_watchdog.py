
from app.models import WorkerCreate, ObjectiveIn
from app import orchestrator
from app.store import list_tickets, list_workers
from app.harness_runner import echo_harness, get_worker
from app.store import load_ticket
from app import watchdog
from app.gap_evaluator import evaluate


def test_echo_and_gap_can_finish(isolated_data):
    created = orchestrator.register_worker(WorkerCreate(name="Echo One", harness="opencode", model="echo", auto_approve_tier="medium"))
    assert created.ok
    result = orchestrator.intake(ObjectiveIn(objective="Ship a hello helper\n- include a pytest"))
    assert result.ok and result.ticket_id
    worker = list_workers()[0]
    ticket = load_ticket(result.ticket_id)
    assert ticket is not None
    # Run echo inline (not in a thread) so the test is deterministic
    msg = echo_harness(worker, ticket, ticket.objective)
    assert "echo-harness" in msg
    ticket = load_ticket(result.ticket_id)
    worker = list_workers()[0]
    passed, report = evaluate(ticket, worker)
    ticket = load_ticket(result.ticket_id)
    assert passed is True
    assert ticket.status == "done"
