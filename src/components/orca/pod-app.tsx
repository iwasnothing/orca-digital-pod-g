import { Activity, Plus, Radar, Shield } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { Matrix, MobileBoard } from "@/components/orca/board";
import { TicketDrawer } from "@/components/orca/drawer";
import { OrcaMark } from "@/components/orca/mark";
import { GateList, IntakeDialog, Rail, WatchPanel } from "@/components/orca/rail";
import { Drawer } from "@/components/orca/ui";
import { cn } from "@/lib/cn";
import { usePod } from "@/lib/orca/store";

type Pane = "board" | "gate" | "watch";

export function PodApp() {
  const heartbeats = usePod((state) => state.heartbeats);
  const pending = usePod((state) => state.gates.filter((gate) => gate.status === "pending").length);
  const supervision = usePod((state) => state.supervision);
  const tickWatchdog = usePod((state) => state.tickWatchdog);
  const reset = usePod((state) => state.reset);
  const [pane, setPane] = useState<Pane>("board");
  const [selected, setSelected] = useState<string | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [armedReset, setArmedReset] = useState(false);

  useEffect(() => {
    void usePod.persist.rehydrate();
  }, []);

  useEffect(() => {
    if (!supervision) return;
    const timer = window.setInterval(() => tickWatchdog(), 20000);
    return () => window.clearInterval(timer);
  }, [supervision, tickWatchdog]);

  useEffect(() => {
    if (!armedReset) return;
    const timer = window.setTimeout(() => setArmedReset(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armedReset]);

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink lg:h-screen lg:overflow-hidden">
      <div className="h-1 bg-teal" />
      <header className="shrink-0 border-b border-line bg-paper-2">
        <div className="flex items-center gap-3 px-4 py-3 lg:px-6">
          <OrcaMark />
          <div className="min-w-0">
            <h1 className="font-display text-2xl leading-none tracking-tight">Orca</h1>
            <p className="text-xs tracking-widest text-muted uppercase">Digital Pod</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <p className="hidden font-mono text-xs text-muted sm:block lg:hidden">
              <span className="tabular-nums">{pending}</span> waiting
            </p>
            <button
              type="button"
              className="hidden min-h-11 items-center rounded-xl bg-ink px-3 text-sm text-paper lg:inline-flex"
              onClick={() => setConsoleOpen(true)}
            >
              Console
              <span className="ml-2 tabular-nums">{pending}</span>
            </button>
            <button
              type="button"
              className="min-h-11 rounded-xl px-3 text-sm hover:bg-foam"
              onClick={() => {
                if (!armedReset) {
                  setArmedReset(true);
                  return;
                }
                reset();
                setSelected(null);
                setArmedReset(false);
                toast("Board restored");
              }}
            >
              {armedReset ? "Confirm reset" : "Reset"}
            </button>
          </div>
        </div>
        <div className="flex gap-2 overflow-x-auto px-4 pb-3 lg:px-6">
          {heartbeats.map((beat) => (
            <span key={beat.component} className="inline-flex shrink-0 items-center gap-2 rounded-full bg-card px-3 py-1 text-xs shadow-card">
              <span className={beat.status === "healthy" ? "size-2 rounded-full bg-teal" : "size-2 rounded-full bg-copper"} />
              <span>{beat.component}</span>
              <span className="text-muted">{beat.details}</span>
            </span>
          ))}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          <div className="hidden h-full lg:block">
            <Matrix onOpen={setSelected} />
          </div>
          <div className="lg:hidden">
            {pane === "board" ? <MobileBoard onOpen={setSelected} /> : null}
            {pane === "gate" ? (
              <div className="px-4 py-4 pb-36">
                <GateList />
              </div>
            ) : null}
            {pane === "watch" ? (
              <div className="px-4 py-4 pb-36">
                <WatchPanel />
              </div>
            ) : null}
          </div>
        </main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-card lg:hidden">
        <NavButton active={pane === "board"} onClick={() => setPane("board")} label="Board" icon={<Activity className="size-4" />} />
        <NavButton active={pane === "gate"} onClick={() => setPane("gate")} label={`Gate ${pending}`} icon={<Shield className="size-4" />} />
        <NavButton active={pane === "watch"} onClick={() => setPane("watch")} label="Watch" icon={<Radar className="size-4" />} />
      </nav>
      <button
        type="button"
        onClick={() => setIntakeOpen(true)}
        className="fixed right-4 bottom-20 z-30 grid size-14 place-items-center rounded-full bg-teal text-paper shadow-card lg:bottom-6 lg:right-6"
        aria-label="New objective"
      >
        <Plus className="size-6" />
      </button>
      <IntakeDialog open={intakeOpen} onOpenChange={setIntakeOpen} onCreated={setSelected} />
      <Drawer open={consoleOpen} onOpenChange={setConsoleOpen} side="left" title="Console" eyebrow="Gate, watchdog, workers">
        <Rail />
      </Drawer>
      <TicketDrawer ticketId={selected} onClose={() => setSelected(null)} />
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: "var(--color-card)",
            color: "var(--color-ink)",
            border: "1px solid var(--color-line)",
          },
        }}
      />
    </div>
  );
}

function NavButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-xs", active ? "text-teal-deep" : "text-muted")}
    >
      {icon}
      {label}
    </button>
  );
}
