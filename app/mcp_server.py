
"""Optional FastMCP tool for ticket_submit_visualization.

If `mcp` / FastMCP is not installed, this module still exposes a callable used
by the control plane.
"""

from __future__ import annotations

from app.models import ActionResult
from app.store import append_log, load_ticket, save_ticket
from app import viz_validator


def ticket_submit_visualization(ticket_id: str, payload: dict, skipped: bool = False) -> ActionResult:
    ticket = load_ticket(ticket_id)
    if not ticket:
        return ActionResult(ok=False, message="Unknown ticket")
    try:
        clean = viz_validator.validate(payload, skipped=skipped)
    except viz_validator.VizError as exc:
        return ActionResult(ok=False, message=str(exc))
    ticket.viz = clean
    ticket.viz_status = "published"
    save_ticket(ticket)
    append_log(ticket, f"MCP published {clean.get('widget')}")
    return ActionResult(ok=True, message="Visualization published", ticket_id=ticket.id)


try:
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("orca-digital-pod")

    @mcp.tool()
    def ticket_submit_visualization_tool(ticket_id: str, payload: dict, skipped: bool = False) -> dict:
        result = ticket_submit_visualization(ticket_id, payload, skipped)
        return result.model_dump(by_alias=True)
except Exception:  # pragma: no cover
    mcp = None
