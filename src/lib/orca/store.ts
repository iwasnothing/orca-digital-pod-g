import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  intakeObjective,
  moveTicket,
  publishViz,
  registerWorker,
  resolveGate,
  saveFile,
  submitCommand,
  tickWatchdog,
  toggleAcceptance,
  workerAction,
  type ActionResult,
} from "./logic";
import { createInitial } from "./seed";
import type { Harness, PodData, Risk, Status, VizPayload } from "./types";

let seq = 0;
function nid(): string {
  seq += 1;
  return `id-${Date.now().toString(36)}-${seq}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface PodStore extends PodData {
  intake: (input: {
    objective: string;
    harness: Harness;
    attachment?: { name: string; content: string } | null;
  }) => ActionResult;
  moveTicket: (ticketId: string, status: Status, workerId?: string | null, forceGrade?: boolean) => ActionResult;
  toggleAcceptance: (ticketId: string, index: number) => void;
  saveFile: (ticketId: string, path: string, content: string) => ActionResult;
  submitCommand: (ticketId: string, command: string) => ActionResult;
  resolveGate: (gateId: string, decision: "approve" | "deny") => ActionResult;
  publishViz: (ticketId: string, draft: VizPayload, baseRevision: string, skipped: boolean) => ActionResult;
  workerAction: (workerId: string, action: "nudge" | "resume" | "restart") => ActionResult;
  registerWorker: (input: { name: string; harness: Harness; model: string; autoApproveTier: Risk }) => ActionResult;
  tickWatchdog: () => void;
  setSupervision: (on: boolean) => void;
  reset: () => void;
}

function dataOf(state: PodStore): PodData {
  return {
    workers: state.workers,
    tickets: state.tickets,
    gates: state.gates,
    gaps: state.gaps,
    events: state.events,
    heartbeats: state.heartbeats,
    stall: state.stall,
    supervision: state.supervision,
  };
}

function apply(set: (partial: Partial<PodStore>) => void, get: () => PodStore, result: ActionResult): ActionResult {
  set(result.data);
  return result;
}

export const usePod = create<PodStore>()(
  persist(
    (set, get) => ({
      ...createInitial(),
      intake: (input) => apply(set, get, intakeObjective(dataOf(get()), input, nowIso(), nid)),
      moveTicket: (ticketId, status, workerId, forceGrade) =>
        apply(set, get, moveTicket(dataOf(get()), ticketId, status, workerId, nowIso(), nid, forceGrade)),
      toggleAcceptance: (ticketId, index) => set(toggleAcceptance(dataOf(get()), ticketId, index, nowIso())),
      saveFile: (ticketId, path, content) =>
        apply(set, get, saveFile(dataOf(get()), ticketId, path, content, nowIso())),
      submitCommand: (ticketId, command) =>
        apply(set, get, submitCommand(dataOf(get()), ticketId, command, nowIso(), nid)),
      resolveGate: (gateId, decision) =>
        apply(set, get, resolveGate(dataOf(get()), gateId, decision, nowIso(), nid)),
      publishViz: (ticketId, draft, baseRevision, skipped) =>
        apply(set, get, publishViz(dataOf(get()), ticketId, draft, baseRevision, skipped, nowIso(), nid)),
      workerAction: (workerId, action) =>
        apply(set, get, workerAction(dataOf(get()), workerId, action, nowIso(), nid)),
      registerWorker: (input) => apply(set, get, registerWorker(dataOf(get()), input, nowIso(), nid)),
      tickWatchdog: () => set(tickWatchdog(dataOf(get()), nowIso(), nid)),
      setSupervision: (on) => set({ supervision: on }),
      reset: () => set(createInitial()),
    }),
    {
      name: "orca-digital-pod-v1",
      skipHydration: true,
      partialize: (state) => ({
        workers: state.workers,
        tickets: state.tickets,
        gates: state.gates,
        gaps: state.gaps,
        events: state.events,
        heartbeats: state.heartbeats,
        stall: state.stall,
        supervision: state.supervision,
      }),
    },
  ),
);
