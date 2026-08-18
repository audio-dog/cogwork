// PROTOTYPE — throwaway. Three layout shapes for the item detail tab (wayfinder
// ticket #25): (a) single scroll column, (b) sub-tabs, (c) split. Mocked data,
// no daemon. Judged inside a mock side-panel frame so density reads true.
// Delete this file with prototype-switcher.tsx and the item-tab-prototype route
// once a layout wins. Presentation of the transcript itself is ticket #11; here
// it is only representative so the "focal when running" question is judgeable.

import type { PrBaseDivergence, PrChecks, PrReviewStatus } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Separator } from "@cogwork/ui/components/separator";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiArrowRightLine,
  RiCloseLine,
  RiExpandDiagonalLine,
  RiExternalLinkLine,
  RiGitBranchLine,
  RiPulseLine,
  RiStopCircleLine,
} from "@remixicon/react";
import { type ReactNode, useState } from "react";
import { elapsed, relativeTime } from "../features/format";
import { PrChecksBadge, PrDivergenceBadge, PrReviewBadge } from "./badges";

// ---------------------------------------------------------------------------
// Mock model
// ---------------------------------------------------------------------------

export type ScenarioKey = "running" | "needs-decision" | "pr-ready" | "blocked";

export const scenarios: ReadonlyArray<{ key: ScenarioKey; name: string }> = [
  { key: "running", name: "Live run" },
  { key: "needs-decision", name: "Needs a decision" },
  { key: "pr-ready", name: "Ready to merge" },
  { key: "blocked", name: "Blocked" },
];

interface MockPr {
  readonly number: number;
  readonly url: string;
  readonly checks: PrChecks;
  readonly review: PrReviewStatus;
  readonly baseDivergence: PrBaseDivergence;
  readonly waitingSinceMillis: number;
}

interface MockAttempt {
  readonly stage: string;
  readonly outcome: "succeeded" | "failed" | "abandoned";
  readonly atMillis: number;
  readonly summary: string;
}

interface MockMeta {
  readonly branch: string | null;
  readonly session: string | null;
  readonly harness: string;
  readonly totalTokens: number | null;
  readonly startedAtMillis: number;
  readonly endedAtMillis: number | null;
}

type Row =
  | { readonly id: string; readonly kind: "text"; readonly text: string }
  | { readonly id: string; readonly kind: "reasoning"; readonly text: string }
  | {
      readonly id: string;
      readonly kind: "tool";
      readonly name: string;
      readonly preview: string;
      readonly detail: string;
    }
  | {
      readonly id: string;
      readonly kind: "diff";
      readonly path: string;
      readonly stat: string;
      readonly detail: string;
    };

interface MockItem {
  readonly id: string;
  readonly title: string;
  readonly workspace: string;
  readonly stateLabel: string;
  readonly stateTone: "live" | "attention" | "ready" | "blocked";
  readonly running: boolean;
  readonly nowLine: string | null;
  readonly triage: { readonly reason: string; readonly proposal: string } | null;
  readonly pr: MockPr | null;
  readonly blockers: ReadonlyArray<string>;
  readonly attempts: ReadonlyArray<MockAttempt>;
  readonly meta: MockMeta;
  readonly transcript: ReadonlyArray<Row>;
}

const MIN = 60_000;
const now = Date.now();

