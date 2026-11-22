
from __future__ import annotations

import re

from app.models import Risk, Ticket, Worker

LOW = re.compile(
    r"^(ls|pwd|cat|head|tail|wc|echo|git\s+status|git\s+diff|git\s+log|pytest|python\s+-m\s+pytest|python\s+-c\s+|true|test\b)",
    re.I,
)
MEDIUM = re.compile(r"\b(pip|npm|pnpm|yarn|uv|apt|apt-get|brew|migrate|install|pip3)\b", re.I)
HIGH = re.compile(
    r"\b(sudo|rm\s+-rf\s+/|chmod\s+777|mkfs|dd\s+if=|shutdown|reboot|curl\b|wget\b|nc\b|ncat\b|ssh\b|scp\b)\b"
    r"|/etc/passwd|\bcrontab\b",
    re.I,
)
JAIL = re.compile(r"(^|[;&|]\s*)(rm\s+-rf\s+\.\.|\.\./|cd\s+/|cd\s+\.\.)")


def jail_violation(command: str) -> str | None:
    cmd = command.strip()
    if not cmd:
        return "Empty command"
    if JAIL.search(cmd) or any(".." in tok for tok in cmd.split()):
        return "Path jail: command must stay inside the worker worktree"
    if re.search(r"/(etc|root|proc|sys)/", cmd) and not cmd.startswith("cat "):
        if re.search(r"/(etc|root)/", cmd):
            return "Path jail: system paths are not allowed"
    return None


def classify(command: str, ticket: Ticket | None, worker: Worker | None) -> tuple[Risk, bool, str]:
    """Return (risk, pending, reason). pending=True means wait for human (or orchestrator)."""
    cmd = command.strip()
    jail = jail_violation(cmd)
    if jail:
        return "high", True, jail
    risk: Risk = "medium"
    if HIGH.search(cmd):
        risk = "high"
    elif LOW.search(cmd):
        risk = "low"
    elif MEDIUM.search(cmd):
        risk = "medium"
    else:
        risk = "medium"

    if risk == "high":
        return risk, True, "High-risk command waits for a person or orchestrator review"
    tier = worker.auto_approve_tier if worker else "low"
    rank = {"low": 0, "medium": 1, "high": 2}
    if rank[risk] <= rank[tier]:
        reason = "Read-only command auto-approved" if risk == "low" else "Inside this worker's auto-approve tier"
        return risk, False, reason
    if risk == "low":
        return risk, False, "Read-only command auto-approved"
    blob = ""
    if ticket:
        blob = f"{ticket.title}\n{ticket.objective}\n{chr(10).join(ticket.requirements)}".lower()
    if blob and re.search(r"install|migrat|dependency|package", blob) and re.search(r"install|migrat", cmd.lower()):
        return risk, False, "Command matches the ticket requirements"
    return risk, True, "Medium risk is not covered by the ticket or auto-approve tier"
