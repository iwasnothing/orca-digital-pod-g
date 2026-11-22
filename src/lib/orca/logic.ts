import type {
  Diagram,
  GapReport,
  GateRequest,
  Harness,
  PodData,
  PodEvent,
  Risk,
  Status,
  Ticket,
  VizPayload,
  WidgetType,
  Worker,
} from "./types";
import { STATUS_LABEL } from "./types";

export function stamp(iso: string): string {
  return iso.slice(11, 16);
}

export function fnv(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function revisionOf(value: unknown): string {
  return fnv(JSON.stringify(value));
}

export function stampRevision(viz: VizPayload): VizPayload {
  const rest = { ...viz, revision: "" };
  return { ...viz, revision: revisionOf(rest) };
}

const SECRET =
  /sk-[A-Za-z0-9_-]{6,}|bearer\s+[A-Za-z0-9._-]{8,}|((?:api[_-]?key|password|passwd|secret|token)\s*[:=]\s*)(\S+)/gi;

export function scrubText(input: string): { text: string; redacted: boolean } {
  let redacted = false;
  const text = input.replace(SECRET, (...args: string[]) => {
    redacted = true;
    const prefix = args[1];
    if (prefix) return `${prefix}[REDACTED]`;
    return "[REDACTED]";
  });
  return { text, redacted };
}

export function scrubValue<T>(value: T): { value: T; redacted: boolean } {
  let redacted = false;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const next = scrubText(node);
      if (next.redacted) redacted = true;
      return next.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const cleanKey = scrubText(key);
        if (cleanKey.redacted) redacted = true;
        out[cleanKey.text] = walk(child);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value) as T, redacted };
}

export function layoutMermaid(source: string): Diagram | null {
  const lines = source
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%%"));
  let vertical = false;
  const labels = new Map<string, string>();
  const edges: Diagram["edges"] = [];

  const endpoint = (raw: string): { id: string; label: string } | null => {
    const match = raw
      .trim()
      .match(/^([A-Za-z][\w-]*)\s*(?:\[\[([^\]]*)\]\]|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?$/);
    if (!match) return null;
    const id = match[1];
    if (!id) return null;
    const label = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? id).trim() || id;
    return { id, label };
  };

  for (const line of lines) {
    if (/^(flowchart|graph)\b/i.test(line)) {
      vertical = /\bTD\b|\bTB\b/i.test(line);
      continue;
    }
    if (/^(subgraph|end|direction|classDef|class |style |click |linkStyle)\b/i.test(line)) continue;
    const edge = line.match(/^(.+?)\s*(-->|---|-\.->|==>)\s*(?:\|([^|]*)\|\s*)?(.+)$/);
    if (edge?.[1] && edge[4]) {
      const from = endpoint(edge[1]);
      const to = endpoint(edge[4]);
      if (!from || !to) continue;
      labels.set(from.id, from.label);
      labels.set(to.id, to.label);
      edges.push({ from: from.id, to: to.id, label: (edge[3] ?? "").trim() });
      continue;
    }
    const only = endpoint(line);
    if (only && /[[({]/.test(line)) labels.set(only.id, only.label);
  }

  if (labels.size === 0) return null;
  const ids = [...labels.keys()];
  const depth = new Map<string, number>(ids.map((id) => [id, 0]));
  const incoming = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) adj.get(edge.from)?.push(edge.to);
  const queue = ids.filter((id) => (incoming.get(id) ?? 0) === 0);
  if (queue.length === 0 && ids[0]) queue.push(ids[0]);
  let guard = 0;
  while (queue.length && guard < 400) {
    guard += 1;
    const id = queue.shift();
    if (!id) break;
    const base = depth.get(id) ?? 0;
    for (const next of adj.get(id) ?? []) {
      const proposed = base + 1;
      if (proposed > ids.length) continue;
      if ((depth.get(next) ?? 0) < proposed) {
        depth.set(next, proposed);
        queue.push(next);
      }
    }
  }

  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const level = depth.get(id) ?? 0;
    const group = groups.get(level) ?? [];
    group.push(id);
    groups.set(level, group);
  }
  const maxDepth = Math.max(...ids.map((id) => depth.get(id) ?? 0));
  const nodeW = 132;
  const nodeH = 44;
  const gapX = 56;
  const gapY = 28;
  const nodes: Diagram["nodes"] = [];
  for (let level = 0; level <= maxDepth; level += 1) {
    const group = groups.get(level) ?? [];
    group.forEach((id, index) => {
      nodes.push({
        id,
        label: labels.get(id) ?? id,
        x: vertical ? 20 + index * (nodeW + gapX) : 20 + level * (nodeW + gapX),
        y: vertical ? 20 + level * (nodeH + gapY) : 20 + index * (nodeH + gapY),
        w: nodeW,
        h: nodeH,
      });
    });
  }
  return {
    nodes,
    edges,
    width: Math.max(...nodes.map((node) => node.x + node.w), 180) + 24,
    height: Math.max(...nodes.map((node) => node.y + node.h), 80) + 24,
  };
}

