# **Orca Digital Pod: Autonomous Agentic Kanban & Orchestration Blueprint (macOS Host Architecture)**

<!--
Summary Comment Block:
This document defines the architectural specification and implementation blueprint for the Orca Digital Pod running directly on a macOS host. It details process topologies, local service orchestration, environment configuration, permission gate sandboxing, watchdog gap-analysis, Jira-style Kanban UI, and the A2UI v2 visualization engine without container or Kubernetes dependencies.
-->

## **1. Architectural Overview & System Design**

The **Orca Digital Pod** is an autonomous agentic Kanban and orchestration system designed to run natively on a macOS workstation (`darwin`). It unifies the **Orca Runtime**, multiple **Worker Harnesses** (`pi`, `opencode`, `deepseek`), **Command Interception via `tool.execute.before`**, an **HTTP Sandbox Permission Gate**, an **Automated Watchdog & Gap-Analysis Supervisor**, and a **Jira-Style Matrix Kanban Board** with mandatory **kanban-viz/v2 A2UI Visualization**.

All services execute directly on the macOS host, communicating over loopback (`127.0.0.1`), eliminating all Docker and Kubernetes container layers while preserving strict process and path isolation.

---

### **Local Host Process Topology**

```
+---------------------------------------------------------------------------------------------------+
| MACOS LOCAL WORKSTATION (Darwin arm64/x86_64)                                                     |
|                                                                                                   |
|  +---------------------------------------------------------------------------------------------+  |
|  | Process 1: Control Plane & Kanban WebUI (127.0.0.1:8787)                                    |  |
|  |  • FastAPI REST API & WebSocket /ws/events                                                  |  |
|  |  • Static Jira-Style Kanban UI & A2UI v2 host renderer                                      |  |
|  |  • SQLite State Manager (${WORKSPACE_ROOT}/.kanban/state.db)                                 |  |
|  |  • File-backed Markdown ticket store (./tickets/<id>.md)                                    |  |
|  |  • Permission Gate Evaluation & Human Approval Queue                                        |  |
|  +---------------------------------------------------------------------------------------------+  |
|         ^                                   ^                                   ^                 |
|         | (Orca RPC / WebSocket)            | (Command Evaluation)              | (Periodic Loop) |
|         v                                   v                                   v                 |
|  +----------------------+          +----------------------+          +-------------------------+  |
|  | Process 2:           |          | Process 3:           |          | Process 4:              |  |
|  | Orca Runtime Daemon  |          | Sandbox Runner       |          | Watchdog & Gap Analysis |  |
|  | (127.0.0.1:6768)     |          | (127.0.0.1:9090)     |          | (Background Scheduler)  |  |
|  | • Superagent Lead    |          | • Path-jail checks   |          | • Progress & Stall check|  |
|  | • Worker worktrees   |          | • macOS subprocess   |          | • Verification test run |  |
|  |   under workspace/   |          | • Timeout & clean pg |          | • Max 5 gap iterations  |  |
|  +----------------------+          +----------------------+          +-------------------------+  |
|         |                                                                                         |
|         | (All LLM API calls with dummy token sk-sidecar-local)                                   |
|         v                                                                                         |
|  +---------------------------------------------------------------------------------------------+  |
|  | Process 5: Local LLM Egress Sidecar Proxy (LiteLLM on 127.0.0.1:4000)                       |  |
|  |  • Injects real upstream API credentials from local .env                                    |  |
|  |  • Translates OpenAI / Anthropic / DeepSeek protocols to Custom LLM Gateway                  |  |
|  |  • Enforces token quotas, rate limits, PII/secret scrubbing, and audit logging              |  |
|  +---------------------------------------------------------------------------------------------+  |
|         |                                                                                         |
|         +---> Outbound HTTPS to Upstream Custom LLM Gateway (External Network)                    |
+---------------------------------------------------------------------------------------------------+
```

---

## **2. macOS Environment Configuration & Directory Scaffolding**

### **2.1 Environment Configuration (`.env`)**

All sensitive credentials and path configurations are externalized into `.env` and loaded via `python-dotenv`:

