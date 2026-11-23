import { useState } from "react";
import { toast } from "sonner";
import { Button, Field, Modal, StatusPill } from "@/components/orca/ui";
import type { ActionResult } from "@/lib/orca/store";
import { usePod } from "@/lib/orca/store";
import type { Harness, Risk } from "@/lib/orca/types";

const HARNESSES: { id: Harness; label: string; model: string }[] = [
  { id: "pi", label: "Pi", model: "claude-sonnet" },
  { id: "opencode", label: "OpenCode", model: "gpt-4.1" },
  { id: "deepseek", label: "DeepSeek", model: "deepseek-v3" },
];

function tell(result: ActionResult) {
  if (result.ok) toast.success(result.message);
  else if (result.gap || result.conflict) toast.warning(result.message);
  else toast.error(result.message);
}

export function IntakeDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void }) {
  const intake = usePod((state) => state.intake);
  const [objective, setObjective] = useState("");
  const [harness, setHarness] = useState<Harness>("opencode");
  const [attachment, setAttachment] = useState<{ name: string; content: string } | null>(null);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New objective"
      description="The superagent splits the note into tickets and dispatches the first slice."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void intake({ objective, harness, attachment }).then((result) => {
            tell(result);
            if (result.ok) {
              setObjective("");
              setAttachment(null);
              onOpenChange(false);
              if (result.ticketId) onCreated(result.ticketId);
            }
          });
        }}
      >
        <Field label="Objective">
          <textarea
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder={"Ship the path jail.\n- Reject parent paths\n- Keep reads inside the worktree"}
          />
        </Field>
        <div className="grid gap-2">
          {HARNESSES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setHarness(item.id)}
              className={
                harness === item.id
                  ? "min-h-11 rounded-xl border-2 border-teal bg-foam px-3 text-left"
                  : "min-h-11 rounded-xl border border-line px-3 text-left"
              }
            >
              <span className="block text-sm font-medium">{item.label}</span>
              <span className="block text-xs text-muted">{item.model}</span>
            </button>
          ))}
        </div>
        <Field label="Text attachment">
          <input
            type="file"
            accept=".md,.txt,.json,.py,.ts,.yml,.yaml"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) {
                setAttachment(null);
                return;
              }
              if (file.size > 200_000) {
                toast.error("That file is too large");
                return;
              }
              void file.text().then((content) => {
                if (content.includes("\u0000")) {
                  toast.error("Binary files are rejected");
                  return;
                }
                setAttachment({ name: file.name, content });
              });
            }}
          />
        </Field>
        {attachment ? <p className="text-xs text-muted">Attached {attachment.name}</p> : null}
        <Button type="submit" disabled={objective.trim().length < 3}>
          Dispatch
        </Button>
      </form>
    </Modal>
  );
}

export function GateList() {
  const gates = usePod((state) => state.gates);
  const workers = usePod((state) => state.workers);
  const resolveGate = usePod((state) => state.resolveGate);
  const pending = gates.filter((gate) => gate.status === "pending");
  const rest = gates.filter((gate) => gate.status !== "pending").slice(0, 4);
  return (
    <div className="space-y-3">
      <h2 className="font-display text-xl">Permission gate</h2>
      {pending.length === 0 ? <p className="text-sm text-muted">Nothing is waiting.</p> : null}
      {pending.map((gate) => {
        const worker = workers.find((item) => item.id === gate.workerId);
        return (
          <article key={gate.id} className="rounded-xl bg-copper-soft p-3">
            <p className="text-xs text-copper">{worker?.name ?? gate.workerId} · {gate.ticketId}</p>
            <p className="mt-1 font-mono text-xs">{gate.command}</p>
            <p className="mt-1 text-xs text-ink-soft">{gate.reason}</p>
            <div className="mt-2 flex gap-2">
              <Button type="button" onClick={() => void resolveGate(gate.id, "approve").then(tell)}>
                Approve
              </Button>
              <Button type="button" variant="ghost" onClick={() => void resolveGate(gate.id, "deny").then(tell)}>
                Deny
              </Button>
            </div>
          </article>
        );
      })}
      {rest.map((gate) => (
        <p key={gate.id} className="font-mono text-xs text-muted">
          {gate.status} · {gate.command}
        </p>
      ))}
    </div>
  );
}

