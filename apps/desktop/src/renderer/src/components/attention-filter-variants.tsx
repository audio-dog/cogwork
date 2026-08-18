// PROTOTYPE — throwaway. Second prototype round for wayfinder #26, drilling into
// the FILTERING UI only. The list layout is already decided (treatment B — flat
// urgency rows), so every treatment here renders that same flat list and varies
// only the filter chrome above it:
//   F1 — Tabs + Select   (single-select toolbar; kind is the primary axis)
//   F2 — Faceted popovers (multi-select facets, data-table style, active chips)
//   F3 — Chip rail        (everything visible, tap-to-toggle pills)
//
// Real primitives (installed via the shadcn CLI into packages/ui): Tabs, Select,
// Popover, Checkbox, ToggleGroup. Data is real (Live) or a mock scenario, shared
// with the layout prototype. Delete with attention-variants.tsx, the
// prototype-switcher and both prototype routes once the filter UI is chosen.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Checkbox } from "@cogwork/ui/components/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@cogwork/ui/components/popover";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@cogwork/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@cogwork/ui/components/tabs";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { RiArrowDownSLine, RiCheckLine, RiCloseLine, RiFilter3Line } from "@remixicon/react";
import { type ReactNode, useState } from "react";
import {
  AllClear,
  type AttentionEntry,
  type AttentionKind,
  AttentionRow,
  byUrgency,
  FakeMainColumn,
  LastOpened,
  mockData,
  PanelFrame,
  type ScenarioKey,
  useAttentionData,
} from "./attention-variants";

// ---------------------------------------------------------------------------
// Canonical filter state — an empty set means "all". Single-select treatments
// replace the set; the faceted treatment toggles membership.
// ---------------------------------------------------------------------------

const kindOptions: ReadonlyArray<{ key: AttentionKind; label: string }> = [
  { key: "needs-decision", label: "Needs a decision" },
  { key: "ready-to-merge", label: "Ready to merge" },
];

interface FilterState {
  readonly kinds: ReadonlySet<AttentionKind>;
  readonly workspaces: ReadonlySet<string>;
  readonly setKinds: (s: ReadonlySet<AttentionKind>) => void;
  readonly setWorkspaces: (s: ReadonlySet<string>) => void;
  readonly setKindSingle: (v: "all" | AttentionKind) => void;
  readonly setWorkspaceSingle: (v: string | null) => void;
  readonly toggleKind: (k: AttentionKind) => void;
  readonly toggleWorkspace: (w: string) => void;
  readonly clearWorkspaces: () => void;
  readonly clearAll: () => void;
}

function useFilterState(): FilterState {
  const [kinds, setKinds] = useState<ReadonlySet<AttentionKind>>(new Set());
  const [workspaces, setWorkspaces] = useState<ReadonlySet<string>>(new Set());
  const toggle = <T,>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };
  return {
    kinds,
    workspaces,
    setKinds,
    setWorkspaces,
    setKindSingle: (v) => setKinds(v === "all" ? new Set() : new Set([v])),
    setWorkspaceSingle: (v) => setWorkspaces(v === null ? new Set() : new Set([v])),
    toggleKind: (k) => setKinds((s) => toggle(s, k)),
    toggleWorkspace: (w) => setWorkspaces((s) => toggle(s, w)),
    clearWorkspaces: () => setWorkspaces(new Set()),
    clearAll: () => {
      setKinds(new Set());
      setWorkspaces(new Set());
    },
  };
}

const passesFilter = (entry: AttentionEntry, filter: FilterState) =>
  (filter.kinds.size === 0 || filter.kinds.has(entry.kind)) &&
  (filter.workspaces.size === 0 || filter.workspaces.has(entry.workspace));

const kindLabel = (kind: AttentionKind) => kindOptions.find((o) => o.key === kind)?.label ?? kind;
const kindCount = (entries: ReadonlyArray<AttentionEntry>, kind: AttentionKind) =>
  entries.filter((e) => e.kind === kind).length;
const singleKind = (filter: FilterState): "all" | AttentionKind =>
  filter.kinds.size === 1 ? [...filter.kinds][0] : "all";
const singleWorkspace = (filter: FilterState): string | null =>
  filter.workspaces.size === 1 ? [...filter.workspaces][0] : null;

// ---------------------------------------------------------------------------
// Shared flat list (treatment B) + toolbar frame
// ---------------------------------------------------------------------------