```bash
# ==============================================================================
# Orca Digital Pod - Local macOS Environment Configuration
# ==============================================================================

# Core Ports & Network Binding
HOST=127.0.0.1
PORT=8787
ORCA_DAEMON_PORT=6768
LLM_PROXY_PORT=4000
SANDBOX_PORT=9090

# Filesystem Paths
WORKSPACE_ROOT=./workspace
TICKETS_DIR=./tickets
ATTACHMENTS_DIR=./attachments
CATALOGS_DIR=./catalogs

# Service Endpoints
SANDBOX_EXEC_URL=http://127.0.0.1:9090/exec
ORCA_DAEMON_URL=http://127.0.0.1:6768

# LLM Harness Proxy Wiring (Local Loopback)
ANTHROPIC_BASE_URL=http://127.0.0.1:4000
ANTHROPIC_API_KEY=sk-sidecar-local
OPENAI_BASE_URL=http://127.0.0.1:4000/v1
OPENAI_API_KEY=sk-sidecar-local
DEEPSEEK_BASE_URL=http://127.0.0.1:4000/v1
DEEPSEEK_API_KEY=sk-sidecar-local

# Upstream LLM Gateway (Used exclusively by LiteLLM Proxy on :4000)
CUSTOM_LLM_API_KEY=your-actual-upstream-api-key-here
CUSTOM_LLM_ENDPOINT=https://your-custom-llm-gateway.internal/v1

# Operational Parameters
ORCA_MOCK_MODE=false
WATCHDOG_INTERVAL_SEC=180
MAX_GAP_ITERATIONS=5
LOG_LEVEL=DEBUG
```

---

### **2.2 Target Repository Scaffolding**

```
orca-digital-pod/
├── .env                              # Local environment variables (not committed)
├── .env.example                      # Template environment file
├── AGENTS.md                         # Architecture specification & developer guide
├── ChangeLog.md                      # Engineering change tracking log
├── app/
│   ├── __init__.py
│   ├── config.py                     # pydantic-settings configuration loader
│   ├── main.py                       # FastAPI entry point (REST + WebSocket /ws/events)
│   ├── models.py                     # Pydantic v2 domain schemas & request/response contracts
│   ├── store.py                      # Markdown ticket parser & SQLite database manager
│   ├── orca_bridge.py                # Native Orca CLI subprocess adapter + ORCA_MOCK_MODE
│   ├── permission_gate.py            # Command risk classification engine & queue
│   ├── watchdog.py                   # Background stall recovery & gap loop worker
│   ├── gap_evaluator.py              # Zero-gap test runner & report generator
│   ├── viz_validator.py              # kanban-viz/v2 validator & secret sanitizer
│   └── mcp_server.py                 # FastMCP server for ticket_submit_visualization
├── sandbox_runner/
│   ├── __init__.py
│   ├── server.py                     # Native macOS HTTP command execution runner (:9090)
│   └── jail.py                       # Canonical path-jail validation & confinement
├── plugins/
│   ├── opencode/
│   │   └── sandbox-gate.ts           # OpenCode tool.execute.before TypeScript hook
│   ├── pi/
│   │   └── sandbox_hook.py           # Pi harness command interception wrapper
│   └── deepseek/
│       └── sandbox_hook.py           # DeepSeek harness command interception wrapper
├── webui/static/
│   ├── index.html                    # Jira-style Kanban Single Page Application
│   ├── styles.css                    # CSS Grid layout & styling
│   ├── app.js                        # Client state router & WebSocket handler
│   └── viz/
│       ├── kanban-viz-host.js        # v2 host renderer engine
│       └── atlas/
│           └── countries-iso3166-1.geojson # Bundled offline GeoMap atlas file
├── catalogs/kanban-viz/v2/
│   └── catalog.json                  # kanban-viz/v2 widget schemas
├── tickets/                          # File-backed Markdown tickets
│   └── TEMPLATE.md                   # Standard ticket template
├── attachments/                      # Ticket attachments (<ticket-id>/...)
├── workspace/                        # macOS host workspace root
│   ├── .kanban/
│   │   └── state.db                  # Operational SQLite database
│   └── workers/                      # Git worktrees for coding harnesses
│       ├── pi-wt-1/
│       ├── opencode-wt-2/
│       └── deepseek-wt-3/
├── deploy/
│   ├── litellm-config.yaml           # Local LiteLLM proxy configuration
│   └── supervisord.conf              # Local macOS supervisord process manager
└── tests/
    ├── conftest.py                   # Pytest fixtures and test environment setup
    ├── test_api.py                   # REST & WebSocket endpoint tests
    ├── test_permission_gate.py       # Deterministic risk classification tests
    ├── test_sandbox_runner.py        # Path-jail traversal & execution runner tests
    ├── test_viz_v2.py                # kanban-viz/v2 validation & conflict tests
    └── test_watchdog.py              # Stall recovery & gap iteration loop tests
```