export function validateViz(viz: VizPayload): string | null {
  if (viz.widget === "GeoMap") {
    if (viz.highlights.length === 0) return "GeoMap needs at least one country";
    if (viz.highlights.some((item) => !item.name.trim() || !Number.isFinite(item.value))) {
      return "Each country needs a name and a number";
    }
    return null;
  }
  if (viz.widget === "GanttChart") {
    if (viz.tasks.length === 0) return "Gantt chart needs at least one task";
    for (const task of viz.tasks) {
      if (!task.name.trim()) return "Every task needs a name";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(task.start) || !/^\d{4}-\d{2}-\d{2}$/.test(task.end)) {
        return "Use ISO dates (YYYY-MM-DD)";
      }
      if (task.end < task.start) return `${task.name} ends before it starts`;
    }
    return null;
  }
  if (viz.widget === "MermaidDiagram") {
    if (!viz.source.trim()) return "Diagram source is empty";
    if (!layoutMermaid(viz.source)) return "Only flowchart and graph diagrams can be drawn";
    return null;
  }
  if (viz.widget === "GraphicWalker") {
    if (!viz.title.trim()) return "Chart title is required";
    if (viz.rows.length === 0) return "Add at least one measure";
    if (viz.rows.some((row) => !row.label.trim() || !Number.isFinite(row.value))) {
      return "Each row needs a label and a number";
    }
    return null;
  }
  if (viz.columns.length === 0) return "Add at least one column";
  if (viz.columns.some((column) => !column.trim())) return "Column names cannot be empty";
  if (viz.rows.some((row) => row.length !== viz.columns.length)) {
    return "Every row must match the column count";
  }
  return null;
}

export function defaultViz(widget: WidgetType, title: string): VizPayload {
  const short = title.slice(0, 28) || "Objective";
  if (widget === "GeoMap") {
    return { widget, revision: "", highlights: [{ name: "Japan", value: 4 }, { name: "Germany", value: 2 }] };
  }
  if (widget === "GanttChart") {
    return {
      widget,
      revision: "",
      tasks: [
        { id: "plan", name: "Plan", start: "2026-11-22", end: "2026-11-24" },
        { id: "build", name: short, start: "2026-11-24", end: "2026-11-28" },
      ],
    };
  }
  if (widget === "MermaidDiagram") {
    return { widget, revision: "", source: `flowchart LR\n  Brief[${short}] --> Gate[Gate]\n  Gate --> Done[Published]\n` };
  }
  if (widget === "GraphicWalker") {
    return {
      widget,
      revision: "",
      title: short,
      rows: [
        { label: "Backlog", value: 2 },
        { label: "Active", value: 3 },
        { label: "Done", value: 1 },
      ],
    };
  }
  return {
    widget,
    revision: "",
    columns: ["Check", "State"],
    rows: [
      ["Visualization", "Required"],
      ["Tests", "Open"],
    ],
  };
}

