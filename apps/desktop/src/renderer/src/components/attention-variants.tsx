// PROTOTYPE — throwaway. Three card-anatomy / list-treatment shapes for the
// Attention tab (wayfinder ticket #26): (A) grouped cards, (B) flat urgency
// rows, (C) table ledger. Wired to REAL daemon data via useBoard() — no mocks
// (ticket #26). Judged inside a mock side-panel frame so density reads true.
// Delete this file with prototype-switcher.tsx and the attention-prototype
// route once a treatment wins.
//
// Fixed constraints from #12 (not re-litigated here): launcher not actor
// (click anywhere → item tab), deterministic content only, one unified list,
// kind filter (default All) + workspace filter, provider-aware quick-open.
//
// Two honest gaps this prototype surfaces (both flagged on the map as build
// work): NeedsHuman carries no wait time (only PrSummary.waitingSinceMillis
// exists) — so "Needs a decision" shows its reason instead of a wait; and no
// tracker ticket URL exists on the read model yet — so the provider-aware
// quick-open for "Needs a decision" is a disabled stub.

import type { ClassifiedItem, IssueTrackerType, NeedsHumanReason, PrSummary } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@cogwork/ui/components/table";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiArrowDownSLine,
  RiCheckLine,
  RiCloseLine,
  RiExpandDiagonalLine,
  RiExternalLinkLine,
  RiGitPullRequestLine,
  RiQuestionAnswerLine,
} from "@remixicon/react";
import { type ReactNode, useState } from "react";
import { mergeGate, needsHumanReasonLabel, selfHalts } from "../features/feed";
import { relativeTime } from "../features/format";
import { useBoard } from "../features/use-board";

// ---------------------------------------------------------------------------
// Real-data derivation
// ---------------------------------------------------------------------------

export type AttentionKind = "needs-decision" | "ready-to-merge";

export interface AttentionEntry {
  readonly workspace: string;
  readonly item: ClassifiedItem;
  readonly kind: AttentionKind;
  readonly pr: PrSummary | null;
  readonly tracker: IssueTrackerType | null;
  readonly reason: NeedsHumanReason | null;
  readonly waitMillis: number | null;
}

export type AttentionData =
  | { readonly _tag: "waiting" }
  | {
      readonly _tag: "ready";
      readonly entries: ReadonlyArray<AttentionEntry>;
      readonly workspaces: ReadonlyArray<string>;
    };

// Merge the two read-model queries into one unified, deduped list. An item that
// is both NeedsHuman and has a ready PR is shown once, as Ready to merge.
export function useAttentionData(): AttentionData {
  const result = useBoard();
  if (result._tag !== "Success") return { _tag: "waiting" };
  const { board } = result;

  const trackerFor = new Map<string, IssueTrackerType>();
  const workspaces: string[] = [];
  for (const state of board.workspaces.values()) {
    if (state._tag === "Registered") {
      trackerFor.set(state.name, state.issueTracker);
      workspaces.push(state.name);
    }
  }
  workspaces.sort();

  const ready = mergeGate(board, null);
  const readyKeys = new Set(ready.map((e) => `${e.workspace}::${e.item.id}`));

  const readyEntries: AttentionEntry[] = ready.map((e) => ({
    workspace: e.workspace,
    item: e.item,
    kind: "ready-to-merge",
    pr: e.pr,
    tracker: trackerFor.get(e.workspace) ?? null,
    reason: null,
    waitMillis: e.pr.waitingSinceMillis,
  }));

  const needEntries: AttentionEntry[] = selfHalts(board, null)
    .filter((e) => !readyKeys.has(`${e.workspace}::${e.item.id}`))
    .map((e) => ({
      workspace: e.workspace,
      item: e.item,
      kind: "needs-decision" as const,
      pr: e.item.pr ?? null,
      tracker: trackerFor.get(e.workspace) ?? null,
      reason: e.item._tag === "NeedsHuman" ? e.item.reason : null,
      waitMillis: null,
    }));

  return { _tag: "ready", entries: [...needEntries, ...readyEntries], workspaces };
}