const liveTranscript: ReadonlyArray<Row> = [
  {
    id: "t1",
    kind: "text",
    text: "Kicking off the follow-up run for the tracker-verb prune. I'll audit the read model, then remove the dropped verbs.",
  },
  {
    id: "t2",
    kind: "reasoning",
    text: "The hand-to-human verb is referenced in three adapters plus the schema. Safest order is schema first so the type errors surface every caller.",
  },
  {
    id: "t3",
    kind: "tool",
    name: "grep",
    preview: "hand-to-human across packages/*",
    detail:
      '$ rg -n "hand-to-human" packages\npackages/contracts/src/triage.ts:41\npackages/engine/src/tracker/github.ts:218\npackages/engine/src/tracker/linear.ts:191',
  },
  {
    id: "t4",
    kind: "tool",
    name: "read",
    preview: "packages/contracts/src/triage.ts",
    detail: "Opened triage.ts — TriageRole union carries the verb to drop.",
  },
  {
    id: "t5",
    kind: "diff",
    path: "packages/contracts/src/triage.ts",
    stat: "+2 −5",
    detail: '-  "hand-to-human",\n-  "needs-triage",\n+  "needs-info",',
  },
  {
    id: "t6",
    kind: "reasoning",
    text: "Type errors now point at the two adapters. Update both to map the retired verb onto needs-info.",
  },
  {
    id: "t7",
    kind: "tool",
    name: "edit",
    preview: "packages/engine/src/tracker/github.ts",
    detail: "Replaced the hand-to-human branch with needs-info.",
  },
  {
    id: "t8",
    kind: "text",
    text: "Running the contracts typecheck to confirm the union change is clean before touching the engine tests.",
  },
];

const doneTranscript: ReadonlyArray<Row> = [
  {
    id: "d1",
    kind: "text",
    text: "Implemented the empty-state pass across the four calm surfaces and wired the shared Empty primitive.",
  },
  {
    id: "d2",
    kind: "tool",
    name: "edit",
    preview: "apps/desktop/.../feed.tsx",
    detail: "Swapped the bespoke EmptyNote for the shared Empty primitive.",
  },
  {
    id: "d3",
    kind: "diff",
    path: "apps/desktop/src/renderer/src/components/feed.tsx",
    stat: "+14 −22",
    detail: "- <EmptyNote>No queued work.</EmptyNote>\n+ <Empty>…</Empty>",
  },
  {
    id: "d4",
    kind: "text",
    text: "Typecheck and desktop tests are green. Opened the pull request for review.",
  },
];

const items: Record<ScenarioKey, MockItem> = {
  running: {
    id: "#50",
    title: "Prune tracker step verbs and delete hand-to-human",
    workspace: "cogwork",
    stateLabel: "Running · implement",
    stateTone: "live",
    running: true,
    nowLine: "Editing packages/engine/src/tracker/github.ts",
    triage: null,
    pr: null,
    blockers: [],
    attempts: [
      {
        stage: "implement",
        outcome: "failed",
        atMillis: now - 180 * MIN,
        summary: "First pass missed the Linear adapter; typecheck failed.",
      },
    ],
    meta: {
      branch: "33-contract-prune-tracker-step-verbs",
      session: "sess_9f2ac1",
      harness: "cursor-acp",
      totalTokens: 41_200,
      startedAtMillis: now - 6 * MIN,
      endedAtMillis: null,
    },
    transcript: liveTranscript,
  },
  "needs-decision": {
    id: "AUD-1",
    title: "Audit engine ADR 0006 against the shipped scheduler",
    workspace: "clanker-forge",
    stateLabel: "Needs a decision · needs-info",
    stateTone: "attention",
    running: false,
    nowLine: null,
    triage: {
      reason: "Needs info",
      proposal:
        "The ADR names a per-workspace concurrency cap, but the shipped scheduler only enforces a global limit. Should I add the per-workspace cap to match the ADR, or update the ADR to record the global-only decision? I lean toward updating the ADR — the global limit has held up in practice.",
    },
    pr: null,
    blockers: [],
    attempts: [
      {
        stage: "triage",
        outcome: "succeeded",
        atMillis: now - 40 * MIN,
        summary: "Classified as ready-for-agent.",
      },
    ],
    meta: {
      branch: null,
      session: "sess_11b7d0",
      harness: "cursor-acp",
      totalTokens: 8_900,
      startedAtMillis: now - 52 * MIN,
      endedAtMillis: now - 38 * MIN,
    },
    transcript: doneTranscript,
  },
  "pr-ready": {
    id: "#41",
    title: "Empty states: one consistent treatment",
    workspace: "cogwork",
    stateLabel: "Ready to merge",
    stateTone: "ready",
    running: false,
    nowLine: null,
    triage: null,
    pr: {
      number: 44,
      url: "https://github.com/colonylabs/cogwork/pull/44",
      checks: "passing",
      review: "ready",
      baseDivergence: "none",
      waitingSinceMillis: now - 95 * MIN,
    },
    blockers: [],
    attempts: [
      {
        stage: "implement",
        outcome: "succeeded",
        atMillis: now - 100 * MIN,
        summary: "Wired the shared Empty primitive; opened PR #44.",
      },
    ],
    meta: {
      branch: "19-empty-states-consistent",
      session: "sess_77c3e2",
      harness: "cursor-acp",
      totalTokens: 22_400,
      startedAtMillis: now - 130 * MIN,
      endedAtMillis: now - 96 * MIN,
    },
    transcript: doneTranscript,
  },
  blocked: {
    id: "#27",
    title: "Activity tab: two-zone layout",
    workspace: "cogwork",
    stateLabel: "Blocked · 2 open blockers",
    stateTone: "blocked",
    running: false,
    nowLine: null,
    triage: null,
    pr: {
      number: 39,
      url: "https://github.com/colonylabs/cogwork/pull/39",
      checks: "pending",
      review: "changes-requested",
      baseDivergence: "conflict",
      waitingSinceMillis: now - 220 * MIN,
    },
    blockers: [
      "#14 Raw activity as a side panel tab — design not yet built",
      "Prefactor: unified renderer event source not landed",
    ],
    attempts: [
      {
        stage: "implement",
        outcome: "abandoned",
        atMillis: now - 210 * MIN,
        summary: "Paused pending the prefactor.",
      },
    ],
    meta: {
      branch: "27-activity-tab-two-zone",
      session: null,
      harness: "cursor-acp",
      totalTokens: 5_100,
      startedAtMillis: now - 260 * MIN,
      endedAtMillis: now - 208 * MIN,
    },
    transcript: doneTranscript,
  },
};