export function unmetCriteria(ticket: Ticket): string[] {
  const unmet: string[] = [];
  if (ticket.vizStatus !== "published" || !ticket.viz) {
    unmet.push("kanban-viz/v2 visualization is not published");
  }
  const tests = Object.entries(ticket.files).filter(
    ([path]) => /(^|\/)tests?\//.test(path) && /\.(py|ts|tsx|js|mjs)$/.test(path),
  );
  if (tests.length === 0) unmet.push("No test file in the worktree slice");
  else if (!tests.some(([, content]) => /\bassert\b|\bexpect\s*\(/.test(content))) {
    unmet.push("Tests do not contain an assertion");
  }
  const open = ticket.acceptance.filter((item) => !item.done);
  if (open.length) {
    unmet.push(
      `${open.length} acceptance ${open.length === 1 ? "criterion is" : "criteria are"} still open`,
    );
  }
  return unmet;
}

const HIGH =
  /\b(sudo|rm\s|rmdir|curl|wget|ssh|scp|chmod|chown|mkfs|dd\s|nc\s|ncat|kill|launchctl|docker|kubectl)\b|>\s*\/|\$\(|`/;
const MEDIUM = /\b(npm\s+install|pnpm\s+add|yarn\s+add|pip3?\s+install|uv\s+add|brew\s+install|migrate|alembic|npm\s+ci)\b/;
const LOW =
  /^\s*(git\s+(status|diff|log|show|rev-parse)|ls|pwd|cat|head|tail|wc|rg|grep|find|pytest|python3?\s+-m\s+pytest|npm\s+test|echo|true|false|which|file)\b/;

export function jailViolation(command: string): string | null {
  if (command.includes("../")) return "Path escape via .. is jailed";
  if (/(^|\s)~(\/|\s|$)/.test(command)) return "Home expansion leaves the worktree jail";
  if (/(^|\s)\/(etc|usr|var|private|System|bin|sbin|root)\b/.test(command)) {
    return "Absolute path outside the worktree is jailed";
  }
  return null;
}

export function classifyCommand(
  command: string,
  ticket: Ticket,
  tier: Risk,
): { risk: Risk; pending: boolean; reason: string } {
  const cmd = command.trim();
  if (!cmd) return { risk: "low", pending: true, reason: "Command is empty" };
  const jail = jailViolation(cmd);
  if (jail) return { risk: "high", pending: true, reason: jail };
  let risk: Risk = "medium";
  if (HIGH.test(cmd)) risk = "high";
  else if (MEDIUM.test(cmd)) risk = "medium";
  else if (LOW.test(cmd)) risk = "low";
  if (risk === "high") return { risk, pending: true, reason: "High-risk command waits for a person" };
  const rank: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
  if (rank[risk] <= rank[tier]) {
    return {
      risk,
      pending: false,
      reason: risk === "low" ? "Read-only command auto-approved" : "Inside this worker's auto-approve tier",
    };
  }
  if (risk === "low") return { risk, pending: false, reason: "Read-only command auto-approved" };
  const blob = `${ticket.title}\n${ticket.objective}\n${ticket.requirements.join("\n")}`.toLowerCase();
  if (/install|migrat|dependency|package/.test(blob) && /install|migrat/.test(cmd.toLowerCase())) {
    return { risk, pending: false, reason: "Command matches the ticket requirements" };
  }
  return { risk, pending: true, reason: "Medium risk is not covered by the ticket" };
}

export function sandboxRun(
  command: string,
  ticket: Ticket,
  worktree: string,
): { code: number; output: string } {
  const cmd = command.trim();
  const jail = jailViolation(cmd);
  if (jail) return { code: 403, output: `${jail}. Runner returned 403.` };
  if (/\b(env|printenv)\b/.test(cmd)) {
    return { code: 0, output: "PATH, HOME, LANG\n(CUSTOM_LLM_API_KEY and harness tokens stripped)" };
  }
  if (/pytest|npm\s+test/.test(cmd)) {
    const ok = Object.entries(ticket.files).some(
      ([path, content]) => /test/.test(path) && /\bassert\b|\bexpect\s*\(/.test(content),
    );
    return ok
      ? { code: 0, output: `cwd ${worktree}\n1 passed` }
      : { code: 1, output: `cwd ${worktree}\n1 failed — assertion missing` };
  }
  if (/^ls\b/.test(cmd)) {
    const names = Object.keys(ticket.files);
    return { code: 0, output: names.length ? names.join("\n") : "(empty worktree slice)" };
  }
  const cat = cmd.match(/^cat\s+(\S+)/);
  if (cat?.[1]) {
    const hit = ticket.files[cat[1]];
    if (hit == null) return { code: 1, output: `cat: ${cat[1]}: No such file` };
    return { code: 0, output: hit.slice(0, 800) };
  }
  if (/^git\s+status\b/.test(cmd)) return { code: 0, output: `On branch ${worktree}\nnothing to commit` };
  return { code: 0, output: `sandbox ok\ncwd ${worktree}\n$ ${cmd}` };
}

const BINARY = /\.(png|jpe?g|gif|webp|pdf|zip|wasm|bin|exe|dylib|so)$/i;

export function fileRejection(path: string, content: string): string | null {
  if (!path.trim()) return "Path is required";
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    return "Path must stay inside the worktree slice";
  }
  if (BINARY.test(path)) return "Binary files are rejected";
  if (content.includes("\u0000")) return "Non-UTF-8 content is rejected";
  if (content.length > 80_000) return "File is too large for the in-browser editor";
  return null;
}

export function toMarkdown(ticket: Ticket): string {
  const vizLine = ticket.viz
    ? `status: ${ticket.vizStatus}\nwidget_type: ${ticket.viz.widget}`
    : "status: none";
  const checks = ticket.acceptance
    .map((item) => `- [${item.done ? "x" : " "}] ${item.text}`)
    .join("\n");
  const log = ticket.executionLog.map((line) => `- ${line.time}: ${line.message}`).join("\n");
  return `---
id: ${ticket.id}
title: ${ticket.title}
status: ${ticket.status}
priority: ${ticket.priority}
assigned_worker_id: ${ticket.assignedWorkerId ?? ""}
dispatch_id: ${ticket.dispatchId ?? ""}
gap_iteration: ${ticket.gapIteration}
created_at: '${ticket.createdAt}'
updated_at: '${ticket.updatedAt}'
---
# Objective
${ticket.objective}

# Requirements
${ticket.requirements.map((item) => `- ${item}`).join("\n")}

# Context
${ticket.context}

# Acceptance Criteria
${checks || "- [ ] Define acceptance"}

# Attachments
${ticket.attachments.map((item) => `- ${item.name}`).join("\n") || "- none"}

# Visualization
${vizLine}

# Execution Log
${log || "- quiet"}

# Final Review
${ticket.finalReview}
`;
}

export interface ObjectiveSlice {
  title: string;
  objective: string;
  requirements: string[];
  context: string;
  acceptance: string[];
  phase: Status;
}

export function decomposeObjective(objective: string): ObjectiveSlice[] {
  const lines = objective
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bullets = lines.filter((line) => /^[-*]\s+/.test(line)).map((line) => line.replace(/^[-*]\s+/, ""));
  const proseLines = lines.filter((line) => !/^[-*]\s+/.test(line));
  const prose = proseLines.join(" ");
  const titleBase = (proseLines[0] || bullets[0] || "Untitled objective").replace(/\.$/, "");
  const title = titleBase.length > 78 ? `${titleBase.slice(0, 75)}…` : titleBase;
  const context = prose || "Dispatched from pod intake.";
  if (bullets.length >= 2) {
    return [
      {
        title: `Plan · ${title}`,
        objective: prose || title,
        requirements: ["Break the objective into a testable plan", bullets[0] ?? title],
        context,
        acceptance: ["Plan lists the acceptance checks", "Worktree contains a test scaffold"],
        phase: "planning",
      },
      {
        title: `Build · ${title}`,
        objective: prose || title,
        requirements: bullets,
        context,
        acceptance: bullets.map((bullet) => `Done: ${bullet}`),
        phase: "to-do",
      },
      {
        title: `Verify · ${title}`,
        objective: "Close the zero-gap loop and publish kanban-viz/v2.",
        requirements: ["Publish a visualization", "Assertions pass inside the worktree"],
        context,
        acceptance: ["Visualization status is published", "Gap evaluator reports zero unmet criteria"],
        phase: "backlog",
      },
    ];
  }
  return [
    {
      title,
      objective: prose || title,
      requirements: bullets.length ? bullets : ["Satisfy the stated objective", "Publish a kanban-viz/v2 widget"],
      context,
      acceptance: ["Worktree tests assert the behavior", "A kanban-viz/v2 widget is published"],
      phase: "planning",
    },
  ];
}

export function scaffoldFiles(title: string, requirements: string[]): Record<string, string> {
  return {
    "README.md": `# ${title}\n\n${requirements.map((item) => `- ${item}`).join("\n")}\n`,
    "src/main.py": `"""${title}"""\n\ndef run() -> None:\n    raise NotImplementedError\n`,
    "tests/test_main.py":
      "def test_objective():\n    # Assertion intentionally absent until the gap closes.\n    run = None\n",
  };
}

