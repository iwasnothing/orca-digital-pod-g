import type { Harness, PodData, Risk, Status, VizPayload } from "./types";

export interface ApiResult {
  ok: boolean;
  message: string;
  ticketId?: string | null;
  workerId?: string | null;
  gap?: boolean;
  conflict?: boolean;
  pending?: boolean;
  output?: string | null;
  exitCode?: number | null;
}

async function request(path: string, init?: RequestInit): Promise<any> {
  const resp = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers as Record<string, string> | undefined) },
  });
  const text = await resp.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!resp.ok) {
    const err = new Error(data.detail || data.message || `HTTP ${resp.status}`);
    (err as Error & { status: number }).status = resp.status;
    throw err;
  }
  return data;
}

export async function getBoard(): Promise<PodData> {
  return request("/api/board");
}

export async function createWorker(input: {
  name: string;
  harness: Harness;
  model: string;
  autoApproveTier: Risk;
}): Promise<ApiResult> {
  return request("/api/workers", { method: "POST", body: JSON.stringify(input) });
}

export async function intake(input: {
  objective: string;
  harness: Harness;
  attachment?: { name: string; content: string } | null;
}): Promise<ApiResult> {
  return request("/api/objectives", {
    method: "POST",
    body: JSON.stringify({
      objective: input.objective,
      preferredHarness: input.harness,
      attachment: input.attachment ?? null,
    }),
  });
}

export async function patchTicket(
  ticketId: string,
  body: { status?: Status; assignedWorkerId?: string | null; acceptanceIndex?: number },
): Promise<ApiResult> {
  return request(`/api/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function saveWorkspaceFile(workerId: string, filePath: string, content: string): Promise<ApiResult> {
  return request(`/api/workspaces/${workerId}/file`, {
    method: "PUT",
    body: JSON.stringify({ filePath, content }),
  });
}

export async function readWorkspaceFile(workerId: string, path: string): Promise<{ path: string; content: string }> {
  return request(`/api/workspaces/${workerId}/file?path=${encodeURIComponent(path)}`);
}

export async function workspaceTree(workerId: string): Promise<{ root: string; tree: unknown }> {
  return request(`/api/workspaces/${workerId}/tree`);
}

export async function submitCommand(workerId: string, ticketId: string, worktreePath: string, command: string): Promise<ApiResult> {
  return request("/api/permission-gate", {
    method: "POST",
    body: JSON.stringify({ workerId, ticketId, worktreePath, command }),
  });
}

export async function resolveGate(gateId: string, decision: "approve" | "deny"): Promise<ApiResult> {
  return request(`/api/permission-gate/${gateId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
}

export async function publishViz(ticketId: string, draft: VizPayload, baseRevision: string, skipped: boolean): Promise<ApiResult> {
  return request(`/api/tickets/${ticketId}/visualization`, {
    method: "PUT",
    body: JSON.stringify({ ...draft, baseRevision, skipped }),
  });
}

export async function workerAction(workerId: string, action: "nudge" | "resume" | "restart"): Promise<ApiResult> {
  return request(`/api/workers/${workerId}/action`, { method: "POST", body: JSON.stringify({ action }) });
}

export async function tickWatchdog(): Promise<unknown> {
  return request("/api/watchdog/tick", { method: "POST" });
}

export async function setSupervision(on: boolean): Promise<unknown> {
  return request("/api/supervision", { method: "POST", body: JSON.stringify({ on }) });
}
