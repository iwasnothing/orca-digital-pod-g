import { useEffect, useState } from "react";
import { toast } from "sonner";
import { StatusPill } from "@/components/orca/ui";
import { cn } from "@/lib/cn";
import { usePod } from "@/lib/orca/store";
import { STATUS_LABEL, STATUSES, type Priority, type Status, type Ticket } from "@/lib/orca/types";

function priorityClass(priority: Priority) {
  if (priority === "medium") return "text-teal";
  if (priority === "low") return "text-muted";
  return "text-copper";
}

function useDesktop() {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const apply = () => setDesktop(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return desktop;
}

export function TicketCard({
  ticket,
  onOpen,
  draggable,
}: {
  ticket: Ticket;
  onOpen: (id: string) => void;
  draggable?: boolean;
}) {
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", ticket.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onOpen(ticket.id)}
      className="w-full rounded-xl bg-card p-3 text-left shadow-card transition-shadow hover:shadow-card-hover"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted">{ticket.id}</span>
        <span className={cn("text-xs font-semibold tracking-wide uppercase", priorityClass(ticket.priority))}>
          {ticket.priority}
        </span>
      </span>
      <span className="mt-1 block font-display text-lg leading-snug">{ticket.title}</span>
      <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-soft">
        {ticket.gapIteration > 0 ? <span className="tabular-nums">Gap {ticket.gapIteration}</span> : null}
        {ticket.vizStatus === "published" ? <span className="text-teal">Viz live</span> : null}
        {ticket.vizStatus === "draft" ? <span className="text-copper">Viz draft</span> : null}
        {ticket.needsHuman ? <span className="text-copper">Needs a person</span> : null}
      </span>
    </button>
  );
}

function tell(result: { ok: boolean; gap: boolean; conflict?: boolean; message: string }) {
  if (!result.gap && result.ok) return;
  if (result.ok) toast.success(result.message);
  else if (result.gap || result.conflict) toast.warning(result.message);
  else toast.error(result.message);
}

export function Matrix({ onOpen }: { onOpen: (id: string) => void }) {
  const tickets = usePod((state) => state.tickets);
  const workers = usePod((state) => state.workers);
  const gates = usePod((state) => state.gates);
  const moveTicket = usePod((state) => state.moveTicket);
  const desktop = useDesktop();
  const [over, setOver] = useState<string | null>(null);
  const lanes = [{ id: "", name: "Intake", detail: "Unassigned", status: null as null }, ...workers.map((worker) => ({
    id: worker.id,
    name: worker.name,
    detail: `${worker.harness} · ${worker.model}`,
    status: worker.status,
  }))];

  return (
    <div className="h-full overflow-auto">
      <div className="min-w-max">
        <div className="sticky top-0 z-20 flex border-b border-line bg-paper">
          <div className="sticky left-0 z-30 w-36 shrink-0 border-r border-line bg-paper px-3 py-3">
            <p className="text-xs tracking-widest text-muted uppercase">Lane</p>
            <p className="font-display text-lg leading-tight">Harness</p>
          </div>
          {STATUSES.map((status, index) => {
            const count = tickets.filter((ticket) => ticket.status === status).length;
            return (
              <div key={status} className="w-44 shrink-0 border-r border-line px-3 py-3">
                <p className="font-mono text-xs text-muted">{String(index + 1).padStart(2, "0")}</p>
                <p className="flex items-baseline justify-between gap-2">
                  <span className="font-display text-lg leading-tight">{STATUS_LABEL[status]}</span>
                  <span className="font-mono text-xs text-muted tabular-nums">{count}</span>
                </p>
              </div>
            );
          })}
        </div>
        {lanes.map((lane, laneIndex) => {
          const pending = gates.filter((gate) => gate.workerId === lane.id && gate.status === "pending").length;
          const active = tickets.filter((ticket) => ticket.assignedWorkerId === (lane.id || null) && ticket.status !== "done").length;
          const bg = laneIndex % 2 === 0 ? "bg-paper" : "bg-paper-2";
          return (
            <div key={lane.id || "intake"} className={cn("flex min-h-40 border-b border-line", bg)}>
              <div className={cn("sticky left-0 z-10 w-36 shrink-0 border-r border-line px-3 py-3", bg)}>
                <p className="font-display text-xl leading-none">{lane.name}</p>
                <p className="mt-1 text-xs text-muted">{lane.detail}</p>
                {lane.status ? (
                  <div className="mt-2">
                    <StatusPill status={lane.status} />
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-muted">Waiting for triage</p>
                )}
                <p className="mt-2 font-mono text-xs text-ink-soft tabular-nums">{lane.id ? `${active} active` : `${active} staged`}</p>
                {pending > 0 ? <p className="mt-1 text-xs text-copper">{pending} awaiting approval</p> : null}
              </div>
              {STATUSES.map((status) => {
                const key = `${lane.id}:${status}`;
                const cards = tickets.filter(
                  (ticket) => ticket.status === status && (ticket.assignedWorkerId ?? "") === lane.id,
                );
                return (
                  <div
                    key={key}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setOver(key);
                    }}
                    onDragLeave={() => setOver((current) => (current === key ? null : current))}
                    onDrop={(event) => {
                      event.preventDefault();
                      setOver(null);
                      const ticketId = event.dataTransfer.getData("text/plain");
                      if (!ticketId) return;
                      tell(moveTicket(ticketId, status, lane.id || null));
                    }}
                    className={cn("w-44 shrink-0 border-r border-line p-2", over === key && "bg-foam")}
                  >
                    <div className="flex flex-col gap-2">
                      {cards.map((ticket) => (
                        <TicketCard key={ticket.id} ticket={ticket} onOpen={onOpen} draggable={desktop} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MobileBoard({ onOpen }: { onOpen: (id: string) => void }) {
  const tickets = usePod((state) => state.tickets);
  const workers = usePod((state) => state.workers);
  const [lane, setLane] = useState("all");
  const [status, setStatus] = useState<Status | "all">("all");
  const visible = tickets.filter((ticket) => {
    const laneOk = lane === "all" || (ticket.assignedWorkerId ?? "intake") === lane;
    const statusOk = status === "all" || ticket.status === status;
    return laneOk && statusOk;
  });
  const lanes = [
    { id: "all", label: "All" },
    { id: "intake", label: "Intake" },
    ...workers.map((worker) => ({ id: worker.id, label: worker.name })),
  ];

  return (
    <div className="px-4 pb-36">
      <div className="flex gap-2 overflow-x-auto py-3">
        {lanes.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setLane(item.id)}
            className={cn(
              "min-h-11 shrink-0 rounded-full px-3 text-sm",
              lane === item.id ? "bg-ink text-paper" : "bg-card text-ink shadow-card",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-3">
        <FilterChip active={status === "all"} onClick={() => setStatus("all")} label="Every state" />
        {STATUSES.map((item) => (
          <FilterChip
            key={item}
            active={status === item}
            onClick={() => setStatus(item)}
            label={`${STATUS_LABEL[item]} ${tickets.filter((ticket) => ticket.status === item).length}`}
          />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {visible.length === 0 ? <p className="text-sm text-muted">Nothing in this lane.</p> : null}
        {visible.map((ticket) => (
          <div key={ticket.id}>
            <p className="mb-1 text-xs tracking-wide text-muted uppercase">{STATUS_LABEL[ticket.status]}</p>
            <TicketCard ticket={ticket} onOpen={onOpen} />
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-h-11 shrink-0 rounded-full px-3 text-sm",
        active ? "bg-teal text-paper" : "bg-paper-2 text-ink",
      )}
    >
      {label}
    </button>
  );
}