// Global order for the flat treatment: decisions first (a blocked agent is the
// most urgent launcher), then PRs by longest wait.
export const byUrgency = (a: AttentionEntry, b: AttentionEntry) => {
  if (a.kind !== b.kind) return a.kind === "needs-decision" ? -1 : 1;
  return (a.waitMillis ?? 0) - (b.waitMillis ?? 0);
};

// ---------------------------------------------------------------------------
// Mock scenarios (DEV ONLY — the daemon has no live attention items right now)
//
// #26 asks for real daemon data, and the Live scenario still uses it. These
// mock scenarios exist only so the card anatomy and list density can be judged
// while the board is quiet. They never ship (the whole prototype is throwaway),
// and the switcher defaults to a busy mock so there is always something to see.
// ---------------------------------------------------------------------------

const MIN = 60_000;
const wid = (s: string) => s as unknown as ClassifiedItem["id"];
const trk = (s: string) => s as unknown as IssueTrackerType;

const mockPr = (
  n: number,
  checks: PrSummary["checks"],
  base: PrSummary["baseDivergence"],
  waitMin: number,
): PrSummary => ({
  number: n,
  url: `https://github.com/colonylabs/cogwork/pull/${n}`,
  checks,
  review: "ready",
  baseDivergence: base,
  waitingSinceMillis: Date.now() - waitMin * MIN,
});

const decision = (
  workspace: string,
  id: string,
  title: string,
  reason: NeedsHumanReason,
  tracker: string,
): AttentionEntry => ({
  workspace,
  item: { _tag: "NeedsHuman", id: wid(id), title, reason, proposal: null },
  kind: "needs-decision",
  pr: null,
  tracker: trk(tracker),
  reason,
  waitMillis: null,
});

const readyPr = (
  workspace: string,
  id: string,
  title: string,
  pr: PrSummary,
  tracker: string,
): AttentionEntry => ({
  workspace,
  item: { _tag: "Eligible", id: wid(id), title, stage: "verify", pr },
  kind: "ready-to-merge",
  pr,
  tracker: trk(tracker),
  reason: null,
  waitMillis: pr.waitingSinceMillis,
});

const busyEntries: ReadonlyArray<AttentionEntry> = [
  decision("cogwork", "AUD-1", "Audit engine ADR 0006 against the shipped scheduler", "needs-info", "github"),
  decision(
    "cogwork",
    "#61",
    "Notifications: dock badge for Needs-a-decision items",
    "ready-for-human",
    "github",
  ),
  decision(
    "clanker-forge",
    "CLF-204",
    "Coordination-outcome verbs: confirm the tracker mapping",
    "needs-info",
    "github",
  ),
  decision("atlas-api", "ATL-88", "Rate-limit policy for the public search endpoint", "needs-info", "linear"),
  decision(
    "atlas-api",
    "ATL-91",
    "Should the export job run per-tenant or globally?",
    "ready-for-human",
    "linear",
  ),
  readyPr(
    "cogwork",
    "#41",
    "Empty states: one consistent treatment",
    mockPr(44, "passing", "none", 95),
    "github",
  ),
  readyPr(
    "cogwork",
    "#35",
    "Feed: Spotlight + Ledger with terminal strips",
    mockPr(52, "pending", "clean", 22),
    "github",
  ),
  readyPr(
    "clanker-forge",
    "CLF-198",
    "Migrate claim recovery onto coordination outcomes",
    mockPr(31, "failing", "none", 140),
    "github",
  ),
  readyPr(
    "clanker-forge",
    "CLF-201",
    "Prune the tracker step verbs",
    mockPr(33, "passing", "conflict", 260),
    "github",
  ),
  readyPr(
    "atlas-api",
    "ATL-77",
    "Add cursor pagination to the audit log API",
    mockPr(12, "passing", "none", 8),
    "linear",
  ),
];

const decisionsOnly = busyEntries.filter((e) => e.kind === "needs-decision");
const prsOnly = busyEntries.filter((e) => e.kind === "ready-to-merge");
const quietEntries: ReadonlyArray<AttentionEntry> = [
  decision("cogwork", "AUD-1", "Audit engine ADR 0006 against the shipped scheduler", "needs-info", "github"),
  readyPr(
    "cogwork",
    "#41",
    "Empty states: one consistent treatment",
    mockPr(44, "passing", "none", 95),
    "github",
  ),
];

