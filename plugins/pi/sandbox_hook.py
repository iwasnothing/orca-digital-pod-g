
"""Pi harness command interception wrapper.

Wraps a would-be shell command with a POST to the permission gate, then
executes only if the gate auto-approves or a later resolve runs it.
"""

from __future__ import annotations

import json
import os
import urllib.request


GATE = os.environ.get("ORCA_POD_GATE_URL", "http://127.0.0.1:8877/api/permission-gate")


def intercept(command: str) -> dict:
    payload = {
        "worker_id": os.environ.get("ORCA_POD_WORKER_ID", ""),
        "ticket_id": os.environ.get("ORCA_POD_TICKET_ID", ""),
        "worktree_path": os.environ.get("ORCA_POD_WORKTREE", os.getcwd()),
        "command": command,
    }
    req = urllib.request.Request(
        GATE,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


if __name__ == "__main__":
    import sys

    cmd = " ".join(sys.argv[1:])
    result = intercept(cmd)
    print(json.dumps(result, indent=2))
    if result.get("pending"):
        sys.exit(2)
    sys.exit(int(result.get("exit_code") or result.get("exitCode") or (0 if result.get("ok") else 1)))
