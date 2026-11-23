
from __future__ import annotations

import copy
import json
import re
from typing import Any

ALLOWED = {"GeoMap", "GanttChart", "MermaidDiagram", "GraphicWalker", "AgGrid"}
SECRET = re.compile(
    r"sk-[A-Za-z0-9_-]{6,}|bearer\s+[A-Za-z0-9._-]{8,}|"
    r"((?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*)(\S+)",
    re.I,
)


class VizError(Exception):
    pass


def scrub(value: Any) -> Any:
    if isinstance(value, str):
        return SECRET.sub(lambda m: f"{m.group(1)}[REDACTED]" if m.group(1) else "[REDACTED]", value)
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def validate(payload: dict[str, Any], *, skipped: bool = False) -> dict[str, Any]:
    if skipped or payload.get("skipped") is True:
        raise VizError("No-skip policy: visualizations with skipped=true are rejected")
    widget = payload.get("widget") or payload.get("component") or payload.get("widget_type")
    if widget not in ALLOWED:
        raise VizError(f"Unsupported widget {widget!r}. Allowed: {sorted(ALLOWED)}")
    clean = scrub(copy.deepcopy(payload))
    clean["widget"] = widget
    if "revision" not in clean:
        clean["revision"] = str(abs(hash(json.dumps(clean, sort_keys=True))) % 10**10)
    return clean


def mermaid_for_ticket(title: str, status: str, worker: str | None) -> dict[str, Any]:
    source = (
        "flowchart LR\n"
        f"  obj[{_esc(title)}] --> work[{_esc(worker or 'unassigned')}]\n"
        f"  work --> state[{_esc(status)}]\n"
    )
    return validate({"widget": "MermaidDiagram", "source": source, "revision": "auto"})


def _esc(text: str) -> str:
    return text.replace('"', "'")[:80]
