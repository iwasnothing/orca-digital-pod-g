export const STATUSES = [
  "backlog",
  "to-do",
  "planning",
  "in-progress",
  "in-review",
  "done",
] as const;

export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  backlog: "Backlog",
  "to-do": "To do",
  planning: "Planning",
  "in-progress": "In progress",
  "in-review": "In review",
  done: "Done",
};

export type Priority = "low" | "medium" | "high" | "critical";
export type Harness = "pi" | "opencode" | "deepseek";
export type Risk = "low" | "medium" | "high";
export type WorkerStatus =
  | "idle"
  | "healthy"
  | "busy"
  | "pending-approval"
  | "stalled"
  | "offline";
export type WidgetType =
  | "GeoMap"
  | "GanttChart"
  | "MermaidDiagram"
  | "GraphicWalker"
  | "AgGrid";

export interface GeoHighlight {
  name: string;
  value: number;
}

export interface GanttTask {
  id: string;
  name: string;
  start: string;
  end: string;
}

export type VizPayload =
  | { widget: "GeoMap"; revision: string; highlights: GeoHighlight[] }
  | { widget: "GanttChart"; revision: string; tasks: GanttTask[] }
  | { widget: "MermaidDiagram"; revision: string; source: string }
  | {
      widget: "GraphicWalker";
      revision: string;
      title: string;
      rows: { label: string; value: number }[];
    }
  | { widget: "AgGrid"; revision: string; columns: string[]; rows: string[][] };

export interface Worker {
  id: string;
  name: string;
  harness: Harness;
  model: string;
  worktreePath: string;
  status: WorkerStatus;
  currentTicketId: string | null;
  lastHeartbeat: string;
  autoApproveTier: Risk;
}

export interface Acceptance {
  text: string;
  done: boolean;
}

export interface Attachment {
  name: string;
  content: string;
}

export interface LogLine {
  time: string;
  message: string;
}

export interface Ticket {
  id: string;
  title: string;
  status: Status;
  priority: Priority;
  assignedWorkerId: string | null;
  dispatchId: string | null;
  gapIteration: number;
  needsHuman: boolean;
  createdAt: string;
  updatedAt: string;
  objective: string;
  requirements: string[];
  context: string;
  acceptance: Acceptance[];
  attachments: Attachment[];
  viz: VizPayload | null;
  vizStatus: "none" | "draft" | "published";
  executionLog: LogLine[];
  finalReview: string;
  files: Record<string, string>;
}

export interface GateRequest {
  id: string;
  workerId: string;
  ticketId: string;
  command: string;
  riskLevel: Risk;
  status: "pending" | "approved" | "denied";
  reason: string;
  createdAt: string;
  output?: string;
  exitCode?: number;
}

export interface GapReport {
  id: string;
  ticketId: string;
  iteration: number;
  summary: string;
  unmetCriteria: string[];
  createdAt: string;
}

export interface Heartbeat {
  component: string;
  status: "healthy" | "degraded";
  details: string;
  updatedAt: string;
}

export interface PodEvent {
  id: string;
  time: string;
  kind: "dispatch" | "gate" | "gap" | "nudge" | "restart" | "viz" | "move" | "sandbox";
  message: string;
}

export interface Stall {
  output: string;
  hash: string;
  repeats: number;
}

export interface PodData {
  workers: Worker[];
  tickets: Ticket[];
  gates: GateRequest[];
  gaps: GapReport[];
  events: PodEvent[];
  heartbeats: Heartbeat[];
  stall: Record<string, Stall>;
  supervision: boolean;
}

export interface DiagramNode {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label: string;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  width: number;
  height: number;
}