---

## **3. Jira-Style Kanban UI & Operational Journey**

### **3.1 6-Column Matrix Layout & Worker Swimlanes**
The UI renders a 6-column matrix across state transitions:
1. `backlog`: Ingested objectives prior to triage.
2. `to-do`: Triaged tickets assigned to workers.
3. `planning`: Architecture, task breakdown, and test scaffolding.
4. `in-progress`: Active code generation in the worker's worktree.
5. `in-review`: Execution of gap analysis, test suites, and A2UI visualization validation.
6. `done`: Verification passed, zero gaps remaining, visualization published.

Each registered worker (`pi`, `opencode`, `deepseek`) owns a dedicated horizontal swimlane displaying:
- Worker ID and harness badge.
- Active worktree path (e.g., `${WORKSPACE_ROOT}/workers/opencode-wt-2`).
- Status indicator pill (Healthy, Busy, Pending Approval, Stalled, Offline).
- Assigned ticket card count.

---

### **3.2 Objective Intake (+) & Superagent Decomposition**
- **Floating Action Button (+)**: Positioned at bottom-right of the screen.
- **Intake Modal**: Accepts objective description, target harness preference, and initial file attachments.
- **Decomposition**: `POST /api/objectives` triggers the Superagent to create Markdown ticket files under `tickets/`, copy attachments to `${WORKSPACE_ROOT}/workers/<worker-id>/.ticket-attachments/`, and initialize worker execution.

---

### **3.3 Ticket Drawer & Host Workspace Editor**
Clicking any ticket card opens a slide-over panel:
- **Attachment Viewer**: Synchronized attachments from `attachments/<ticket-id>/`.
- **Recursive Directory Tree**: Direct browsing of the assigned worker's worktree via `GET /api/workspaces/{worker_id}/tree`.
- **In-Browser File Editor**: Reads files via `GET /api/workspaces/{worker_id}/file` and persists edits to the macOS disk via `PUT /api/workspaces/{worker_id}/file`. Non-UTF-8 files are rejected to protect binary assets.

---

### **3.4 Data Persistence Contracts**

#### **Markdown Ticket Contract (`tickets/<ticket-id>.md`)**
```markdown
---
id: ORCA-101
title: Implement Auth Middleware
status: in-progress
priority: high
assigned_worker_id: opencode-wt-2
dispatch_id: disp-99201
gap_iteration: 1
created_at: '2026-11-22T10:00:00Z'
updated_at: '2026-11-22T10:15:00Z'
---
# Objective
Implement JWT authentication middleware.

# Requirements
- Validate HS256 tokens.
- Reject expired signatures with HTTP 401.

# Context
Required for API route protection.

# Acceptance Criteria
- [ ] Unit tests pass with >90% coverage.

# Attachments
- jwt_spec.pdf

# Visualization
status: published
widget_type: MermaidDiagram

# Execution Log
- 10:05: Dispatched to worker opencode-wt-2

# Final Review
Pending final human verification signature.
```

#### **SQLite Operational Database Schema (`${WORKSPACE_ROOT}/.kanban/state.db`)**
```sql
CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    harness TEXT NOT NULL,
    model TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    current_ticket_id TEXT,
    last_heartbeat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permission_requests (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    command TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
```

---

## **4. Worker Execution, `tool.execute.before` Hook & macOS Sandbox**

### **4.1 Command Interception Flow**
1. When a harness tool attempts to execute a shell command (`bash`, `exec`), the harness hook intercepts it.
2. The hook posts `{ worker_id, ticket_id, worktree_path, command }` to `POST http://127.0.0.1:8787/api/permission-gate`.
3. The Permission Gate classifies risk:
   - **Low Risk** (read-only queries, pytest, git status): Auto-approved.
   - **Medium Risk** (package installs, migrations): Validated against ticket requirements.
   - **High Risk** (file deletions outside worktree, network egress, sudo): Placed in `pending_approval` until approved via the UI or API.
4. Approved commands are forwarded to the local Sandbox Runner at `http://127.0.0.1:9090/exec`.