export function pickWorker(workers: Worker[], tickets: Ticket[], harness: Harness): Worker | null {
  const pool = workers.filter((worker) => worker.harness === harness && worker.status !== "offline");
  if (pool.length === 0) return null;
  const load = (id: string) =>
    tickets.filter((ticket) => ticket.assignedWorkerId === id && ticket.status !== "done").length;
  return [...pool].sort((a, b) => load(a.id) - load(b.id) || a.id.localeCompare(b.id))[0] ?? null;
}

export function nextTicketNumber(tickets: Ticket[]): number {
  return (
    tickets.reduce((max, ticket) => {
      const value = Number(ticket.id.replace(/\D/g, ""));
      return Number.isFinite(value) ? Math.max(max, value) : max;
    }, 100) + 1
  );
}

function replaceTicket(tickets: Ticket[], ticket: Ticket): Ticket[] {
  return tickets.map((item) => (item.id === ticket.id ? ticket : item));
}

function pushEvent(events: PodEvent[], event: PodEvent): PodEvent[] {
  return [event, ...events].slice(0, 48);
}

export function recomputeWorkers(workers: Worker[], tickets: Ticket[]): Worker[] {
  return workers.map((worker) => {
    const running = tickets.find(
      (ticket) =>
        ticket.assignedWorkerId === worker.id &&
        (ticket.status === "in-progress" || ticket.status === "in-review"),
    );
    const planning = tickets.find(
      (ticket) => ticket.assignedWorkerId === worker.id && ticket.status === "planning",
    );
    const currentTicketId = running?.id ?? planning?.id ?? null;
    let status = worker.status;
    if (status !== "offline" && status !== "stalled" && status !== "pending-approval") {
      status = running ? "busy" : "healthy";
    }
    return { ...worker, currentTicketId, status };
  });
}

export interface ActionResult {
  data: PodData;
  ok: boolean;
  gap: boolean;
  message: string;
  ticketId?: string;
  redacted?: boolean;
  conflict?: boolean;
  viz?: VizPayload;
}

function ok(data: PodData, message: string, extra?: Partial<ActionResult>): ActionResult {
  return { data, ok: true, gap: false, message, ...extra };
}

function fail(data: PodData, message: string, extra?: Partial<ActionResult>): ActionResult {
  return { data, ok: false, gap: false, message, ...extra };
}