// ---------------------------------------------------------------------------
// Shared presentational pieces (composed differently by each variant)
// ---------------------------------------------------------------------------

const toneBadge: Record<MockItem["stateTone"], string> = {
  live: "bg-primary/15 text-primary",
  attention: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  ready: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  blocked: "bg-muted text-muted-foreground",
};

function StateBadge({ item }: { item: MockItem }) {
  return (
    <span
      className={cn(
        // w-fit + self-start so the chip hugs its text instead of stretching to
        // the container width (jarring in the full-width panel view).
        "inline-flex w-fit items-center gap-1.5 self-start rounded-full px-2 py-0.5 text-xs font-medium",
        toneBadge[item.stateTone],
      )}
    >
      {item.running && <RiPulseLine className="size-3.5 animate-pulse" />}
      {item.stateLabel}
    </span>
  );
}

function IdentityHeader({ item, compact }: { item: MockItem; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{item.id}</span>
        <span aria-hidden>·</span>
        <span>{item.workspace}</span>
      </div>
      <h1 className={cn("font-semibold", compact ? "text-sm" : "text-base")}>{item.title}</h1>
      <StateBadge item={item} />
    </div>
  );
}

// Equal-weight action buttons — no single AI-chosen primary action (#13).
function ActionBar({ item }: { item: MockItem }) {
  const actions: ReactNode[] = [];
  if (item.running) {
    actions.push(
      <Button key="cancel" size="sm" variant="outline">
        <RiStopCircleLine data-icon="inline-start" />
        Cancel &amp; park
      </Button>,
    );
  }
  if (item.triage) {
    actions.push(
      <Button key="approve" size="sm" variant="outline">
        Approve
      </Button>,
      <Button key="reclassify" size="sm" variant="outline">
        Reclassify
      </Button>,
    );
  }
  if (item.pr) {
    actions.push(
      <Button
        key="pr"
        size="sm"
        variant="outline"
        render={<a href={item.pr.url} rel="noreferrer" target="_blank" />}
      >
        Open on GitHub
        <RiExternalLinkLine data-icon="inline-end" />
      </Button>,
    );
  }
  if (actions.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-2">{actions}</div>;
}

function TriageBlock({ triage }: { triage: NonNullable<MockItem["triage"]> }) {
  return (
    <div className="flex flex-col gap-2">
      <Badge variant="outline">{triage.reason}</Badge>
      <p className="rounded-md bg-muted/50 p-2 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
        <span className="mr-1.5 rounded bg-amber-500/20 px-1 py-0.5 text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400">
          AI suggestion
        </span>
        {triage.proposal}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline">
          Approve
        </Button>
        <Button size="sm" variant="outline">
          Reclassify
        </Button>
      </div>
    </div>
  );
}

function PullRequestBlock({ pr }: { pr: MockPr }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>PR #{pr.number}</span>
        <span aria-hidden>·</span>
        <span>waiting {relativeTime(pr.waitingSinceMillis)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <PrChecksBadge checks={pr.checks} />
        <PrReviewBadge review={pr.review} />
        <PrDivergenceBadge divergence={pr.baseDivergence} />
      </div>
      <Button size="sm" variant="outline" render={<a href={pr.url} rel="noreferrer" target="_blank" />}>
        Open on GitHub
        <RiExternalLinkLine data-icon="inline-end" />
      </Button>
    </div>
  );
}

function PrChips({ pr }: { pr: MockPr }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">PR #{pr.number}</span>
      <PrChecksBadge checks={pr.checks} />
      <PrReviewBadge review={pr.review} />
      <PrDivergenceBadge divergence={pr.baseDivergence} />
    </div>
  );
}