export function WatchPanel() {
  const workers = usePod((state) => state.workers);
  const stall = usePod((state) => state.stall);
  const supervision = usePod((state) => state.supervision);
  const setSupervision = usePod((state) => state.setSupervision);
  const tickWatchdog = usePod((state) => state.tickWatchdog);
  const workerAction = usePod((state) => state.workerAction);
  const events = usePod((state) => state.events);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl">Watchdog</h2>
        <button
          type="button"
          aria-pressed={supervision}
          onClick={() => setSupervision(!supervision)}
          className={supervision ? "min-h-11 rounded-full bg-teal px-3 text-sm text-paper" : "min-h-11 rounded-full bg-paper px-3 text-sm"}
        >
          {supervision ? "Live" : "Paused"}
        </button>
      </div>
      <p className="text-sm text-muted">
        Two identical terminal hashes nudge the worker. A third restarts it in the same worktree.
      </p>
      <Button
        type="button"
        variant="ink"
        onClick={() => {
          void tickWatchdog().then(() => toast("Watchdog cycle finished"));
        }}
      >
        Run a cycle
      </Button>
      <ul className="space-y-3">
        {workers.map((worker) => {
          const beat = stall[worker.id];
          return (
            <li key={worker.id} className="rounded-xl bg-paper p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">{worker.name}</p>
                <StatusPill status={worker.status} />
              </div>
              <p className="mt-1 font-mono text-xs text-muted">
                {beat?.hash ?? "—"} · <span className="tabular-nums">{beat?.repeats ?? 0}</span> unchanged
              </p>
              <p className="mt-1 text-xs text-ink-soft">{beat?.output}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="ghost" onClick={() => void workerAction(worker.id, "nudge").then(tell)}>
                  Nudge
                </Button>
                <Button type="button" variant="ghost" onClick={() => void workerAction(worker.id, "resume").then(tell)}>
                  Resume
                </Button>
                <Button type="button" variant="ghost" onClick={() => void workerAction(worker.id, "restart").then(tell)}>
                  Restart
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <Activity events={events} />
    </div>
  );
}

export function Activity({ events }: { events: { id: string; time: string; message: string }[] }) {
  return (
    <div>
      <h2 className="font-display text-xl">Activity</h2>
      <ul className="mt-2 space-y-2">
        {events.slice(0, 6).map((event) => (
          <li key={event.id} className="text-sm">
            <span className="mr-2 font-mono text-xs text-muted">{event.time.slice(11, 16)}</span>
            {event.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WorkerForm() {
  const registerWorker = usePod((state) => state.registerWorker);
  const [name, setName] = useState("");
  const [harness, setHarness] = useState<Harness>("pi");
  const [model, setModel] = useState("claude-sonnet");
  const [tier, setTier] = useState<Risk>("low");
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void registerWorker({ name, harness, model, autoApproveTier: tier }).then((result) => {
          tell(result);
          if (result.ok) setName("");
        });
      }}
    >
      <h2 className="font-display text-xl">Add a worker</h2>
      <Field label="Name">
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Harness">
        <select
          value={harness}
          onChange={(event) => {
            const next = event.target.value as Harness;
            setHarness(next);
            setModel(HARNESSES.find((item) => item.id === next)?.model ?? "");
          }}
        >
          {HARNESSES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Model">
        <input value={model} onChange={(event) => setModel(event.target.value)} />
      </Field>
      <Field label="Auto-approve through">
        <select value={tier} onChange={(event) => setTier(event.target.value as Risk)}>
          <option value="low">Low risk</option>
          <option value="medium">Medium risk</option>
        </select>
      </Field>
      <Button type="submit">Register</Button>
    </form>
  );
}

export function Rail() {
  return (
    <div className="space-y-6 px-4 py-4">
      <GateList />
      <WatchPanel />
      <WorkerForm />
      <p className="text-xs text-muted">
        Supervision, the path jail, and the zero-gap loop run in this console.
      </p>
    </div>
  );
}