export function moveTicket(
  data: PodData,
  ticketId: string,
  status: Status,
  workerId: string | null | undefined,
  now: string,
  id: () => string,
  forceGrade = false,
): ActionResult {
  const current = data.tickets.find((ticket) => ticket.id === ticketId);
  if (!current) return fail(data, "Ticket is missing");
  let next: Ticket = {
    ...current,
    updatedAt: now,
    executionLog: [...current.executionLog],
    acceptance: current.acceptance.map((item) => ({ ...item })),
    attachments: [...current.attachments],
    files: { ...current.files },
  };
  if (workerId !== undefined) next.assignedWorkerId = workerId;
  const graded = forceGrade || ((status === "in-review" || status === "done") && status !== current.status);
  if (!graded) {
    next.status = status;
    next.executionLog.push({ time: stamp(now), message: `Moved to ${STATUS_LABEL[status]}` });
    const tickets = replaceTicket(data.tickets, next);
    return ok(
      {
        ...data,
        tickets,
        workers: recomputeWorkers(data.workers, tickets),
        events: pushEvent(data.events, {
          id: id(),
          time: now,
          kind: "move",
          message: `${next.id} moved to ${STATUS_LABEL[status]}`,
        }),
      },
      `${next.id} is in ${STATUS_LABEL[status]}`,
      { ticketId: next.id },
    );
  }
  const unmet = unmetCriteria(next);
  if (unmet.length === 0) {
    next.status = "done";
    next.needsHuman = false;
    next.finalReview = "Zero-gap verification passed. Visualization is published.";
    next.executionLog.push({ time: stamp(now), message: "Zero-gap passed. Moved to done." });
    const tickets = replaceTicket(data.tickets, next);
    return ok(
      {
        ...data,
        tickets,
        workers: recomputeWorkers(data.workers, tickets),
        events: pushEvent(data.events, {
          id: id(),
          time: now,
          kind: "gap",
          message: `${next.id} passed zero-gap verification`,
        }),
      },
      "Zero gaps. The ticket is done.",
      { ticketId: next.id, gap: true },
    );
  }
  const iteration = next.gapIteration + 1;
  next.gapIteration = iteration;
  next.needsHuman = iteration >= 5;
  next.status = "in-progress";
  next.finalReview = next.needsHuman
    ? "Flagged for human intervention after 5 gap iterations."
    : "Returned to the worker with a gap report.";
  next.executionLog.push({ time: stamp(now), message: `Gap iteration ${iteration}: ${unmet[0]}` });
  const report: GapReport = {
    id: id(),
    ticketId: next.id,
    iteration,
    summary: unmet[0] ?? "Gap",
    unmetCriteria: unmet,
    createdAt: now,
  };
  const tickets = replaceTicket(data.tickets, next);
  const message = next.needsHuman
    ? "Five gap iterations. A person has to take this ticket."
    : `Gap found: ${unmet[0]}`;
  return {
    data: {
      ...data,
      tickets,
      gaps: [report, ...data.gaps],
      workers: recomputeWorkers(data.workers, tickets),
      events: pushEvent(data.events, {
        id: id(),
        time: now,
        kind: "gap",
        message: `${next.id} returned to in progress — ${unmet.length} unmet`,
      }),
    },
    ok: false,
    gap: true,
    message,
    ticketId: next.id,
  };
}

export function toggleAcceptance(data: PodData, ticketId: string, index: number, now: string): PodData {
  const tickets = data.tickets.map((ticket) => {
    if (ticket.id !== ticketId) return ticket;
    return {
      ...ticket,
      updatedAt: now,
      acceptance: ticket.acceptance.map((item, itemIndex) =>
        itemIndex === index ? { ...item, done: !item.done } : item,
      ),
    };
  });
  return { ...data, tickets };
}

export function saveFile(
  data: PodData,
  ticketId: string,
  path: string,
  content: string,
  now: string,
): ActionResult {
  const ticket = data.tickets.find((item) => item.id === ticketId);
  if (!ticket) return fail(data, "Ticket is missing");
  const rejection = fileRejection(path, content);
  if (rejection) return fail(data, rejection);
  const next: Ticket = {
    ...ticket,
    updatedAt: now,
    files: { ...ticket.files, [path]: content },
    executionLog: [...ticket.executionLog, { time: stamp(now), message: `Saved ${path}` }],
  };
  const tickets = replaceTicket(data.tickets, next);
  return ok({ ...data, tickets }, `Saved ${path}`, { ticketId });
}