function BlockersBlock({ blockers }: { blockers: ReadonlyArray<string> }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {blockers.map((b) => (
        <li key={b} className="flex items-start gap-2 text-xs text-muted-foreground">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
          {b}
        </li>
      ))}
    </ul>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-foreground">{value}</span>
    </div>
  );
}

function MetadataBlock({ meta }: { meta: MockMeta }) {
  return (
    <div className="flex flex-col gap-1.5">
      <MetaRow label="Branch" value={meta.branch ?? "—"} />
      <MetaRow label="Session" value={meta.session ?? "—"} />
      <MetaRow label="Harness" value={meta.harness} />
      <MetaRow label="Tokens" value={meta.totalTokens ? meta.totalTokens.toLocaleString() : "—"} />
      <MetaRow label="Started" value={relativeTime(meta.startedAtMillis)} />
      <MetaRow label="Ended" value={meta.endedAtMillis ? relativeTime(meta.endedAtMillis) : "—"} />
    </div>
  );
}

const attemptTone: Record<MockAttempt["outcome"], string> = {
  succeeded: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  abandoned: "text-muted-foreground",
};

function PreviousAttemptsBlock({ attempts }: { attempts: ReadonlyArray<MockAttempt> }) {
  if (attempts.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No previous attempts.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {attempts.map((a) => (
        <li key={a.atMillis} className="flex flex-col gap-0.5 text-xs">
          <div className="flex items-center gap-2">
            <span className={cn("font-medium capitalize", attemptTone[a.outcome])}>{a.outcome}</span>
            <span className="text-muted-foreground">{a.stage}</span>
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
            <span className="text-muted-foreground">{relativeTime(a.atMillis)}</span>
          </div>
          <p className="text-muted-foreground">{a.summary}</p>
        </li>
      ))}
    </ul>
  );
}

// ---- Run transcript (Conversation + Now, representative only — see #11) ----