export type ScenarioKey = "live" | "busy" | "decisions" | "prs" | "quiet" | "empty";

export const scenarioMeta: ReadonlyArray<{ key: ScenarioKey; name: string }> = [
  { key: "busy", name: "Busy · both kinds" },
  { key: "decisions", name: "Decisions only" },
  { key: "prs", name: "PRs only" },
  { key: "quiet", name: "Quiet · one each" },
  { key: "empty", name: "Empty" },
  { key: "live", name: "Live daemon" },
];

const mockScenarios: Record<Exclude<ScenarioKey, "live">, ReadonlyArray<AttentionEntry>> = {
  busy: busyEntries,
  decisions: decisionsOnly,
  prs: prsOnly,
  quiet: quietEntries,
  empty: [],
};

const workspacesOf = (entries: ReadonlyArray<AttentionEntry>) =>
  [...new Set(entries.map((e) => e.workspace))].sort();

export function mockData(scenario: Exclude<ScenarioKey, "live">): AttentionData {
  const entries = mockScenarios[scenario];
  return { _tag: "ready", entries, workspaces: workspacesOf(entries) };
}

// ---------------------------------------------------------------------------
// Shared anatomy pieces (composed differently by each variant)
// ---------------------------------------------------------------------------

interface KindStyle {
  readonly label: string;
  readonly icon: typeof RiQuestionAnswerLine;
  readonly badge: string;
  readonly dot: string;
  readonly bar: string;
}

const kindStyle: Record<AttentionKind, KindStyle> = {
  "needs-decision": {
    label: "Needs a decision",
    icon: RiQuestionAnswerLine,
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
    bar: "bg-amber-500",
  },
  "ready-to-merge": {
    label: "Ready to merge",
    icon: RiGitPullRequestLine,
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
    bar: "bg-emerald-500",
  },
};

function KindBadge({ kind, withIcon = true }: { kind: AttentionKind; withIcon?: boolean }) {
  const style = kindStyle[kind];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        style.badge,
      )}
    >
      {withIcon && <Icon className="size-3.5" />}
      {style.label}
    </span>
  );
}

function trackerName(tracker: IssueTrackerType | null): string {
  if (!tracker) return "tracker";
  const t = String(tracker).toLowerCase();
  if (t.includes("linear")) return "Linear";
  if (t.includes("github")) return "GitHub";
  return String(tracker);
}

// Provider-aware quick-open. Ready to merge → the PR on the code host. Needs a
// decision → its tracker ticket, which has no URL on the read model yet, so the
// button is a disabled stub that names the provider.
function QuickOpen({ entry, iconOnly = false }: { entry: AttentionEntry; iconOnly?: boolean }) {
  if (entry.kind === "ready-to-merge" && entry.pr) {
    return (
      <Button
        size={iconOnly ? "icon-sm" : "xs"}
        variant="ghost"
        aria-label="Open PR on code host"
        render={<a href={entry.pr.url} rel="noreferrer" target="_blank" />}
        onClick={(event) => event.stopPropagation()}
      >
        {!iconOnly && "Open PR"}
        <RiExternalLinkLine data-icon={iconOnly ? undefined : "inline-end"} />
      </Button>
    );
  }
  const label = `Open in ${trackerName(entry.tracker)}`;
  return (
    <Button
      size={iconOnly ? "icon-sm" : "xs"}
      variant="ghost"
      disabled
      aria-label={label}
      title="Ticket URL pending a read-model field (#26 build)"
      onClick={(event) => event.stopPropagation()}
    >
      {!iconOnly && label}
      <RiExternalLinkLine data-icon={iconOnly ? undefined : "inline-end"} />
    </Button>
  );
}

// The one deterministic signal line: a wait for PRs, the reason for decisions.
function SignalText({ entry }: { entry: AttentionEntry }) {
  if (entry.pr) return <span>waiting {relativeTime(entry.pr.waitingSinceMillis)}</span>;
  if (entry.reason) return <span>{needsHumanReasonLabel[entry.reason]}</span>;
  return <span>needs a person</span>;
}