export function submitCommand(
  data: PodData,
  ticketId: string,
  command: string,
  now: string,
  id: () => string,
): ActionResult {
  const ticket = data.tickets.find((item) => item.id === ticketId);
  if (!ticket) return fail(data, "Ticket is missing");
  if (!ticket.assignedWorkerId) return fail(data, "Assign a worker before running a command");
  const worker = data.workers.find((item) => item.id === ticket.assignedWorkerId);
  if (!worker) return fail(data, "Assigned worker is gone");
  const decision = classifyCommand(command, ticket, worker.autoApproveTier);
  if (!decision.pending) {
    const run = sandboxRun(command, ticket, worker.worktreePath);
    const gate: GateRequest = {
      id: id(),
      workerId: worker.id,
      ticketId: ticket.id,
      command: command.trim(),
      riskLevel: decision.risk,
      status: "approved",
      reason: decision.reason,
      createdAt: now,
      output: run.output,
      exitCode: run.code,
    };
    const tickets = replaceTicket(data.tickets, {
      ...ticket,
      updatedAt: now,
      executionLog: [
        ...ticket.executionLog,
        { time: stamp(now), message: `Sandbox ${run.code}: ${command.trim()}` },
      ],
    });
    return ok(
      {
        ...data,
        tickets,
        gates: [gate, ...data.gates],
        events: pushEvent(data.events, {
          id: id(),
          time: now,
          kind: "sandbox",
          message: `${worker.name} ran “${command.trim()}” (${run.code})`,
        }),
      },
      run.code === 0 ? "Auto-approved and executed" : `Sandbox returned ${run.code}`,
      { ticketId },
    );
  }
  const gate: GateRequest = {
    id: id(),
    workerId: worker.id,
    ticketId: ticket.id,
    command: command.trim(),
    riskLevel: decision.risk,
    status: "pending",
    reason: decision.reason,
    createdAt: now,
  };
  const tickets = replaceTicket(data.tickets, {
    ...ticket,
    updatedAt: now,
    executionLog: [...ticket.executionLog, { time: stamp(now), message: `Gate held: ${command.trim()}` }],
  });
  return fail(
    {
      ...data,
      tickets,
      gates: [gate, ...data.gates],
      events: pushEvent(data.events, {
        id: id(),
        time: now,
        kind: "gate",
        message: `${worker.name} waiting on approval for “${command.trim()}”`,
      }),
    },
    decision.reason,
    { ticketId },
  );
}

export function resolveGate(
  data: PodData,
  gateId: string,
  decision: "approve" | "deny",
  now: string,
  id: () => string,
): ActionResult {
  const gate = data.gates.find((item) => item.id === gateId);
  if (!gate || gate.status !== "pending") return fail(data, "That request is no longer pending");
  const ticket = data.tickets.find((item) => item.id === gate.ticketId);
  const worker = data.workers.find((item) => item.id === gate.workerId);
  if (!ticket || !worker) return fail(data, "Ticket or worker is missing");
  if (decision === "deny") {
    const gates = data.gates.map((item) =>
      item.id === gateId ? { ...item, status: "denied" as const, output: "Denied by operator", exitCode: 1 } : item,
    );
    const tickets = replaceTicket(data.tickets, {
      ...ticket,
      updatedAt: now,
      executionLog: [...ticket.executionLog, { time: stamp(now), message: `Denied: ${gate.command}` }],
    });
    return ok(
      {
        ...data,
        gates,
        tickets,
        events: pushEvent(data.events, {
          id: id(),
          time: now,
          kind: "gate",
          message: `Denied ${gate.command} for ${worker.name}`,
        }),
      },
      "Command denied",
      { ticketId: ticket.id },
    );
  }
  const run = sandboxRun(gate.command, ticket, worker.worktreePath);
  const gates = data.gates.map((item) =>
    item.id === gateId ? { ...item, status: "approved" as const, output: run.output, exitCode: run.code } : item,
  );
  const tickets = replaceTicket(data.tickets, {
    ...ticket,
    updatedAt: now,
    executionLog: [
      ...ticket.executionLog,
      { time: stamp(now), message: `Approved sandbox ${run.code}: ${gate.command}` },
    ],
  });
  return ok(
    {
      ...data,
      gates,
      tickets,
      events: pushEvent(data.events, {
        id: id(),
        time: now,
        kind: "sandbox",
        message: `${worker.name} executed after approval (${run.code})`,
      }),
    },
    run.code === 403 ? "Approved, then the jail returned 403" : `Approved. Sandbox exit ${run.code}`,
    { ticketId: ticket.id },
  );
}

export function publishViz(
  data: PodData,
  ticketId: string,
  draft: VizPayload,
  baseRevision: string,
  skipped: boolean,
  now: string,
  id: () => string,
): ActionResult {
  const ticket = data.tickets.find((item) => item.id === ticketId);
  if (!ticket) return fail(data, "Ticket is missing");
  if (skipped) return fail(data, "No-skip policy: a visualization cannot be skipped");
  if (baseRevision === "conflict" || (ticket.viz != null && baseRevision !== ticket.viz.revision)) {
    return fail(data, "Revision conflict. Load the published snapshot and try again.", { conflict: true });
  }
  const scrubbed = scrubValue(draft);
  const candidate = stampRevision(scrubbed.value);
  const problem = validateViz(candidate);
  if (problem) return fail(data, problem, { redacted: scrubbed.redacted });
  const attachment = {
    name: "a2ui-v1.json",
    content: JSON.stringify(candidate, null, 2),
  };
  const attachments = [
    attachment,
    ...ticket.attachments.filter((item) => item.name !== "a2ui-v1.json"),
  ];
  const next: Ticket = {
    ...ticket,
    updatedAt: now,
    viz: candidate,
    vizStatus: "published",
    attachments,
    executionLog: [
      ...ticket.executionLog,
      { time: stamp(now), message: `Published ${candidate.widget} rev ${candidate.revision}` },
    ],
  };
  const tickets = replaceTicket(data.tickets, next);
  return ok(
    {
      ...data,
      tickets,
      events: pushEvent(data.events, {
        id: id(),
        time: now,
        kind: "viz",
        message: `${ticket.id} published ${candidate.widget}`,
      }),
    },
    scrubbed.redacted ? "Published. A secret was redacted first." : `Published ${candidate.widget}`,
    { ticketId, redacted: scrubbed.redacted, viz: candidate },
  );
}