function StepRow({ row }: { row: Extract<Row, { kind: "reasoning" | "tool" | "diff" }> }) {
  const label = row.kind === "reasoning" ? "Reasoning" : row.kind === "tool" ? row.name : row.path;
  const preview = row.kind === "reasoning" ? row.text : row.kind === "tool" ? row.preview : row.stat;
  const detail = row.kind === "reasoning" ? row.text : row.detail;
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent/60">
        <span
          className={cn(
            "shrink-0 rounded px-1 py-0.5 text-[10px] font-medium uppercase",
            row.kind === "diff" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          {row.kind}
        </span>
        <span className="shrink-0 font-mono font-medium">{label}</span>
        <span className="truncate text-muted-foreground">{preview}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 ml-2 overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
          {detail}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Collapse a run of consecutive step rows behind a "+N previous" toggle,
// keeping only the last one visible — the #11 folding behavior, in miniature.
function StepGroup({ rows }: { rows: ReadonlyArray<Extract<Row, { kind: "reasoning" | "tool" | "diff" }>> }) {
  const [open, setOpen] = useState(false);
  if (rows.length <= 2) {
    return (
      <div className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <StepRow key={r.id} row={r} />
        ))}
      </div>
    );
  }
  const hidden = rows.slice(0, -1);
  const last = rows[rows.length - 1];
  return (
    <div className="flex flex-col gap-0.5">
      {open ? (
        hidden.map((r) => <StepRow key={r.id} row={r} />)
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="self-start rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          + {hidden.length} previous steps
        </button>
      )}
      <StepRow row={last} />
    </div>
  );
}

function Transcript({ rows }: { rows: ReadonlyArray<Row> }) {
  // Group consecutive non-text rows so folds match the #11 design.
  const groups: Array<{ kind: "text"; row: Row } | { kind: "steps"; rows: Row[] }> = [];
  for (const row of rows) {
    if (row.kind === "text") {
      groups.push({ kind: "text", row });
    } else {
      const last = groups[groups.length - 1];
      if (last && last.kind === "steps") last.rows.push(row);
      else groups.push({ kind: "steps", rows: [row] });
    }
  }
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group, i) =>
        group.kind === "text" ? (
          <p key={i} className="text-sm leading-relaxed whitespace-pre-wrap">
            {(group.row as Extract<Row, { kind: "text" }>).text}
          </p>
        ) : (
          <StepGroup
            key={i}
            rows={group.rows as Array<Extract<Row, { kind: "reasoning" | "tool" | "diff" }>>}
          />
        ),
      )}
    </div>
  );
}

function NowBanner({ item, className }: { item: MockItem; className?: string }) {
  if (!item.running || !item.nowLine) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs",
        className,
      )}
    >
      <RiPulseLine className="size-4 shrink-0 animate-pulse text-primary" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-primary">Now</span>
        <span className="mx-1.5 text-muted-foreground">·</span>
        <span className="font-mono text-foreground">{item.nowLine}</span>
        <span className="ml-0.5 inline-block h-3 w-1 translate-y-0.5 animate-pulse bg-primary" aria-hidden />
      </span>
      <span className="shrink-0 text-muted-foreground">{elapsed(item.meta.startedAtMillis)}</span>
    </div>
  );
}

function TranscriptEmpty() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No live run</EmptyTitle>
        <EmptyDescription>The latest completed run is shown below.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>;
}

