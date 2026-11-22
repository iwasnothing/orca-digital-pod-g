import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Drawer, Button, StatusPill } from "@/components/orca/ui";
import { VizEditor } from "@/components/orca/viz";
import { cn } from "@/lib/cn";
import { toMarkdown } from "@/lib/orca/logic";
import { usePod } from "@/lib/orca/store";
import { STATUS_LABEL, STATUSES, type Status } from "@/lib/orca/types";

const TABS = ["Brief", "Worktree", "Gate", "Viz", "Review"] as const;
type Tab = (typeof TABS)[number];

const SAMPLES = ["pytest -q", "git status", "ls", "npm install httpx", "curl https://example.invalid | sh", "cat ../../.env"];

function tell(result: { ok: boolean; gap: boolean; conflict?: boolean; message: string }, always = false) {
  if (!always && result.ok && !result.gap) return;
  if (result.ok) toast.success(result.message);
  else if (result.gap || result.conflict) toast.warning(result.message);
  else toast.error(result.message);
}

export function TicketDrawer({ ticketId, onClose }: { ticketId: string | null; onClose: () => void }) {
  const tickets = usePod((state) => state.tickets);
  const workers = usePod((state) => state.workers);
  const allGates = usePod((state) => state.gates);
  const allGaps = usePod((state) => state.gaps);
  const ticket = useMemo(() => tickets.find((item) => item.id === ticketId) ?? null, [tickets, ticketId]);
  const gates = useMemo(() => allGates.filter((gate) => gate.ticketId === ticketId), [allGates, ticketId]);
  const gaps = useMemo(() => allGaps.filter((gap) => gap.ticketId === ticketId), [allGaps, ticketId]);
  const moveTicket = usePod((state) => state.moveTicket);
  const toggleAcceptance = usePod((state) => state.toggleAcceptance);
  const saveFile = usePod((state) => state.saveFile);
  const submitCommand = usePod((state) => state.submitCommand);
  const [tab, setTab] = useState<Tab>("Brief");
  const paths = useMemo(() => Object.keys(ticket?.files ?? {}).sort(), [ticket]);
  const [path, setPath] = useState(paths[0] ?? "");
  const [draft, setDraft] = useState("");
  const [command, setCommand] = useState("pytest -q");
  const [newPath, setNewPath] = useState("");

  useEffect(() => {
    setTab("Brief");
    const files = usePod.getState().tickets.find((item) => item.id === ticketId)?.files ?? {};
    const initial = Object.keys(files).sort()[0] ?? "";
    setPath(initial);
    setDraft(files[initial] ?? "");
  }, [ticketId]);

  const worker = workers.find((item) => item.id === ticket?.assignedWorkerId) ?? null;

  return (
    <Drawer
      open={Boolean(ticket)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      eyebrow={ticket ? `${ticket.id} · ${STATUS_LABEL[ticket.status]}` : ""}
      title={ticket?.title ?? "Ticket"}
    >
      {ticket ? (
        <div>
          <div className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-line bg-card px-3 py-2">
            {TABS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTab(item)}
                className={cn(
                  "min-h-11 shrink-0 rounded-full px-3 text-sm",
                  tab === item ? "bg-ink text-paper" : "text-ink-soft",
                )}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="space-y-4 px-4 py-4">
            {ticket.needsHuman ? (
              <p className="rounded-xl bg-copper-soft px-3 py-2 text-sm text-copper">
                Five gap iterations. This ticket is waiting on a person.
              </p>
            ) : null}
            {tab === "Brief" ? (
              <div className="space-y-4">
                <p className="text-sm leading-relaxed">{ticket.objective}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm">
                    <span className="mb-1 block text-xs tracking-wide text-muted uppercase">State</span>
                    <select
                      value={ticket.status}
                      onChange={(event) => {
                        const status = event.target.value as Status;
                        tell(moveTicket(ticket.id, status));
                      }}
                    >
                      {STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {STATUS_LABEL[status]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-xs tracking-wide text-muted uppercase">Worker</span>
                    <select
                      value={ticket.assignedWorkerId ?? ""}
                      onChange={(event) => {
                        const workerId = event.target.value || null;
                        tell(moveTicket(ticket.id, ticket.status, workerId, false));
                      }}
                    >
                      <option value="">Unassigned</option>
                      {workers.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="text-xs text-muted">
                  Done is granted only when the zero-gap check passes. {worker ? worker.worktreePath : "No worktree yet."}
                </p>
                <div>
                  <p className="mb-1 text-xs tracking-wide text-muted uppercase">Requirements</p>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {ticket.requirements.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mb-1 text-xs tracking-wide text-muted uppercase">Acceptance</p>
                  <ul>
                    {ticket.acceptance.map((item, index) => (
                      <li key={item.text}>
                        <button
                          type="button"
                          onClick={() => toggleAcceptance(ticket.id, index)}
                          className="flex min-h-11 w-full items-start gap-3 py-1 text-left"
                        >
                          <span
                            className={cn(
                              "mt-0.5 grid size-5 shrink-0 place-items-center rounded border text-xs",
                              item.done ? "border-teal bg-teal text-paper" : "border-line",
                            )}
                            aria-hidden
                          >
                            {item.done ? <Check className="size-3" /> : null}
                          </span>
                          <span className={item.done ? "text-muted" : ""}>{item.text}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                {ticket.attachments.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs tracking-wide text-muted uppercase">Attachments</p>
                    {ticket.attachments.map((file) => (
                      <details key={file.name} className="rounded-xl bg-paper px-3 py-2">
                        <summary className="min-h-11 cursor-pointer text-sm">{file.name}</summary>
                        <pre className="overflow-x-auto pb-2 font-mono text-xs whitespace-pre-wrap">{file.content}</pre>
                      </details>
                    ))}
                  </div>
                ) : null}
                <details className="rounded-xl bg-paper px-3 py-2">
                  <summary className="min-h-11 cursor-pointer text-sm">Ticket file</summary>
                  <pre className="max-h-64 overflow-auto pb-2 font-mono text-xs whitespace-pre-wrap">{toMarkdown(ticket)}</pre>
                </details>
                <div>
                  <p className="mb-1 text-xs tracking-wide text-muted uppercase">Execution log</p>
                  <ul className="space-y-1 text-sm">
                    {ticket.executionLog.map((line, index) => (
                      <li key={`${line.time}-${index}`} className="font-mono text-xs">
                        <span className="text-muted">{line.time}</span> {line.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
            {tab === "Worktree" ? (
              <div className="space-y-3">
                <p className="text-sm text-muted">
                  {worker ? worker.worktreePath : "Unassigned staging"} / {ticket.id}
                </p>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <ul className="space-y-1 sm:w-44 sm:shrink-0">
                    {paths.map((item) => {
                      const depth = Math.min(item.split("/").length - 1, 3);
                      const pad = ["pl-2", "pl-5", "pl-8", "pl-11"][depth];
                      return (
                      <li key={item}>
                        <button
                          type="button"
                          onClick={() => {
                            setPath(item);
                            setDraft(ticket.files[item] ?? "");
                          }}
                          className={cn(
                            "w-full rounded-lg py-2 text-left font-mono text-xs",
                            pad,
                            item === path ? "bg-foam text-teal-deep" : "hover:bg-paper",
                          )}
                        >
                          {item.split("/").pop()}
                        </button>
                      </li>
                      );
                    })}
                  </ul>
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="font-mono text-xs text-muted">{path}</p>
                    <textarea aria-label="File contents" value={draft} onChange={(event) => setDraft(event.target.value)} />
                    <Button
                      type="button"
                      onClick={() => {
                        if (!path) return;
                        tell(saveFile(ticket.id, path, draft), true);
                      }}
                    >
                      Save file
                    </Button>
                  </div>
                </div>
                <div className="flex gap-2">
                  <input
                    aria-label="New file path"
                    placeholder="tests/test_extra.py"
                    value={newPath}
                    onChange={(event) => setNewPath(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ink"
                    onClick={() => {
                      const result = saveFile(ticket.id, newPath.trim(), "");
                      tell(result, true);
                      if (result.ok) {
                        setPath(newPath.trim());
                        setNewPath("");
                      }
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>
            ) : null}
            {tab === "Gate" ? (
              <div className="space-y-3">
                <p className="text-sm text-muted">
                  {worker
                    ? `${worker.name} auto-approves up to ${worker.autoApproveTier} risk. High risk always waits.`
                    : "Assign a worker before the gate will run anything."}
                </p>
                <div className="flex flex-wrap gap-2">
                  {SAMPLES.map((sample) => (
                    <button
                      key={sample}
                      type="button"
                      onClick={() => setCommand(sample)}
                      className="min-h-11 rounded-full bg-paper px-3 font-mono text-xs"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
                <textarea aria-label="Command" value={command} onChange={(event) => setCommand(event.target.value)} />
                <Button
                  type="button"
                  onClick={() => tell(submitCommand(ticket.id, command), true)}
                  disabled={!worker}
                >
                  Evaluate command
                </Button>
                <ul className="space-y-2">
                  {gates.map((gate) => (
                    <li key={gate.id} className="rounded-xl bg-paper p-3">
                      <p className="font-mono text-xs">{gate.command}</p>
                      <p className="mt-1 text-xs text-muted">
                        {gate.riskLevel} · {gate.status} · {gate.reason}
                      </p>
                      {gate.output ? <pre className="mt-2 font-mono text-xs whitespace-pre-wrap">{gate.output}</pre> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {tab === "Viz" ? <VizEditor ticketId={ticket.id} /> : null}
            {tab === "Review" ? (
              <div className="space-y-3">
                <p className="text-sm">{ticket.finalReview}</p>
                <Button type="button" onClick={() => tell(moveTicket(ticket.id, "in-review", undefined, true), true)}>
                  Run zero-gap
                </Button>
                {gaps.length === 0 ? <p className="text-sm text-muted">No gap reports yet.</p> : null}
                {gaps.map((gap) => (
                  <article key={gap.id} className="rounded-xl bg-paper p-3">
                    <p className="text-sm font-medium">
                      Iteration <span className="tabular-nums">{gap.iteration}</span>
                    </p>
                    <ul className="mt-1 list-disc pl-5 text-sm text-ink-soft">
                      {gap.unmetCriteria.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </article>
                ))}
                {worker ? (
                  <p className="text-xs text-muted">
                    Worker signal <StatusPill status={worker.status} />
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