export function intakeObjective(
  data: PodData,
  input: { objective: string; harness: Harness; attachment?: { name: string; content: string } | null },
  now: string,
  id: () => string,
): ActionResult {
  const objective = input.objective.trim();
  if (objective.length < 3) return fail(data, "Describe the objective first");
  if (input.attachment) {
    const rejection = fileRejection(input.attachment.name, input.attachment.content);
    if (rejection) return fail(data, rejection);
  }
  const slices = decomposeObjective(objective);
  const worker = pickWorker(data.workers, data.tickets, input.harness);
  let number = nextTicketNumber(data.tickets);
  const created: Ticket[] = slices.map((slice, index) => {
    const ticketId = `ORCA-${number}`;
    number += 1;
    const assigned = worker ? worker.id : null;
    return {
      id: ticketId,
      title: slice.title,
      status: assigned ? slice.phase : "backlog",
      priority: index === 0 ? "high" : "medium",
      assignedWorkerId: assigned,
      dispatchId: `disp-${ticketId.slice(5)}`,
      gapIteration: 0,
      needsHuman: false,
      createdAt: now,
      updatedAt: now,
      objective: slice.objective,
      requirements: slice.requirements,
      context: slice.context,
      acceptance: slice.acceptance.map((text) => ({ text, done: false })),
      attachments: index === 0 && input.attachment ? [input.attachment] : [],
      viz: null,
      vizStatus: "none",
      executionLog: [
        {
          time: stamp(now),
          message: assigned ? `Dispatched to ${worker?.name}` : "Staged in backlog — no worker for that harness",
        },
      ],
      finalReview: "Pending final verification.",
      files: scaffoldFiles(slice.title, slice.requirements),
    };
  });
  const tickets = [...created, ...data.tickets];
  const message = worker
    ? `Superagent opened ${created.length} ticket${created.length === 1 ? "" : "s"} on ${worker.name}`
    : "No worker for that harness. Tickets are in the backlog.";
  return ok(
    {
      ...data,
      tickets,
      workers: recomputeWorkers(data.workers, tickets),
      events: pushEvent(data.events, {
        id: id(),
        time: now,
        kind: "dispatch",
        message,
      }),
    },
    message,
    { ticketId: created[0]?.id },
  );
}

export function workerAction(
  data: PodData,
  workerId: string,
  action: "nudge" | "resume" | "restart",
  now: string,
  id: () => string,
): ActionResult {
  const worker = data.workers.find((item) => item.id === workerId);
  if (!worker) return fail(data, "Worker is missing");
  const stall = { ...data.stall };
  let workers = data.workers;
  let tickets = data.tickets;
  let message = "";
  let kind: PodEvent["kind"] = "nudge";
  if (action === "nudge") {
    message = `Soft nudge sent to ${worker.name}`;
    tickets = data.tickets.map((ticket) =>
      ticket.id === worker.currentTicketId
        ? {
            ...ticket,
            updatedAt: now,
            executionLog: [...ticket.executionLog, { time: stamp(now), message: "Operator nudged the terminal" }],
          }
        : ticket,
    );
  } else if (action === "resume") {
    const fresh = `resumed ${now} ${worker.id}`;
    stall[worker.id] = { output: fresh, hash: fnv(fresh), repeats: 0 };
    workers = data.workers.map((item) =>
      item.id === worker.id ? { ...item, status: "healthy", lastHeartbeat: now } : item,
    );
    message = `${worker.name} resumed`;
    kind = "restart";
  } else {
    const fresh = `restarted ${now} ${worker.id}`;
    stall[worker.id] = { output: fresh, hash: fnv(fresh), repeats: 0 };
    workers = data.workers.map((item) =>
      item.id === worker.id ? { ...item, status: "healthy", lastHeartbeat: now } : item,
    );
    tickets = data.tickets.map((ticket) =>
      ticket.id === worker.currentTicketId
        ? {
            ...ticket,
            updatedAt: now,
            executionLog: [
              ...ticket.executionLog,
              { time: stamp(now), message: "Worker restarted in place. Worktree kept." },
            ],
          }
        : ticket,
    );
    message = `${worker.name} restarted in its worktree`;
    kind = "restart";
  }
  workers = recomputeWorkers(workers, tickets);
  return ok(
    {
      ...data,
      workers,
      tickets,
      stall,
      events: pushEvent(data.events, { id: id(), time: now, kind, message }),
    },
    message,
  );
}