// Full PR badges — checks / review / base-divergence.
function PrBadges({ pr }: { pr: PrSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge
        variant={pr.checks === "passing" ? "secondary" : pr.checks === "failing" ? "destructive" : "outline"}
      >
        {pr.checks === "passing" ? "Checks pass" : pr.checks === "failing" ? "Checks fail" : "Checks pending"}
      </Badge>
      {pr.review === "changes-requested" && <Badge variant="destructive">Changes requested</Badge>}
      {pr.baseDivergence === "conflict" && <Badge variant="destructive">Conflicts</Badge>}
      {pr.baseDivergence === "clean" && <Badge variant="outline">Behind base</Badge>}
    </div>
  );
}

// Compact PR status as three coloured dots (checks · review · divergence).
const dotTone = {
  good: "bg-emerald-500",
  bad: "bg-destructive",
  wait: "bg-amber-500",
  none: "bg-muted-foreground/30",
} as const;

function PrDots({ pr }: { pr: PrSummary }) {
  const checks = pr.checks === "passing" ? "good" : pr.checks === "failing" ? "bad" : "wait";
  const review = pr.review === "ready" ? "good" : pr.review === "changes-requested" ? "bad" : "wait";
  const base = pr.baseDivergence === "conflict" ? "bad" : pr.baseDivergence === "clean" ? "wait" : "none";
  return (
    <span
      className="inline-flex items-center gap-1"
      title={`checks ${pr.checks} · review ${pr.review} · base ${pr.baseDivergence}`}
    >
      <span className={cn("size-2 rounded-full", dotTone[checks])} />
      <span className={cn("size-2 rounded-full", dotTone[review])} />
      <span className={cn("size-2 rounded-full", dotTone[base])} />
    </span>
  );
}

function ItemId({ id }: { id: string }) {
  return <span className="font-mono text-muted-foreground">{id}</span>;
}

// ---------------------------------------------------------------------------
// Shared filter controls (arranged / styled differently per variant)
// ---------------------------------------------------------------------------

type KindFilterValue = "all" | AttentionKind;

const kindFilterOptions: ReadonlyArray<{ key: KindFilterValue; label: string }> = [
  { key: "all", label: "All" },
  { key: "needs-decision", label: "Needs a decision" },
  { key: "ready-to-merge", label: "Ready to merge" },
];

