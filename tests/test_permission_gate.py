
from app.models import Ticket, Worker
from app.permission_gate import classify, jail_violation
from app.store import now_iso


def _ticket() -> Ticket:
    return Ticket(
        id="ORCA-1",
        title="Path-jail the sandbox",
        status="in-progress",
        created_at=now_iso(),
        updated_at=now_iso(),
        objective="Reject parent paths",
        requirements=["install httpx if needed"],
    )


def _worker(tier="low") -> Worker:
    return Worker(
        id="w1",
        name="oc",
        harness="opencode",
        model="x",
        worktree_path="/tmp/w",
        last_heartbeat=now_iso(),
        auto_approve_tier=tier,  # type: ignore[arg-type]
    )


def test_low_risk_auto_approved():
    risk, pending, reason = classify("git status", _ticket(), _worker())
    assert risk == "low"
    assert pending is False


def test_high_risk_pending():
    risk, pending, _ = classify("sudo rm -rf /", _ticket(), _worker("medium"))
    assert risk == "high"
    assert pending is True


def test_jail_parent_path():
    assert jail_violation("cat ../../.env")


def test_medium_matches_requirements():
    risk, pending, reason = classify("pip install httpx", _ticket(), _worker("low"))
    assert risk == "medium"
    assert pending is False
    assert "matches" in reason.lower()
