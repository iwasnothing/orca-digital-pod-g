import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { WorkerStatus } from "@/lib/orca/types";

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "ink" | "copper" | "foam";
}) {
  return (
    <button
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors disabled:opacity-50",
        variant === "primary" && "bg-teal text-paper hover:bg-teal-deep",
        variant === "ink" && "bg-ink text-paper hover:bg-ink-soft",
        variant === "copper" && "bg-copper text-paper",
        variant === "foam" && "bg-foam text-teal-deep",
        variant === "ghost" && "bg-transparent text-ink hover:bg-foam",
        className,
      )}
      {...props}
    />
  );
}

const PILL: Record<WorkerStatus, string> = {
  healthy: "bg-foam text-teal-deep",
  idle: "bg-foam text-teal-deep",
  busy: "bg-ink text-paper",
  stalled: "bg-copper text-paper",
  offline: "bg-line text-ink-soft",
  "pending-approval": "bg-copper-soft text-copper",
};

const PILL_LABEL: Record<WorkerStatus, string> = {
  healthy: "Healthy",
  idle: "Healthy",
  busy: "Busy",
  stalled: "Stalled",
  offline: "Offline",
  "pending-approval": "Approval",
};

export function StatusPill({ status }: { status: WorkerStatus }) {
  return (
    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", PILL[status])}>
      {PILL_LABEL[status]}
    </span>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content className="fixed inset-x-0 top-8 z-50 mx-auto w-full max-w-lg px-4 focus:outline-none">
          <div className="max-h-dvh overflow-y-auto rounded-2xl bg-card p-5 shadow-card">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <Dialog.Title className="font-display text-2xl leading-tight">{title}</Dialog.Title>
                {description ? (
                  <Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description>
                ) : (
                  <Dialog.Description className="sr-only">{title}</Dialog.Description>
                )}
              </div>
              <Dialog.Close className="grid size-11 shrink-0 place-items-center rounded-xl hover:bg-foam" aria-label="Close">
                <X className="size-5" />
              </Dialog.Close>
            </div>
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Drawer({
  open,
  onOpenChange,
  title,
  eyebrow,
  side = "right",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  eyebrow?: string;
  side?: "left" | "right";
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          className={cn(
            "fixed inset-y-0 z-50 flex w-full max-w-xl flex-col bg-card shadow-card focus:outline-none",
            side === "left" ? "left-0" : "right-0",
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              {eyebrow ? <p className="font-mono text-xs text-muted">{eyebrow}</p> : null}
              <Dialog.Title className="font-display text-2xl leading-tight">{title}</Dialog.Title>
              <Dialog.Description className="sr-only">Ticket details, worktree, gate, and visualization</Dialog.Description>
            </div>
            <Dialog.Close className="grid size-11 shrink-0 place-items-center rounded-xl hover:bg-foam" aria-label="Close">
              <X className="size-5" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium tracking-wide text-muted uppercase">{label}</span>
      {children}
    </label>
  );
}