function KindFilter({
  value,
  onChange,
  counts,
}: {
  value: KindFilterValue;
  onChange: (v: KindFilterValue) => void;
  counts: Record<KindFilterValue, number>;
}) {
  return (
    <ToggleGroup
      spacing={0}
      value={[value]}
      onValueChange={(v) => {
        const next = v[0] as KindFilterValue | undefined;
        if (next) onChange(next);
      }}
    >
      {kindFilterOptions.map((opt) => (
        <ToggleGroupItem key={opt.key} value={opt.key} variant="outline" size="sm" className="gap-1.5">
          {opt.label}
          <span className="text-muted-foreground">{counts[opt.key]}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function WorkspaceFilter({
  value,
  workspaces,
  onChange,
}: {
  value: string | null;
  workspaces: ReadonlyArray<string>;
  onChange: (v: string | null) => void;
}) {
  if (workspaces.length <= 1) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="sm" variant="outline" className="gap-1">
            {value ?? "All workspaces"}
            <RiArrowDownSLine data-icon="inline-end" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onChange(null)}>
          All workspaces
          {value === null && <RiCheckLine data-icon="inline-end" />}
        </DropdownMenuItem>
        {workspaces.map((ws) => (
          <DropdownMenuItem key={ws} onClick={() => onChange(ws)}>
            {ws}
            {value === ws && <RiCheckLine data-icon="inline-end" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Shared list plumbing
// ---------------------------------------------------------------------------

interface VariantProps {
  readonly entries: ReadonlyArray<AttentionEntry>; // already workspace-filtered
  readonly workspaces: ReadonlyArray<string>;
  readonly kindFilter: KindFilterValue;
  readonly setKindFilter: (v: KindFilterValue) => void;
  readonly workspaceFilter: string | null;
  readonly setWorkspaceFilter: (v: string | null) => void;
  readonly onOpen: (entry: AttentionEntry) => void;
}

function counts(entries: ReadonlyArray<AttentionEntry>): Record<KindFilterValue, number> {
  return {
    all: entries.length,
    "needs-decision": entries.filter((e) => e.kind === "needs-decision").length,
    "ready-to-merge": entries.filter((e) => e.kind === "ready-to-merge").length,
  };
}

const applyKind = (entries: ReadonlyArray<AttentionEntry>, kind: KindFilterValue) =>
  kind === "all" ? entries : entries.filter((e) => e.kind === kind);

export function AllClear() {
  return (
    <p className="px-1 py-6 text-center text-xs text-muted-foreground">
      Nothing needs a person right now.
      <br />
      <span className="text-muted-foreground/70">(Empty state is owned by #19 — not designed here.)</span>
    </p>
  );
}

function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">{children}</div>
  );
}

// ===========================================================================
// Variant A — Grouped cards (roomy; grouped-by-kind headers under All)
// ===========================================================================

function GroupHeader({ kind, count }: { kind: AttentionKind; count: number }) {
  return (
    <div className="flex items-center gap-2 px-0.5">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {kindStyle[kind].label}
      </h3>
      <Badge variant="outline">{count}</Badge>
    </div>
  );
}

function AttentionCard({ entry, onOpen }: { entry: AttentionEntry; onOpen: (e: AttentionEntry) => void }) {
  return (
    <Card
      size="sm"
      className="cursor-pointer transition-colors hover:bg-muted/50"
      onClick={() => onOpen(entry)}
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <KindBadge kind={entry.kind} />
          <span className="text-xs text-muted-foreground">
            <SignalText entry={entry} />
          </span>
        </div>
        <CardTitle className="mt-1.5 text-sm">{entry.item.title}</CardTitle>
        <div className="flex items-center gap-2 text-xs">
          <ItemId id={entry.item.id} />
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <span className="text-muted-foreground">{entry.workspace}</span>
        </div>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-2">
        {entry.pr ? <PrBadges pr={entry.pr} /> : <span />}
        <QuickOpen entry={entry} />
      </CardContent>
    </Card>
  );
}

function VariantA({
  entries,
  kindFilter,
  setKindFilter,
  workspaces,
  workspaceFilter,
  setWorkspaceFilter,
  onOpen,
}: VariantProps) {
  const filtered = applyKind(entries, kindFilter);
  const grouped = kindFilter === "all";
  const needs = filtered.filter((e) => e.kind === "needs-decision");
  const ready = filtered.filter((e) => e.kind === "ready-to-merge");
  return (
    <div className="flex h-full flex-col">
      <FilterBar>
        <KindFilter value={kindFilter} onChange={setKindFilter} counts={counts(entries)} />
        <WorkspaceFilter value={workspaceFilter} workspaces={workspaces} onChange={setWorkspaceFilter} />
      </FilterBar>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-3">
          {filtered.length === 0 && <AllClear />}
          {grouped ? (
            <>
              {needs.length > 0 && (
                <section className="flex flex-col gap-2">
                  <GroupHeader kind="needs-decision" count={needs.length} />
                  {needs.map((e) => (
                    <AttentionCard key={`${e.workspace}:${e.item.id}`} entry={e} onOpen={onOpen} />
                  ))}
                </section>
              )}
              {ready.length > 0 && (
                <section className="flex flex-col gap-2">
                  <GroupHeader kind="ready-to-merge" count={ready.length} />
                  {ready.map((e) => (
                    <AttentionCard key={`${e.workspace}:${e.item.id}`} entry={e} onOpen={onOpen} />
                  ))}
                </section>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((e) => (
                <AttentionCard key={`${e.workspace}:${e.item.id}`} entry={e} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ===========================================================================
// Variant B — Flat urgency rows (dense; NO group headers, leading kind marker)
// ===========================================================================

export function AttentionRow({
  entry,
  onOpen,
}: {
  entry: AttentionEntry;
  onOpen: (e: AttentionEntry) => void;
}) {
  const Icon = kindStyle[entry.kind].icon;
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className="group flex w-full items-center gap-3 py-2 pr-2 pl-0 text-left hover:bg-muted/50"
    >
      <span className={cn("h-8 w-0.5 shrink-0 rounded-full", kindStyle[entry.kind].bar)} aria-hidden />
      <Icon
        className={cn(
          "size-4 shrink-0",
          entry.kind === "needs-decision" ? "text-amber-500" : "text-emerald-500",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{entry.item.title}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ItemId id={entry.item.id} />
          <span aria-hidden>·</span>
          <span className="truncate">{entry.workspace}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        {entry.pr ? <PrDots pr={entry.pr} /> : null}
        <span className="w-20 text-right">
          <SignalText entry={entry} />
        </span>
        <span className="opacity-0 transition-opacity group-hover:opacity-100">
          <QuickOpen entry={entry} iconOnly />
        </span>
      </span>
    </button>
  );
}

function VariantB({
  entries,
  kindFilter,
  setKindFilter,
  workspaces,
  workspaceFilter,
  setWorkspaceFilter,
  onOpen,
}: VariantProps) {
  const filtered = [...applyKind(entries, kindFilter)].sort(byUrgency);
  return (
    <div className="flex h-full flex-col">
      <FilterBar>
        <KindFilter value={kindFilter} onChange={setKindFilter} counts={counts(entries)} />
        <WorkspaceFilter value={workspaceFilter} workspaces={workspaces} onChange={setWorkspaceFilter} />
      </FilterBar>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col divide-y px-3">
          {filtered.length === 0 && <AllClear />}
          {filtered.map((e) => (
            <AttentionRow key={`${e.workspace}:${e.item.id}`} entry={e} onOpen={onOpen} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

// ===========================================================================
// Variant C — Table ledger (densest; columns, grouped by kind under All)
// ===========================================================================

function LedgerRow({ entry, onOpen }: { entry: AttentionEntry; onOpen: (e: AttentionEntry) => void }) {
  return (
    <TableRow className="cursor-pointer" onClick={() => onOpen(entry)}>
      <TableCell className="w-0">
        <span
          className={cn("inline-block size-2 rounded-full", kindStyle[entry.kind].dot)}
          title={kindStyle[entry.kind].label}
        />
      </TableCell>
      <TableCell className="max-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm">{entry.item.title}</span>
          <ItemId id={entry.item.id} />
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{entry.workspace}</TableCell>
      <TableCell>
        {entry.pr ? <PrDots pr={entry.pr} /> : <span className="text-xs text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">
        <SignalText entry={entry} />
      </TableCell>
      <TableCell className="w-0 text-right">
        <QuickOpen entry={entry} iconOnly />
      </TableCell>
    </TableRow>
  );
}

function LedgerGroupHeader({ kind, count }: { kind: AttentionKind; count: number }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={6} className="bg-muted/40 py-1.5">
        <span className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {kindStyle[kind].label}
          <span className="rounded bg-muted px-1.5 font-mono">{count}</span>
        </span>
      </TableCell>
    </TableRow>
  );
}

function VariantC({
  entries,
  kindFilter,
  setKindFilter,
  workspaces,
  workspaceFilter,
  setWorkspaceFilter,
  onOpen,
}: VariantProps) {
  const filtered = applyKind(entries, kindFilter);
  const grouped = kindFilter === "all";
  const needs = filtered.filter((e) => e.kind === "needs-decision");
  const ready = filtered.filter((e) => e.kind === "ready-to-merge");
  return (
    <div className="flex h-full flex-col">
      <FilterBar>
        <KindFilter value={kindFilter} onChange={setKindFilter} counts={counts(entries)} />
        <WorkspaceFilter value={workspaceFilter} workspaces={workspaces} onChange={setWorkspaceFilter} />
      </FilterBar>
      <ScrollArea className="min-h-0 flex-1">
        <Table className="text-sm">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-0" />
              <TableHead>Item</TableHead>
              <TableHead>Workspace</TableHead>
              <TableHead>PR</TableHead>
              <TableHead className="text-right">Waiting / reason</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6}>
                  <AllClear />
                </TableCell>
              </TableRow>
            )}
            {grouped ? (
              <>
                {needs.length > 0 && <LedgerGroupHeader kind="needs-decision" count={needs.length} />}
                {needs.map((e) => (
                  <LedgerRow key={`${e.workspace}:${e.item.id}`} entry={e} onOpen={onOpen} />
                ))}
                {ready.length > 0 && <LedgerGroupHeader kind="ready-to-merge" count={ready.length} />}
                {ready.map((e) => (
                  <LedgerRow key={`${e.workspace}:${e.item.id}`} entry={e} onOpen={onOpen} />
                ))}
              </>
            ) : (
              filtered.map((e) => <LedgerRow key={`${e.workspace}:${e.item.id}`} entry={e} onOpen={onOpen} />)
            )}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage — mock side-panel frame + backdrop so density reads true
// ---------------------------------------------------------------------------

export type VariantKey = "a" | "b" | "c";

export const variantMeta: ReadonlyArray<{ key: VariantKey; name: string }> = [
  { key: "a", name: "Grouped cards" },
  { key: "b", name: "Flat urgency rows" },
  { key: "c", name: "Table ledger" },
];

function VariantBody({ variant, props }: { variant: VariantKey; props: VariantProps }) {
  if (variant === "a") return <VariantA {...props} />;
  if (variant === "b") return <VariantB {...props} />;
  return <VariantC {...props} />;
}

// Mimics the RightPanel tab strip so the variant is judged in context.
export function PanelFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col border-l bg-background">
      <div className="flex h-11 min-h-11 shrink-0 items-center gap-1 border-b px-2">
        <div className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2 text-xs text-foreground">
          Attention
        </div>
        <div className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground">
          Activity
        </div>
        <div className="ml-auto flex items-center gap-1 text-muted-foreground">
          <RiExpandDiagonalLine className="size-4" />
          <RiCloseLine className="size-4" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

export function FakeMainColumn() {
  return (
    <div className="flex h-full flex-col gap-3 p-6 opacity-40 select-none" aria-hidden>
      <div className="h-6 w-32 rounded bg-muted" />
      <div className="mt-2 h-24 rounded-lg border bg-card" />
      <div className="h-9 w-full rounded bg-muted/60" />
      <div className="h-9 w-full rounded bg-muted/60" />
      <div className="h-9 w-full rounded bg-muted/60" />
    </div>
  );
}

export function LastOpened({ entry }: { entry: AttentionEntry | null }) {
  return (
    <div className="border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      {entry ? (
        <span>
          Would open item tab → <span className="font-mono text-foreground">{entry.item.id}</span> ·{" "}
          {entry.workspace}
        </span>
      ) : (
        <span>Click a launcher to see which item tab it opens.</span>
      )}
    </div>
  );
}

export function AttentionStage({
  variant,
  scenario,
  full,
}: {
  variant: VariantKey;
  scenario: ScenarioKey;
  full: boolean;
}) {
  // Always call the hook (rules of hooks); use it only for the Live scenario.
  const live = useAttentionData();
  const data: AttentionData = scenario === "live" ? live : mockData(scenario);
  const [kindFilter, setKindFilter] = useState<KindFilterValue>("all");
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [lastOpened, setLastOpened] = useState<AttentionEntry | null>(null);

  const entries = data._tag === "ready" ? data.entries : [];
  const workspaces = data._tag === "ready" ? data.workspaces : [];
  const wsEntries = workspaceFilter ? entries.filter((e) => e.workspace === workspaceFilter) : entries;

  const props: VariantProps = {
    entries: wsEntries,
    workspaces,
    kindFilter,
    setKindFilter,
    workspaceFilter,
    setWorkspaceFilter,
    onOpen: setLastOpened,
  };

  const panel = (
    <div className="flex h-full min-h-0 flex-col">
      <PanelFrame>
        {data._tag === "waiting" ? (
          <p className="p-4 text-xs text-muted-foreground">Waiting for the daemon…</p>
        ) : (
          <VariantBody variant={variant} props={props} />
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