---

### **4.2 Native macOS Sandbox Runner (`sandbox_runner/server.py`)**
Because this runs natively on macOS without Docker, sandboxing is strictly enforced at the runner layer:
- **Canonical Path-Jail**: Resolves `os.path.realpath` for the target `cwd`. The directory must be strictly located within `${WORKSPACE_ROOT}/workers/<worker-id>`. Any attempt to escape via `..` or external symlinks returns `403 Forbidden`.
- **Process Group Isolation**: Spawns commands in a dedicated process group (`preexec_fn=os.setsid`) allowing clean termination of runaway child processes via `os.killpg` on timeout.
- **Environment Scrubbing**: Sensitive system environment variables (`CUSTOM_LLM_API_KEY`, etc.) are stripped from the child process environment.

---

## **5. Periodic Supervision, Watchdog & Gap-Analysis**

### **5.1 Stall Watchdog (Every 3 Minutes)**
- Queries `orca worktree ps --json` and `orca orchestration worker-read`.
- Computes SHA-256 hashes of worker terminal output.
- **Soft Nudge**: 2 consecutive identical hashes trigger a soft terminal nudge (`orca terminal send`).
- **Hard Restart**: 3 consecutive unchanged cycles restart the worker process within its existing worktree without deleting code.

### **5.2 Zero-Gap Evaluator**
- When a ticket moves to `in-review`, the evaluator runs tests inside the worker's worktree.
- Checks that `kanban-viz/v2` visualization status is `published` (enforcing the mandatory no-skip policy).
- If tests fail, a structured gap report is stored in SQLite and appended to the ticket Markdown. The ticket reverts to `in-progress`.
- If `gap_iteration >= 5`, the ticket is flagged for human intervention.

### **5.3 Abstracted OrcaBridge Adapter**
`app/orca_bridge.py` abstracts all Orca CLI invocations. When `ORCA_MOCK_MODE=true` is set, an in-memory mock engine facilitates full unit and integration testing without requiring the live `orca` binary.

---

## **6. REST & WebSocket API Reference**

| Method & Path | Description | Payload / Parameters |
| :--- | :--- | :--- |
| `GET /api/board` | Fetch 6-column board state, swimlanes, tickets | Full board JSON model |
| `GET /api/workers` | List all active registered worker agents | Array of worker objects |
| `GET /api/agents/health` | Health metrics for orchestrator & workers | Component status pills & heartbeats |
| `POST /api/workers` | Register a new worker agent swimlane | `{ name, harness, model, auto_approve_tier }` |
| `POST /api/workers/{id}/action`| Manual action (nudge, resume, restart) | `{ action: "nudge" \| "resume" \| "restart" }` |
| `POST /api/objectives` | FAB (+) objective intake endpoint | `{ objective, preferred_harness, attachments }` |
| `GET /api/tickets/{id}` | Fetch parsed Markdown ticket JSON | Ticket object with sections |
| `PATCH /api/tickets/{id}` | Update status, assigned worker, gap notes | `{ status, assigned_worker_id, gap_notes }` |
| `POST /api/tickets/{id}/attachments` | Upload attachment & sync to worktree | `multipart/form-data` |
| `GET /api/workspaces/{id}/tree`| Browse worker worktree directory tree | Recursive file nodes |
| `GET /api/workspaces/{id}/file`| Read file contents from worktree | Query param `path` |
| `PUT /api/workspaces/{id}/file`| Save file contents into worktree | `{ file_path, content }` |
| `POST /api/permission-gate` | Evaluate command risk and route | `{ worker_id, ticket_id, worktree_path, command }` |
| `GET /api/permission-gate/pending` | List pending approval requests | Array of pending gate objects |
| `POST /api/permission-gate/{id}/resolve` | Approve or reject pending request | `{ decision: "approve" \| "deny" }` |
| `GET /api/tickets/{id}/visualization` | Fetch active visualization snapshot | Visualization payload |
| `PUT /api/tickets/{id}/visualization` | Save GanttChart/Mermaid (409 on SHA conflict)| `{ revision, component, tasks, source }` |
| `WS /ws/events` | Real-time event stream for UI updates | WebSocket event envelopes |

---

## **7. Mandatory A2UI v2 Visualization Engine**