// A thin collapsible banner used by variant A.
function Banner({
  title,
  tone,
  defaultOpen,
  children,
}: {
  title: string;
  tone?: "attention" | "blocked";
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <div
        className={cn(
          "rounded-md border",
          tone === "attention" && "border-amber-500/30 bg-amber-500/5",
          tone === "blocked" && "border-border bg-muted/30",
          !tone && "border-border",
        )}
      >
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-accent/40">
          <span>{title}</span>
          <RiArrowRightLine className="size-3.5 shrink-0 text-muted-foreground transition-transform [[data-panel-open]_&]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pt-1 pb-3">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Variant A — single scroll column
// ---------------------------------------------------------------------------

function VariantA({ item }: { item: MockItem }) {
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-4">
        <IdentityHeader item={item} compact />
        <ActionBar item={item} />

        <div className="flex flex-col gap-2">
          {item.triage && (
            <Banner title="Triage — needs a decision" tone="attention" defaultOpen>
              <TriageBlock triage={item.triage} />
            </Banner>
          )}
          {item.pr && (
            <Banner title={`Pull request · #${item.pr.number}`}>
              <PullRequestBlock pr={item.pr} />
            </Banner>
          )}
          {item.blockers.length > 0 && (
            <Banner title={`Blockers · ${item.blockers.length}`} tone="blocked" defaultOpen>
              <BlockersBlock blockers={item.blockers} />
            </Banner>
          )}
          <Banner title="Previous attempts">
            <PreviousAttemptsBlock attempts={item.attempts} />
          </Banner>
          <Banner title="Metadata">
            <MetadataBlock meta={item.meta} />
          </Banner>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <SectionLabel>{item.running ? "Live run" : "Latest run"}</SectionLabel>
            {item.running && <span className="text-xs text-primary">focal</span>}
          </div>
          {item.running ? <NowBanner item={item} className="sticky top-0 z-10" /> : <TranscriptEmpty />}
          <Transcript rows={item.transcript} />
        </div>
      </div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// Variant B — sub-tabs (Main | Live run | Pull request)
// ---------------------------------------------------------------------------

type SubTab = "main" | "run" | "pr";

function SubTabStrip({
  tabs,
  active,
  onSelect,
  runLive,
}: {
  tabs: ReadonlyArray<{ key: SubTab; label: string }>;
  active: SubTab;
  onSelect: (key: SubTab) => void;
  runLive: boolean;
}) {
  return (
    <div className="flex items-center gap-1 border-b px-3 py-2">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onSelect(tab.key)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
            active === tab.key
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {tab.label}
          {tab.key === "run" && runLive && (
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
          )}
        </button>
      ))}
    </div>
  );
}

