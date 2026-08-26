import { buttonVariants } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiExternalLinkLine, RiGitPullRequestLine, RiQuestionAnswerLine } from "@remixicon/react";
import { useState } from "react";
import { useBoard } from "../features/activity-session";
import {
  type AttentionEntry,
  type AttentionKind,
  type AttentionKindFilter,
  attentionCounts,
  attentionEntries,
  filterAttention,
  type NeedsDecisionAttentionEntry,
  type ReadyToMergeAttentionEntry,
} from "../features/attention";
import { needsHumanReasonLabel, registeredWorkspaces } from "../features/feed";
import { relativeTime } from "../features/format";
import { useRightPanelStore } from "../store/right-panel";
import { FunnelFilter, useFunnelSelection } from "./funnel-filter";

const trackerLabel = (tracker: NeedsDecisionAttentionEntry["tracker"]) =>
  tracker === "linear" ? "Linear" : "GitHub";

const signalFor = (entry: AttentionEntry) => {
  if (entry.kind === "ready-to-merge") return `waiting ${relativeTime(entry.pr.waitingSinceMillis)}`;
  return needsHumanReasonLabel[entry.reason] ?? "needs a person";
};

function PrStatusDot({
  status,
}: {
  status: "passing" | "failing" | "pending" | "ready" | "changes-requested" | "conflict" | "clean" | "none";
}) {
  return (
    <span
      className={cn(
        "size-2 rounded-full",
        (status === "passing" || status === "ready") && "bg-success",
        (status === "failing" || status === "changes-requested" || status === "conflict") && "bg-destructive",
        (status === "pending" || status === "clean") && "bg-warning",
        status === "none" && "bg-muted-foreground/30",
      )}
    />
  );
}

