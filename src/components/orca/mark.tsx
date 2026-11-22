import { cn } from "@/lib/cn";

export function OrcaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-10", className)} aria-hidden>
      <rect width="32" height="32" rx="10" className="fill-ink" />
      <path d="M6.5 19.5c2.2-8 9-12.2 15.2-9.2 1.6 5.6-1.4 10.2-6.4 12.2-3.2 1.3-6.6.6-8.8-3z" className="fill-paper" />
      <circle cx="20.2" cy="12.2" r="1.3" className="fill-ink" />
      <path d="M17.5 22.2c3.4 2.2 7.6 1.2 9.5-1.8-3.2.2-6 .8-9.5 1.8z" className="fill-teal" />
    </svg>
  );
}