Every ticket completed must publish an A2UI v2 visualization via the FastMCP tool `ticket_submit_visualization`.
- **No-Skip Policy**: Submissions with `"skipped": true` are rejected.
- **Allowed Widgets**: `GeoMap` (countries-iso3166-1), `GanttChart` (interactive ISO dates), `MermaidDiagram` (standard diagrams), `GraphicWalker` (multi-dimensional charts), and `AgGrid` (fallback tabular grid).
- **Secret Redaction**: Automatic scrubbing of API keys, passwords, and tokens before persistence to `attachments/<ticket-id>/a2ui-v1.json`.

---

## **8. macOS Local Setup & Lifecycle Management**

### **8.1 Prerequisites on macOS**
1. **Homebrew Dependencies**:
   ```bash
   brew install python@3.11 git node supervisor
   ```
2. **Python Virtual Environment**:
   ```bash
   python3.11 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
3. **Orca CLI**: Ensure `orca` binary is installed and accessible in `PATH`.
4. **LiteLLM**: Installed via `pip install litellm` within the virtual environment.

---

### **8.2 Local Process Supervision (`deploy/supervisord.conf`)**
Process management on macOS is handled via local `supervisord`:

```ini
[supervisord]
nodaemon=true
logfile=./workspace/.kanban/supervisord.log
pidfile=./workspace/.kanban/supervisord.pid

[program:orca-runtime]
command=orca serve --port 6768 --pairing-address http://127.0.0.1:6768
autostart=true
autorestart=true
priority=10
stdout_logfile=./workspace/.kanban/orca-runtime.log
stderr_logfile=./workspace/.kanban/orca-runtime.err.log

[program:llm-proxy]
command=litellm --config deploy/litellm-config.yaml --port 4000 --host 127.0.0.1
autostart=true
autorestart=true
priority=15
stdout_logfile=./workspace/.kanban/llm-proxy.log
stderr_logfile=./workspace/.kanban/llm-proxy.err.log

[program:sandbox-runner]
command=python3 -m sandbox_runner.server --port 9090
autostart=true
autorestart=true
priority=20
stdout_logfile=./workspace/.kanban/sandbox-runner.log
stderr_logfile=./workspace/.kanban/sandbox-runner.err.log

[program:kanban-control-plane]
command=uvicorn app.main:app --host 127.0.0.1 --port 8787
autostart=true
autorestart=true
priority=25
stdout_logfile=./workspace/.kanban/control-plane.log
stderr_logfile=./workspace/.kanban/control-plane.err.log

[program:watchdog-scheduler]
command=python3 -m app.watchdog --interval 180
autostart=true
autorestart=true
priority=30
stdout_logfile=./workspace/.kanban/watchdog.log
stderr_logfile=./workspace/.kanban/watchdog.err.log
```

---

## **9. Implementation Milestones & Automated Verification**

1. **Milestone 1 — Data Storage & Ticket Store**:
   - `app/config.py`: Environment settings with `.env` loader.
   - `app/models.py`: Pydantic domain models.
   - `app/store.py`: Markdown parser and SQLite schema manager.
2. **Milestone 2 — Sandbox Runner & Permission Gate**:
   - `sandbox_runner/server.py` & `jail.py`: Path-jailed command execution on macOS.
   - `app/permission_gate.py`: Risk classification and approval queue.
   - `plugins/opencode/sandbox-gate.ts`: Tool execution interception hook.
3. **Milestone 3 — OrcaBridge & Watchdog**:
   - `app/orca_bridge.py`: Orca CLI wrapper with `ORCA_MOCK_MODE`.
   - `app/watchdog.py`: Terminal output hash tracking and stall nudging.
   - `app/gap_evaluator.py`: Test runner and iterative gap reporting.
4. **Milestone 4 — Visualization Engine & MCP Server**:
   - `app/viz_validator.py`: A2UI v2 compliance validation and secret sanitization.
   - `app/mcp_server.py`: FastMCP `ticket_submit_visualization` tool.
5. **Milestone 5 — FastAPI Control Plane & WebUI**:
   - `app/main.py`: REST endpoints and `/ws/events` WebSocket broadcaster.
   - `webui/static/`: Zero-build ES Module Jira-style Kanban UI.
6. **Milestone 6 — Local macOS Deployment & Tests**:
   - `deploy/litellm-config.yaml` & `deploy/supervisord.conf`.
   - Complete `pytest` test suite covering all modules.