function PrStatus({ entry, onOpen }: { entry: ReadyToMergeAttentionEntry; onOpen: () => void }) {
  const { checks, review, baseDivergence } = entry.pr;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Open ${entry.item.id}`}
            className="relative z-10 inline-flex items-center gap-1"
            onClick={onOpen}
          >
            <PrStatusDot status={checks} />
            <PrStatusDot status={review} />
            <PrStatusDot status={baseDivergence} />
          </button>
        }
      />
      <TooltipContent>{`checks ${checks} · review ${review} · base ${baseDivergence}`}</TooltipContent>
    </Tooltip>
  );
}

function KindMarker({ kind }: { kind: AttentionKind }) {
  if (kind === "needs-decision") {
    return (
      <>
        <span className="pointer-events-none h-8 w-0.5 shrink-0 rounded-full bg-warning" aria-hidden />
        <RiQuestionAnswerLine className="pointer-events-none size-4 shrink-0 text-warning" />
      </>
    );
  }
  return (
    <>
      <span className="pointer-events-none h-8 w-0.5 shrink-0 rounded-full bg-success" aria-hidden />
      <RiGitPullRequestLine className="pointer-events-none size-4 shrink-0 text-success" />
    </>
  );
}

function ReadyToMergeQuickOpen({ entry }: { entry: ReadyToMergeAttentionEntry }) {
  return (
    <a
      aria-label="Open PR on code host"
      className={buttonVariants({
        size: "icon-sm",
        variant: "ghost",
        className:
          "relative z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
      })}
      href={entry.pr.url}
      rel="noreferrer"
      target="_blank"
      onClick={(event) => event.stopPropagation()}
    >
      <RiExternalLinkLine />
    </a>
  );
}

function DecisionQuickOpen({ entry }: { entry: NeedsDecisionAttentionEntry }) {
  const label = `Open in ${trackerLabel(entry.tracker)}`;
  if (!entry.url) {
    return <span className="size-7 shrink-0" aria-hidden />;
  }
  return (
    <a
      aria-label={label}
      className={buttonVariants({
        size: "icon-sm",
        variant: "ghost",
        className:
          "relative z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
      })}
      href={entry.url}
      rel="noreferrer"
      target="_blank"
      onClick={(event) => event.stopPropagation()}
    >
      <RiExternalLinkLine />
    </a>
  );
}

function AttentionRow({ entry }: { entry: AttentionEntry }) {
  const openItem = useRightPanelStore((state) => state.openItem);
  const signal = signalFor(entry);
  return (
    <div className="group relative flex w-full items-center gap-3 py-2 pr-2 pl-0 hover:bg-muted/50">
      <button
        type="button"
        aria-label={`Open ${entry.item.id}`}
        className="absolute inset-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          event.stopPropagation();
          openItem(entry.workspace, entry.item.id);
        }}
      />
      <KindMarker kind={entry.kind} />
      <div className="pointer-events-none min-w-0 flex-1">
        <span className="block truncate text-sm">{entry.item.title}</span>
        <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <span>{entry.item.id}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{entry.workspace}</span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        {entry.kind === "ready-to-merge" && (
          <PrStatus entry={entry} onOpen={() => openItem(entry.workspace, entry.item.id)} />
        )}
        <span className="pointer-events-none w-28 truncate text-right" title={signal}>
          {signal}
        </span>
        {entry.kind === "ready-to-merge" ? (
          <ReadyToMergeQuickOpen entry={entry} />
        ) : (
          <DecisionQuickOpen entry={entry} />
        )}
      </div>
    </div>
  );
}

function AttentionContent({
  entries,
  workspaces,
}: {
  entries: ReadonlyArray<AttentionEntry>;
  workspaces: ReadonlyArray<string>;
}) {
  const [kind, setKind] = useState<AttentionKindFilter>("all");
  const workspace = useFunnelSelection();
  const counts = attentionCounts(entries);
  const rows = filterAttention(entries, kind, workspace.selected);
  const hasActiveFilters = kind !== "all" || workspace.selected.size > 0;
  const options = workspaces.map((name) => ({
    key: name,
    label: name,
    count: entries.filter((entry) => entry.workspace === name).length,
  }));

  return (
    <FunnelFilter.Provider
      value={{
        state: { options, selected: workspace.selected },
        actions: { toggle: workspace.toggle, clear: workspace.clear },
        meta: { ariaLabel: "Filter workspaces", resetLabel: "All workspaces" },
      }}
    >
      <div className="flex size-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <ToggleGroup
            spacing={0}
            value={[kind]}
            onValueChange={(next) => {
              const selection = next[0];
              if (selection === "all" || selection === "needs-decision" || selection === "ready-to-merge") {
                setKind(selection);
              }
            }}
          >
            <ToggleGroupItem value="all" variant="outline" size="sm" className="gap-1.5">
              All
              <span className="text-muted-foreground">{counts.all}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="needs-decision" variant="outline" size="sm" className="gap-1.5">
              Needs a decision
              <span className="text-muted-foreground">{counts["needs-decision"]}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="ready-to-merge" variant="outline" size="sm" className="gap-1.5">
              Ready to merge
              <span className="text-muted-foreground">{counts["ready-to-merge"]}</span>
            </ToggleGroupItem>
          </ToggleGroup>
          {workspaces.length > 1 && <FunnelFilter.Control />}
        </div>
        <FunnelFilter.Banner />
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <Empty className="p-6">
              <EmptyHeader>
                <EmptyTitle>
                  {hasActiveFilters
                    ? "No attention items match these filters."
                    : "Nothing needs a person right now."}
                </EmptyTitle>
                {hasActiveFilters && <EmptyDescription>Try a different kind or workspace.</EmptyDescription>}
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col divide-y px-3">
              {rows.map((entry) => (
                <AttentionRow key={`${entry.workspace}:${entry.item.id}`} entry={entry} />
              ))}
            </div>
          )}
        </div>
      </div>
    </FunnelFilter.Provider>
  );
}

export function AttentionList() {
  const result = useBoard();
  if (result._tag !== "Success") return null;
  const entries = attentionEntries(result.board);
  return <AttentionContent entries={entries} workspaces={registeredWorkspaces(result.board)} />;
}