function FlatList({
  entries,
  filter,
  onOpen,
}: {
  entries: ReadonlyArray<AttentionEntry>;
  filter: FilterState;
  onOpen: (e: AttentionEntry) => void;
}) {
  const rows = entries.filter((e) => passesFilter(e, filter)).sort(byUrgency);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col divide-y px-3">
        {rows.length === 0 && <AllClear />}
        {rows.map((e) => (
          <AttentionRow key={`${e.workspace}:${e.item.id}`} entry={e} onOpen={onOpen} />
        ))}
      </div>
    </ScrollArea>
  );
}

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">{children}</div>;
}

// ===========================================================================
// F1 — Tabs + Select (single-select toolbar; kind is the primary axis)
// ===========================================================================

function FilterF1({
  entries,
  workspaces,
  filter,
}: {
  entries: ReadonlyArray<AttentionEntry>;
  workspaces: ReadonlyArray<string>;
  filter: FilterState;
}) {
  const kind = singleKind(filter);
  const ws = singleWorkspace(filter);
  return (
    <Toolbar>
      <Tabs value={kind} onValueChange={(v) => filter.setKindSingle(v as "all" | AttentionKind)}>
        <TabsList>
          <TabsTrigger value="all">
            All <span className="text-muted-foreground">{entries.length}</span>
          </TabsTrigger>
          {kindOptions.map((opt) => (
            <TabsTrigger key={opt.key} value={opt.key}>
              {opt.label} <span className="text-muted-foreground">{kindCount(entries, opt.key)}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {workspaces.length > 1 && (
        <Select
          value={ws ?? "all"}
          onValueChange={(v) => filter.setWorkspaceSingle(v === "all" ? null : (v as string))}
        >
          <SelectTrigger size="sm" className="ms-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All workspaces</SelectItem>
            {workspaces.map((w) => (
              <SelectItem key={w} value={w}>
                {w}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Toolbar>
  );
}

// ===========================================================================
// F2 — Faceted popovers (multi-select facets + active chips, data-table style)
// ===========================================================================

function FacetPopover({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: ReadonlyArray<{ key: string; label: string; count: number }>;
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="sm" variant="outline" className="gap-1.5 border-dashed">
            <RiFilter3Line data-icon="inline-start" />
            {label}
            {selected.size > 0 && (
              <Badge variant="secondary" className="ms-1 px-1.5">
                {selected.size}
              </Badge>
            )}
            <RiArrowDownSLine data-icon="inline-end" />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-56">
        <div className="flex flex-col gap-0.5">
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => onToggle(opt.key)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-start text-sm hover:bg-accent"
            >
              <Checkbox checked={selected.has(opt.key)} tabIndex={-1} className="pointer-events-none" />
              <span className="flex-1 truncate">{opt.label}</span>
              <span className="text-xs text-muted-foreground">{opt.count}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ActiveChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <Badge variant="secondary" className="gap-1 pe-1">
      {label}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onClear}
        className="grid size-3.5 place-items-center rounded-full hover:bg-foreground/10"
      >
        <RiCloseLine className="size-3" />
      </button>
    </Badge>
  );
}

function FilterF2({
  entries,
  workspaces,
  filter,
}: {
  entries: ReadonlyArray<AttentionEntry>;
  workspaces: ReadonlyArray<string>;
  filter: FilterState;
}) {
  const hasActive = filter.kinds.size > 0 || filter.workspaces.size > 0;
  return (
    <Toolbar>
      <FacetPopover
        label="Kind"
        options={kindOptions.map((o) => ({ key: o.key, label: o.label, count: kindCount(entries, o.key) }))}
        selected={filter.kinds as ReadonlySet<string>}
        onToggle={(k) => filter.toggleKind(k as AttentionKind)}
      />
      {workspaces.length > 1 && (
        <FacetPopover
          label="Workspace"
          options={workspaces.map((w) => ({
            key: w,
            label: w,
            count: entries.filter((e) => e.workspace === w).length,
          }))}
          selected={filter.workspaces}
          onToggle={filter.toggleWorkspace}
        />
      )}
      {hasActive && (
        <>
          <span className="h-4 w-px bg-border" aria-hidden />
          <div className="flex flex-wrap items-center gap-1">
            {[...filter.kinds].map((k) => (
              <ActiveChip key={k} label={kindLabel(k)} onClear={() => filter.toggleKind(k)} />
            ))}
            {[...filter.workspaces].map((w) => (
              <ActiveChip key={w} label={w} onClear={() => filter.toggleWorkspace(w)} />
            ))}
          </div>
          <Button size="xs" variant="ghost" className="ms-auto" onClick={filter.clearAll}>
            Clear
          </Button>
        </>
      )}
    </Toolbar>
  );
}

// ===========================================================================
// F3 — Chip rail (everything visible, tap-to-toggle pills)
// ===========================================================================

function FilterF3({
  entries,
  workspaces,
  filter,
}: {
  entries: ReadonlyArray<AttentionEntry>;
  workspaces: ReadonlyArray<string>;
  filter: FilterState;
}) {
  const kind = singleKind(filter);
  const ws = singleWorkspace(filter);
  return (
    <Toolbar>
      <ToggleGroup
        value={[kind]}
        onValueChange={(v) => {
          const next = v[0] as "all" | AttentionKind | undefined;
          if (next) filter.setKindSingle(next);
        }}
      >
        <ToggleGroupItem value="all" variant="outline" size="sm">
          All
        </ToggleGroupItem>
        {kindOptions.map((opt) => (
          <ToggleGroupItem key={opt.key} value={opt.key} variant="outline" size="sm" className="gap-1.5">
            {opt.label}
            <span className="text-muted-foreground">{kindCount(entries, opt.key)}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {workspaces.length > 1 && (
        <>
          <span className="h-4 w-px bg-border" aria-hidden />
          <ToggleGroup
            value={[ws ?? "all"]}
            onValueChange={(v) => {
              const next = v[0] as string | undefined;
              if (next) filter.setWorkspaceSingle(next === "all" ? null : next);
            }}
          >
            <ToggleGroupItem value="all" variant="outline" size="sm">
              All ws
            </ToggleGroupItem>
            {workspaces.map((w) => (
              <ToggleGroupItem key={w} value={w} variant="outline" size="sm">
                {w}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </>
      )}
    </Toolbar>
  );
}

// ===========================================================================
// F4 / F5 — refined: kind pills (implicit "all", no All chip) + a compact,
// multi-select workspace control (Codex review-panel steal). No workspace chips.
// ===========================================================================

// Two kind pills, multi-select. None selected = all — so there is no "All" chip.
function KindPills({ entries, filter }: { entries: ReadonlyArray<AttentionEntry>; filter: FilterState }) {
  return (
    <ToggleGroup
      multiple
      value={[...filter.kinds]}
      onValueChange={(v) => filter.setKinds(new Set(v as AttentionKind[]))}
    >
      {kindOptions.map((opt) => (
        <ToggleGroupItem key={opt.key} value={opt.key} variant="outline" size="sm" className="gap-1.5">
          {opt.label}
          <span className="text-muted-foreground">{kindCount(entries, opt.key)}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const workspaceSummary = (filter: FilterState): string => {
  const n = filter.workspaces.size;
  if (n === 0) return "All workspaces";
  if (n === 1) return [...filter.workspaces][0];
  return `${n} workspaces`;
};

// Shared popover body: "All workspaces" reset + a multi-select checkbox per
// workspace. Any combination, in a fixed-width menu that never grows the header.
function WorkspaceMenu({
  entries,
  workspaces,
  filter,
}: {
  entries: ReadonlyArray<AttentionEntry>;
  workspaces: ReadonlyArray<string>;
  filter: FilterState;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={filter.clearWorkspaces}
        className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-start text-sm hover:bg-accent"
      >
        <span>All workspaces</span>
        {filter.workspaces.size === 0 && <RiCheckLine className="size-4 text-muted-foreground" />}
      </button>
      <span className="my-0.5 h-px bg-border" aria-hidden />
      {workspaces.map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => filter.toggleWorkspace(w)}
          className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-start text-sm hover:bg-accent"
        >
          <Checkbox checked={filter.workspaces.has(w)} tabIndex={-1} className="pointer-events-none" />
          <span className="flex-1 truncate">{w}</span>
          <span className="text-xs text-muted-foreground">
            {entries.filter((e) => e.workspace === w).length}
          </span>
        </button>
      ))}
    </div>
  );
}

// F4 — inline dropdown that summarises the selection (Codex "origin/main ▾").
function FilterF4({
  entries,
  workspaces,
  filter,
}: {
  entries: ReadonlyArray<AttentionEntry>;
  workspaces: ReadonlyArray<string>;
  filter: FilterState;
}) {
  return (
    <Toolbar>
      <KindPills entries={entries} filter={filter} />
      {workspaces.length > 1 && (
        <Popover>
          <PopoverTrigger
            render={
              <Button size="sm" variant="outline" className="ms-auto max-w-40 gap-1">
                <span className="truncate">{workspaceSummary(filter)}</span>
                <RiArrowDownSLine data-icon="inline-end" />
              </Button>
            }
          />
          <PopoverContent align="end" className="w-56">
            <WorkspaceMenu entries={entries} workspaces={workspaces} filter={filter} />
          </PopoverContent>
        </Popover>
      )}
    </Toolbar>
  );
}

// F5 — a funnel icon (active dot) over a slim summary banner (Codex info strip),
// keeping the header row minimal until a workspace filter is on.
function FilterF5({
  entries,
  workspaces,
  filter,
}: {
  entries: ReadonlyArray<AttentionEntry>;
  workspaces: ReadonlyArray<string>;
  filter: FilterState;
}) {
  const active = filter.workspaces.size > 0;
  return (
    <div className="flex flex-col border-b">
      <div className="flex items-center gap-2 px-3 py-2">
        <KindPills entries={entries} filter={filter} />
        {workspaces.length > 1 && (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Filter workspaces"
                  className="relative ms-auto"
                >
                  <RiFilter3Line />
                  {active && (
                    <span className="absolute end-0.5 top-0.5 size-2 rounded-full bg-primary" aria-hidden />
                  )}
                </Button>
              }
            />
            <PopoverContent align="end" className="w-56">
              <WorkspaceMenu entries={entries} workspaces={workspaces} filter={filter} />
            </PopoverContent>
          </Popover>
        )}
      </div>
      {active && (
        <div className="flex items-center gap-2 border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <RiFilter3Line className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{[...filter.workspaces].join(", ")}</span>
          <button type="button" onClick={filter.clearWorkspaces} className="shrink-0 hover:text-foreground">
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export type FilterTreatmentKey = "f4" | "f5" | "f1" | "f2" | "f3";

export const filterMeta: ReadonlyArray<{ key: FilterTreatmentKey; name: string }> = [
  { key: "f4", name: "Pills + workspace menu" },
  { key: "f5", name: "Pills + filter icon" },
  { key: "f1", name: "Tabs + Select" },
  { key: "f2", name: "Faceted popovers" },
  { key: "f3", name: "Chip rail" },
];

function FilterBody({
  treatment,
  entries,
  workspaces,
  filter,
}: {
  treatment: FilterTreatmentKey;
  entries: ReadonlyArray<AttentionEntry>;
  workspaces: ReadonlyArray<string>;
  filter: FilterState;
}) {
  const props = { entries, workspaces, filter };
  if (treatment === "f4") return <FilterF4 {...props} />;
  if (treatment === "f5") return <FilterF5 {...props} />;
  if (treatment === "f1") return <FilterF1 {...props} />;
  if (treatment === "f2") return <FilterF2 {...props} />;
  return <FilterF3 {...props} />;
}

export function AttentionFilterStage({
  treatment,
  scenario,
  full,
}: {
  treatment: FilterTreatmentKey;
  scenario: ScenarioKey;
  full: boolean;
}) {
  const live = useAttentionData();
  const data = scenario === "live" ? live : mockData(scenario);
  const filter = useFilterState();
  const [lastOpened, setLastOpened] = useState<AttentionEntry | null>(null);

  const entries = data._tag === "ready" ? data.entries : [];
  const workspaces = data._tag === "ready" ? data.workspaces : [];

  const panel = (
    <div className="flex h-full min-h-0 flex-col">
      <PanelFrame>
        {data._tag === "waiting" ? (
          <p className="p-4 text-xs text-muted-foreground">Waiting for the daemon…</p>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <FilterBody treatment={treatment} entries={entries} workspaces={workspaces} filter={filter} />
            <FlatList entries={entries} filter={filter} onOpen={setLastOpened} />
          </div>
        )}
      </PanelFrame>
      <LastOpened entry={lastOpened} />
    </div>
  );

  if (full) return <div className="h-full">{panel}</div>;
  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1">
        <FakeMainColumn />
      </div>
      <div className="w-[440px] shrink-0">{panel}</div>
    </div>
  );
}