export function registerWorker(
  data: PodData,
  input: { name: string; harness: Harness; model: string; autoApproveTier: Risk },
  now: string,
  id: () => string,
): ActionResult {
  const name = input.name.trim();
  const model = input.model.trim();
  if (name.length < 2) return fail(data, "Name the worker");
  if (!model) return fail(data, "Model is required");
  const serial = data.workers.filter((worker) => worker.harness === input.harness).length + 1;
  const workerId = `${input.harness}-wt-${serial}`;
  const taken = data.workers.some((worker) => worker.id === workerId);
  const finalId = taken ? `${workerId}-${id().slice(-4)}` : workerId;
  const worker: Worker = {
    id: finalId,
    name,
    harness: input.harness,
    model,
    worktreePath: `workspace/workers/${finalId}`,
    status: "healthy",
    currentTicketId: null,
    lastHeartbeat: now,
    autoApproveTier: input.autoApproveTier,
  };
  const fresh = `boot ${now}`;
  return ok(
    {
      ...data,
      workers: [...data.workers, worker],
      stall: { ...data.stall, [finalId]: { output: fresh, hash: fnv(fresh), repeats: 0 } },
      events: pushEvent(data.events, {
        id: id(),
        time: now,
        kind: "dispatch",
        message: `${name} joined the ${input.harness} swimlane`,
      }),
    },
    `${name} is on the board`,
  );
}

export function tickWatchdog(data: PodData, now: string, id: () => string): PodData {
  let workers = data.workers.map((worker) => ({ ...worker, lastHeartbeat: now }));
  let tickets = data.tickets;
  const stall = { ...data.stall };
  let events = data.events;
  for (const worker of [...workers]) {
    const prev = stall[worker.id] ?? { output: "boot", hash: fnv("boot"), repeats: 0 };
    const frozen = worker.status === "stalled" || prev.repeats > 0;
    const output = frozen ? prev.output : `${worker.id} ${now}`;
    const hash = fnv(output);
    const repeats = hash === prev.hash ? prev.repeats + 1 : 0;
    if (repeats >= 3) {
      const fresh = `restarted ${now} ${worker.id}`;
      stall[worker.id] = { output: fresh, hash: fnv(fresh), repeats: 0 };
      workers = workers.map((item) =>
        item.id === worker.id ? { ...item, status: "healthy", lastHeartbeat: now } : item,
      );
      tickets = tickets.map((ticket) =>
        ticket.id === worker.currentTicketId
          ? {
              ...ticket,
              executionLog: [
                ...ticket.executionLog,
                { time: stamp(now), message: "Watchdog restarted the worker. Code was kept." },
              ],
            }
          : ticket,
      );
      events = pushEvent(events, {
        id: id(),
        time: now,
        kind: "restart",
        message: `Watchdog restarted ${worker.name} after 3 unchanged cycles`,
      });
    } else {
      stall[worker.id] = { output, hash, repeats };
      if (repeats >= 2) {
        workers = workers.map((item) =>
          item.id === worker.id ? { ...item, status: "stalled", lastHeartbeat: now } : item,
        );
      }
      if (repeats === 2) {
        tickets = tickets.map((ticket) =>
          ticket.id === worker.currentTicketId
            ? {
                ...ticket,
                executionLog: [
                  ...ticket.executionLog,
                  { time: stamp(now), message: "Watchdog soft nudge — terminal output unchanged." },
                ],
              }
            : ticket,
        );
        events = pushEvent(events, {
          id: id(),
          time: now,
          kind: "nudge",
          message: `Soft nudge sent to ${worker.name}`,
        });
      }
    }
  }
  workers = recomputeWorkers(workers, tickets);
  // recompute would clear stalled if we don't preserve it. Restore stall flags.
  workers = workers.map((worker) => {
    const cycles = stall[worker.id]?.repeats ?? 0;
    if (cycles >= 2 && worker.status !== "offline") return { ...worker, status: "stalled" };
    return worker;
  });
  const heartbeats = data.heartbeats.map((beat) => ({
    ...beat,
    updatedAt: now,
    status: "healthy" as const,
    details: beat.component === "Watchdog" ? "Cycle complete" : beat.details,
  }));
  return { ...data, workers, tickets, stall, events, heartbeats };
}

export function pendingCount(data: PodData): number {
  return data.gates.filter((gate) => gate.status === "pending").length;
}

export const COUNTRY_CHOICES = [
  "United States of America",
  "Canada",
  "Mexico",
  "Brazil",
  "United Kingdom",
  "France",
  "Germany",
  "Sweden",
  "Japan",
  "China",
  "India",
  "Australia",
] as const;

export const WIDGETS: WidgetType[] = [
  "MermaidDiagram",
  "GanttChart",
  "GeoMap",
  "GraphicWalker",
  "AgGrid",
];

export const WIDGET_LABEL: Record<WidgetType, string> = {
  MermaidDiagram: "Mermaid",
  GanttChart: "Gantt",
  GeoMap: "Geo map",
  GraphicWalker: "Graphic walker",
  AgGrid: "Grid",
};
