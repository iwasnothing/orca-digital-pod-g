import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useEffect, useId, useMemo, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/orca/ui";
import {
  COUNTRY_CHOICES,
  WIDGET_LABEL,
  WIDGETS,
  defaultViz,
  layoutMermaid,
} from "@/lib/orca/logic";
import type { DiagramNode, VizPayload, WidgetType } from "@/lib/orca/types";
import { usePod } from "@/lib/orca/store";
import { toast } from "sonner";

function nodeById(nodes: DiagramNode[], id: string) {
  return nodes.find((node) => node.id === id);
}

function anchor(node: DiagramNode, towardX: number, towardY: number) {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const dx = towardX - cx;
  const dy = towardY - cy;
  if (Math.abs(dx) > Math.abs(dy)) return { x: dx > 0 ? node.x + node.w : node.x, y: cy };
  return { x: cx, y: dy > 0 ? node.y + node.h : node.y };
}

export function MermaidView({ source }: { source: string }) {
  const diagram = layoutMermaid(source);
  const markerId = useId().replace(/:/g, "");
  if (!diagram) {
    return (
      <pre className="overflow-x-auto rounded-xl bg-paper p-3 font-mono text-xs text-ink-soft">{source || "No diagram yet"}</pre>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl bg-paper p-2">
      <svg viewBox={`0 0 ${diagram.width} ${diagram.height}`} className="h-auto w-full min-w-72" role="img" aria-label="Flow diagram">
        <defs>
          <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0 0 L7 3 L0 6" className="fill-teal" />
          </marker>
        </defs>
        {diagram.edges.map((edge) => {
          const from = nodeById(diagram.nodes, edge.from);
          const to = nodeById(diagram.nodes, edge.to);
          if (!from || !to) return null;
          const start = anchor(from, to.x + to.w / 2, to.y + to.h / 2);
          const end = anchor(to, from.x + from.w / 2, from.y + from.h / 2);
          const mx = (start.x + end.x) / 2;
          const my = (start.y + end.y) / 2;
          return (
            <g key={`${edge.from}-${edge.to}-${edge.label}`}>
              <line
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                className="stroke-teal"
                strokeWidth="1.6"
                markerEnd={`url(#${markerId})`}
              />
              {edge.label ? (
                <text x={mx} y={my - 6} textAnchor="middle" className="fill-muted text-xs">
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {diagram.nodes.map((node) => (
          <g key={node.id}>
            <rect x={node.x} y={node.y} width={node.w} height={node.h} rx="12" className="fill-card stroke-line" strokeWidth="1" />
            <text x={node.x + node.w / 2} y={node.y + node.h / 2} textAnchor="middle" dominantBaseline="middle" className="fill-ink text-xs">
              {node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function GanttView({
  tasks,
  onSelect,
}: {
  tasks: { id: string; name: string; start: string; end: string }[];
  onSelect?: (index: number) => void;
}) {
  const dated = tasks.filter((task) => /^\d{4}-\d{2}-\d{2}$/.test(task.start) && /^\d{4}-\d{2}-\d{2}$/.test(task.end));
  if (dated.length === 0) return <p className="text-sm text-muted">Add a task with ISO dates.</p>;
  const min = Math.min(...dated.map((task) => Date.parse(`${task.start}T00:00:00Z`)));
  const max = Math.max(...dated.map((task) => Date.parse(`${task.end}T00:00:00Z`)));
  const span = Math.max(max - min, 86_400_000);
  return (
    <div className="space-y-2">
      <div className="flex justify-between font-mono text-xs text-muted">
        <span>{new Date(min).toISOString().slice(0, 10)}</span>
        <span>{new Date(max).toISOString().slice(0, 10)}</span>
      </div>
      {tasks.map((task, index) => {
        const start = Date.parse(`${task.start}T00:00:00Z`);
        const end = Date.parse(`${task.end}T00:00:00Z`);
        const valid = Number.isFinite(start) && Number.isFinite(end);
        const left = valid ? ((start - min) / span) * 100 : 0;
        const width = valid ? Math.max(((end - start) / span) * 100, 4) : 0;
        return (
          <button
            key={task.id}
            type="button"
            onClick={() => onSelect?.(index)}
            className="flex w-full min-h-11 items-center gap-2 rounded-lg py-1 text-left"
          >
            <span className="w-28 shrink-0 truncate text-sm">{task.name || "Task"}</span>
            <span className="relative h-3 min-w-0 flex-1 rounded-full bg-line">
              {valid ? (
                <span
                  className="absolute top-0 h-3 rounded-full bg-teal"
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function GeoMap({
  highlights,
  onToggle,
}: {
  highlights: { name: string; value: number }[];
  onToggle?: (name: string) => void;
}) {
  const [atlas, setAtlas] = useState<{ name: string; d: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    void import("@/lib/orca/atlas").then((mod) => {
      if (live) setAtlas(mod.ATLAS);
    });
    return () => {
      live = false;
    };
  }, []);
  const lookup = new Map(highlights.map((item) => [item.name.toLowerCase(), item.value]));
  const max = Math.max(...highlights.map((item) => item.value), 1);
  if (!atlas) return <p className="text-sm text-muted">Loading the country atlas…</p>;
  return (
    <div>
      <svg viewBox="0 0 640 320" className="h-auto w-full rounded-xl bg-paper" role="img" aria-label="Country atlas">
        {atlas.map((shape) => {
          const value = lookup.get(shape.name.toLowerCase());
          const on = value != null;
          return (
            <path
              key={shape.name}
              d={shape.d}
              className={on ? (value === max ? "fill-teal-deep" : "fill-teal") : "fill-line"}
              stroke="var(--color-paper)"
              strokeWidth="0.4"
              onClick={() => onToggle?.(shape.name)}
            >
              <title>{on ? `${shape.name}: ${value}` : shape.name}</title>
            </path>
          );
        })}
      </svg>
      <ul className="mt-3 flex flex-wrap gap-2">
        {highlights.map((item) => (
          <li key={item.name} className="rounded-full bg-foam px-3 py-1 text-xs text-teal-deep">
            {item.name} · <span className="tabular-nums">{item.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WalkerView({ title, rows }: { title: string; rows: { label: string; value: number }[] }) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium">{title}</p>
      <div className="h-52 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows}>
            <XAxis dataKey="label" tick={{ fill: "var(--color-muted)", fontSize: 12 }} />
            <YAxis tick={{ fill: "var(--color-muted)", fontSize: 12 }} width={32} />
            <Tooltip
              cursor={{ fill: "var(--color-foam)" }}
              contentStyle={{
                background: "var(--color-card)",
                border: "1px solid var(--color-line)",
                borderRadius: 12,
                color: "var(--color-ink)",
              }}
            />
            <Bar dataKey="value" fill="var(--color-teal)" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function GridView({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const data = useMemo(
    () => rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ""]))),
    [columns, rows],
  );
  const cols = useMemo<ColumnDef<Record<string, string>>[]>(
    () => columns.map((column) => ({ accessorKey: column, header: column })),
    [columns],
  );
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data,
    columns: cols,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-left text-sm">
        <thead className="bg-paper">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th key={header.id} className="px-3 py-2 font-medium">
                  <button type="button" className="min-h-11" onClick={header.column.getToggleSortingHandler()}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </button>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-t border-line">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-3 py-2">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VizView({ payload, onCountry }: { payload: VizPayload; onCountry?: (name: string) => void }) {
  if (payload.widget === "GeoMap") return <GeoMap highlights={payload.highlights} onToggle={onCountry} />;
  if (payload.widget === "GanttChart") return <GanttView tasks={payload.tasks} />;
  if (payload.widget === "MermaidDiagram") return <MermaidView source={payload.source} />;
  if (payload.widget === "GraphicWalker") return <WalkerView title={payload.title} rows={payload.rows} />;
  return <GridView columns={payload.columns} rows={payload.rows} />;
}

function announce(ok: boolean, gap: boolean, conflict: boolean | undefined, message: string) {
  if (gap && ok) toast.success(message);
  else if (gap || conflict) toast.warning(message);
  else if (!ok) toast.error(message);
  else toast.success(message);
}

export function VizEditor({ ticketId }: { ticketId: string }) {
  const ticket = usePod((state) => state.tickets.find((item) => item.id === ticketId));
  const publish = usePod((state) => state.publishViz);
  const [draft, setDraft] = useState<VizPayload | null>(null);
  const [base, setBase] = useState("");
  const [skip, setSkip] = useState(false);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!ticket) return;
    setDraft(ticket.viz ?? defaultViz("MermaidDiagram", ticket.title));
    setBase(ticket.viz?.revision ?? "");
    setSkip(false);
    setConflict(false);
  }, [ticket]);

  if (!ticket || !draft) return null;

  function setWidget(widget: WidgetType) {
    if (!ticket) return;
    setDraft(ticket.viz?.widget === widget ? ticket.viz : defaultViz(widget, ticket.title));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {WIDGETS.map((widget) => (
          <button
            key={widget}
            type="button"
            onClick={() => setWidget(widget)}
            className={
              draft.widget === widget
                ? "min-h-11 rounded-full bg-ink px-3 text-sm text-paper"
                : "min-h-11 rounded-full bg-paper px-3 text-sm text-ink"
            }
          >
            {WIDGET_LABEL[widget]}
          </button>
        ))}
      </div>
      <VizFields draft={draft} onChange={setDraft} />
      <div className="rounded-2xl bg-paper-2 p-3">
        <p className="mb-2 text-xs tracking-wide text-muted uppercase">Preview</p>
        <VizView
          payload={draft}
          onCountry={
            draft.widget === "GeoMap"
              ? (name) => {
                  const has = draft.highlights.some((item) => item.name === name);
                  setDraft({
                    ...draft,
                    highlights: has
                      ? draft.highlights.filter((item) => item.name !== name)
                      : [...draft.highlights, { name, value: 1 }],
                  });
                }
              : undefined
          }
        />
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={skip}
          onChange={(event) => setSkip(event.target.checked)}
        />
        Mark visualization skipped
      </label>
      <p className="font-mono text-xs text-muted">
        Revision {ticket.viz?.revision ?? "unpublished"}
        {ticket.vizStatus === "published" ? " · published" : ticket.viz ? " · draft" : ""}
      </p>
      {conflict ? (
        <p className="rounded-xl bg-copper-soft px-3 py-2 text-sm text-copper">
          Revision conflict. The stored snapshot moved. Load it, then publish again.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => {
            void publish(ticket.id, draft, base, skip).then((result) => {
              announce(result.ok, !!result.gap, !!result.conflict, result.message);
              if (result.ok) {
                setBase(draft.revision);
                setConflict(false);
              } else if (result.conflict || /409|conflict/i.test(result.message)) {
                setConflict(true);
              }
            });
          }}
        >
          Publish widget
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            if (ticket.viz) {
              setDraft(ticket.viz);
              setBase(ticket.viz.revision);
              setConflict(false);
              toast("Loaded the stored snapshot");
            }
          }}
        >
          Load stored
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setBase("conflict");
            toast("Draft marked stale. Publish to see the conflict.");
          }}
        >
          Simulate conflict
        </Button>
        <Button
          type="button"
          variant="foam"
          onClick={() => {
            if (draft.widget === "MermaidDiagram") {
              setDraft({ ...draft, source: `${draft.source}\n%% api_key=sk-sidecar-local-EXAMPLE` });
            } else if (draft.widget === "AgGrid") {
              setDraft({ ...draft, rows: [...draft.rows, ["token", "sk-sidecar-local-EXAMPLE"]] });
            } else {
              toast("Switch to Mermaid or Grid to plant a sample key");
              return;
            }
            toast("Sample key planted. Publish scrubs it.");
          }}
        >
          Plant a sample key
        </Button>
      </div>
    </div>
  );
}

function GeoFields({
  draft,
  onChange,
}: {
  draft: Extract<VizPayload, { widget: "GeoMap" }>;
  onChange: (next: VizPayload) => void;
}) {
  const [name, setName] = useState<string>(COUNTRY_CHOICES[0]);
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">Click a country on the map, or add one here.</p>
      <div className="flex gap-2">
        <select aria-label="Country" value={name} onChange={(event) => setName(event.target.value)}>
          {COUNTRY_CHOICES.map((country) => (
            <option key={country}>{country}</option>
          ))}
        </select>
        <Button
          type="button"
          variant="ink"
          onClick={() => {
            if (draft.highlights.some((item) => item.name === name)) return;
            onChange({ ...draft, highlights: [...draft.highlights, { name, value: 1 }] });
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function VizFields({ draft, onChange }: { draft: VizPayload; onChange: (next: VizPayload) => void }) {
  if (draft.widget === "MermaidDiagram") {
    return (
      <label className="block text-sm">
        <span className="mb-1 block text-xs tracking-wide text-muted uppercase">Diagram source</span>
        <textarea value={draft.source} onChange={(event) => onChange({ ...draft, source: event.target.value })} />
      </label>
    );
  }
  if (draft.widget === "GanttChart") {
    return (
      <div className="space-y-3">
        {draft.tasks.map((task, index) => (
          <div key={task.id} className="grid gap-2 sm:grid-cols-3">
            <input
              aria-label="Task name"
              value={task.name}
              onChange={(event) => {
                const tasks = draft.tasks.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, name: event.target.value } : item,
                );
                onChange({ ...draft, tasks });
              }}
            />
            <input
              aria-label="Start date"
              type="date"
              value={task.start}
              onChange={(event) => {
                const tasks = draft.tasks.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, start: event.target.value } : item,
                );
                onChange({ ...draft, tasks });
              }}
            />
            <input
              aria-label="End date"
              type="date"
              value={task.end}
              onChange={(event) => {
                const tasks = draft.tasks.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, end: event.target.value } : item,
                );
                onChange({ ...draft, tasks });
              }}
            />
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            onChange({
              ...draft,
              tasks: [
                ...draft.tasks,
                { id: `t-${draft.tasks.length + 1}`, name: "Next slice", start: "2026-11-28", end: "2026-12-02" },
              ],
            })
          }
        >
          Add task
        </Button>
      </div>
    );
  }
  if (draft.widget === "GeoMap") return <GeoFields draft={draft} onChange={onChange} />;
  if (draft.widget === "GraphicWalker") {
    return (
      <div className="space-y-2">
        <input
          aria-label="Chart title"
          value={draft.title}
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
        />
        {draft.rows.map((row, index) => (
          <div key={`${row.label}-${index}`} className="flex gap-2">
            <div className="min-w-0 flex-1">
            <input
              aria-label="Label"
              value={row.label}
              onChange={(event) => {
                const rows = draft.rows.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, label: event.target.value } : item,
                );
                onChange({ ...draft, rows });
              }}
            />
            </div>
            <input
              aria-label="Value"
              className="w-24 shrink-0"
              type="number"
              value={row.value}
              onChange={(event) => {
                const rows = draft.rows.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, value: Number(event.target.value) } : item,
                );
                onChange({ ...draft, rows });
              }}
            />
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          onClick={() => onChange({ ...draft, rows: [...draft.rows, { label: "New", value: 1 }] })}
        >
          Add row
        </Button>
      </div>
    );
  }
  const csv = [draft.columns.join(", "), ...draft.rows.map((row) => row.join(", "))].join("\n");
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs tracking-wide text-muted uppercase">Columns, then rows</span>
      <textarea
        value={csv}
        onChange={(event) => {
          const lines = event.target.value.split("\n").filter((line) => line.trim());
          const [head, ...rest] = lines;
          if (!head) return;
          const columns = head.split(",").map((cell) => cell.trim());
          const rows = rest.map((line) => line.split(",").map((cell) => cell.trim()));
          onChange({ ...draft, columns, rows });
        }}
      />
    </label>
  );
}
