import { create } from "zustand";
import * as api from "./api";
import type { ApiResult } from "./api";
import type { Harness, PodData, Risk, Status, VizPayload } from "./types";

const empty: PodData = {
  workers: [],
  tickets: [],
  gates: [],
  gaps: [],
  events: [],
  heartbeats: [],
  stall: {},
  supervision: true,
};

export type ActionResult = ApiResult;

export interface PodStore extends PodData {
  connected: boolean;
  error: string | null;
  applyBoard: (board: PodData) => void;
  refresh: () => Promise<void>;
  connect: () => () => void;
  intake: (input: {
    objective: string;
    harness: Harness;
    attachment?: { name: string; content: string } | null;
  }) => Promise<ActionResult>;
  moveTicket: (ticketId: string, status: Status, workerId?: string | null, _forceGrade?: boolean) => Promise<ActionResult>;
  toggleAcceptance: (ticketId: string, index: number) => Promise<void>;
  saveFile: (ticketId: string, path: string, content: string) => Promise<ActionResult>;
  submitCommand: (ticketId: string, command: string) => Promise<ActionResult>;
  resolveGate: (gateId: string, decision: "approve" | "deny") => Promise<ActionResult>;
  publishViz: (ticketId: string, draft: VizPayload, baseRevision: string, skipped: boolean) => Promise<ActionResult>;
  workerAction: (workerId: string, action: "nudge" | "resume" | "restart") => Promise<ActionResult>;
  registerWorker: (input: { name: string; harness: Harness; model: string; autoApproveTier: Risk }) => Promise<ActionResult>;
  tickWatchdog: () => Promise<void>;
  setSupervision: (on: boolean) => Promise<void>;
  reset: () => Promise<void>;
}

function fail(err: unknown): ActionResult {
  return { ok: false, message: err instanceof Error ? err.message : String(err) };
}

export const usePod = create<PodStore>()((set, get) => ({
  ...empty,
  connected: false,
  error: null,
  applyBoard: (board) => set({ ...board, connected: true, error: null }),
  refresh: async () => {
    try {
      const board = await api.getBoard();
      get().applyBoard(board);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), connected: false });
    }
  },
  connect: () => {
    void get().refresh();
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/events`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type?: string; payload?: PodData };
        if (msg.type === "board" && msg.payload) get().applyBoard(msg.payload);
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => set({ error: "Live updates disconnected; polling" });
    const poll = window.setInterval(() => void get().refresh(), 8000);
    return () => {
      ws.close();
      window.clearInterval(poll);
    };
  },
  intake: async (input) => {
    try {
      const result = await api.intake(input);
      await get().refresh();
      return result;
    } catch (err) {
      return fail(err);
    }
  },
  moveTicket: async (ticketId, status, workerId) => {
    try {
      const result = await api.patchTicket(ticketId, { status, assignedWorkerId: workerId });
      await get().refresh();
      return result;
    } catch (err) {
      return fail(err);
    }
  },
  toggleAcceptance: async (ticketId, index) => {
    try {
      await api.patchTicket(ticketId, { acceptanceIndex: index });
      await get().refresh();
    } catch {
      /* ignore */
    }
  },
  saveFile: async (ticketId, path, content) => {
    const ticket = get().tickets.find((item) => item.id === ticketId);
    const workerId = ticket?.assignedWorkerId;
    if (!workerId) return { ok: false, message: "Ticket has no assigned worker" };
    try {
      const result = await api.saveWorkspaceFile(workerId, path, content);
      await get().refresh();
      return result;
    } catch (err) {
      return fail(err);
    }
  },
  submitCommand: async (ticketId, command) => {
    const ticket = get().tickets.find((item) => item.id === ticketId);
    const worker = get().workers.find((item) => item.id === ticket?.assignedWorkerId);
    if (!ticket || !worker) return { ok: false, message: "Assign a worker first" };
    try {
      const result = await api.submitCommand(worker.id, ticket.id, worker.worktreePath, command);
      await get().refresh();
      return result;
    } catch (err) {
      return fail(err);
    }
  },
  resolveGate: async (gateId, decision) => {
    try {
      const result = await api.resolveGate(gateId, decision);
      await get().refresh();
      return result;
    } catch (err) {
      return fail(err);
    }
  },
  publishViz: async (ticketId, draft, baseRevision, skipped) => {
    try {
      const result = await api.publishViz(ticketId, draft, baseRevision, skipped);
      await get().refresh();
      return result;
    } catch (err) {
      return fail(err);
    }
  },
  workerAction: async (workerId, action) => {
    try {
      const result = await api.workerAction(workerId, action);
      await get().refresh();
      return result;
    } catch (err) {
      return fail(err);
    }
  },
  registerWorker: async (input) => {
    try {
      const result = await api.createWorker(input);
      await get().refresh();
      return result;
    } catch (err) {
      return fail(err);
    }
  },
  tickWatchdog: async () => {
    try {
      await api.tickWatchdog();
      await get().refresh();
    } catch {
      /* ignore */
    }
  },
  setSupervision: async (on) => {
    try {
      await api.setSupervision(on);
      await get().refresh();
    } catch {
      set({ supervision: on });
    }
  },
  reset: async () => {
    await get().refresh();
  },
}));