function VariantB({ item }: { item: MockItem }) {
  const [active, setActive] = useState<SubTab>("main");
  const tabs: Array<{ key: SubTab; label: string }> = [
    { key: "main", label: "Main" },
    { key: "run", label: "Live run" },
    ...(item.pr ? [{ key: "pr" as const, label: "Pull request" }] : []),
  ];
  const showTab = tabs.some((t) => t.key === active) ? active : "main";

  return (
    <div className="flex h-full flex-col">
      <SubTabStrip tabs={tabs} active={showTab} onSelect={setActive} runLive={item.running} />
      <ScrollArea className="min-h-0 flex-1">
        {showTab === "main" && (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
            <IdentityHeader item={item} compact />
            <ActionBar item={item} />
            {item.running && (
              <button
                type="button"
                onClick={() => setActive("run")}
                className="flex w-fit max-w-full items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-left text-xs hover:bg-primary/10"
              >
                <RiPulseLine className="size-4 shrink-0 animate-pulse text-primary" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-primary">Agent is running.</span>{" "}
                  <span className="text-muted-foreground">{item.nowLine}</span>
                </span>
                <span className="flex shrink-0 items-center gap-0.5 font-medium text-primary">
                  View live run <RiArrowRightLine className="size-3.5" />
                </span>
              </button>
            )}
            {item.triage && (
              <div className="flex flex-col gap-2">
                <SectionLabel>Triage</SectionLabel>
                <TriageBlock triage={item.triage} />
              </div>
            )}
            {item.blockers.length > 0 && (
              <div className="flex flex-col gap-2">
                <SectionLabel>Blockers</SectionLabel>
                <BlockersBlock blockers={item.blockers} />
              </div>
            )}
            {item.pr && (
              <div className="flex flex-col gap-2">
                <SectionLabel>Pull request</SectionLabel>
                <PrChips pr={item.pr} />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <SectionLabel>Previous attempts</SectionLabel>
              <PreviousAttemptsBlock attempts={item.attempts} />
            </div>
            <div className="flex flex-col gap-2">
              <SectionLabel>Metadata</SectionLabel>
              <MetadataBlock meta={item.meta} />
            </div>
          </div>
        )}
        {showTab === "run" && (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
            {item.running ? <NowBanner item={item} /> : <TranscriptEmpty />}
            <Transcript rows={item.transcript} />
          </div>
        )}
        {showTab === "pr" && item.pr && (
          <div className="mx-auto w-full max-w-3xl p-4">
            <PullRequestBlock pr={item.pr} />
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variant C — split (fixed context rail over a self-scrolling transcript)
// ---------------------------------------------------------------------------

function VariantC({ item }: { item: MockItem }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-3 border-b p-4">
        <IdentityHeader item={item} compact />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {item.pr && <PrChips pr={item.pr} />}
          {item.blockers.length > 0 && (
            <span className="text-xs text-muted-foreground">{item.blockers.length} open blockers</span>
          )}
          <span className="text-xs text-muted-foreground">
            <RiGitBranchLine className="mr-1 inline size-3.5 align-text-bottom" />
            {item.meta.branch ?? "no branch"}
          </span>
        </div>
        <ActionBar item={item} />
        {item.triage && (
          <Collapsible defaultOpen>
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md bg-amber-500/5 px-2 py-1.5 text-left text-xs font-medium text-amber-700 dark:text-amber-400">
              Triage — needs a decision
              <RiArrowRightLine className="size-3.5 transition-transform [[data-panel-open]_&]:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-2">
                <TriageBlock triage={item.triage} />
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-1.5">
          <SectionLabel>{item.running ? "Live run" : "Latest run"}</SectionLabel>
          {item.running && <RiExpandDiagonalLine className="size-3.5 text-muted-foreground" />}
        </div>
        {item.running && <NowBanner item={item} className="mx-4 mt-3" />}
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            {item.running ? null : <TranscriptEmpty />}
            <Transcript rows={item.transcript} />
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage — mock side-panel frame + backdrop so density reads true
// ---------------------------------------------------------------------------

export type VariantKey = "a" | "b" | "c";

export const variantMeta: ReadonlyArray<{ key: VariantKey; name: string }> = [
  { key: "a", name: "Single column" },
  { key: "b", name: "Sub-tabs" },
  { key: "c", name: "Split" },
];

function VariantBody({ variant, item }: { variant: VariantKey; item: MockItem }) {
  if (variant === "a") return <VariantA item={item} />;
  if (variant === "b") return <VariantB item={item} />;
  return <VariantC item={item} />;
}

// Mimics the RightPanel tab strip so the variant is judged in context.
function PanelFrame({ item, children }: { item: MockItem; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col border-l bg-background">
      <div className="flex h-11 min-h-11 shrink-0 items-center gap-1 border-b px-2">
        <div className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2 text-xs text-foreground">
          <span className="font-mono">{item.id}</span>
          <RiCloseLine className="size-3 text-muted-foreground" />
        </div>
        <div className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground">
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

function FakeMainColumn() {
  return (
    <div className="flex h-full flex-col gap-3 p-6 opacity-40 select-none" aria-hidden>
      <div className="h-6 w-32 rounded bg-muted" />
      <div className="mt-2 h-24 rounded-lg border bg-card" />
      <div className="h-9 w-full rounded bg-muted/60" />
      <div className="h-9 w-full rounded bg-muted/60" />
      <div className="h-9 w-full rounded bg-muted/60" />
      <div className="h-9 w-full rounded bg-muted/60" />
    </div>
  );
}

export function ItemTabStage({
  variant,
  scenario,
  full,
}: {
  variant: VariantKey;
  scenario: ScenarioKey;
  full: boolean;
}) {
  const item = items[scenario];
  if (full) {
    return (
      <div className="h-full">
        <PanelFrame item={item}>
          <VariantBody variant={variant} item={item} />
        </PanelFrame>
      </div>
    );
  }
  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1">
        <FakeMainColumn />
      </div>
      <div className="w-[440px] shrink-0">
        <PanelFrame item={item}>
          <VariantBody variant={variant} item={item} />
        </PanelFrame>
      </div>
    </div>
  );
}
