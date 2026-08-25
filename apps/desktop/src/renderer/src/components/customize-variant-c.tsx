// PROTOTYPE — Customize, Variant C: group by.
//
// The claim: **no filter modes, and no write mode either.** Everything is always on screen; one
// control chooses how it is grouped, and search narrows. Each row carries all three rungs as
// directly clickable cells, so a person never sets a mode before making a change — they click the
// rung they mean.
//
// The bet is that both filters were only ever compensating for a list that felt too long, and that
// grouping plus search solves that without ever hiding a value. The cost is row density.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowRightSLine, RiBox3Line, RiSearchLine } from "@remixicon/react";
import { useState } from "react";
import { draftCellAt, withDraft } from "../features/configuration-draft";
import {
  authorityLabel,
  type Contribution,
  contributionKinds,
  type DraftCell,
  kindLabelsPlural,
  type ScopeKind,
  type ScopeRef,
  scopeLabels,
  scopeOrder,
  scopeShortLabels,
  type WorkspaceId,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { cellPermitted, resolveEnablement } from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import { AuthorityBadge, DiagnosticBadge, kindIcons, ReadinessBadge } from "./configuration-atoms";
import { PluginsPanel } from "./configuration-plugins-panel";
import { useWorkspaceId, WorkspacePicker } from "./customize-atoms";

const { contributions, plugins } = placeholderConfiguration;

const groupings = ["kind", "rung", "plugin"] as const;
type Grouping = (typeof groupings)[number];

const groupingLabels: Record<Grouping, string> = {
  kind: "Kind",
  rung: "Rung",
  plugin: "Plugin",
};

const workspaceBound: readonly ScopeKind[] = ["workspace-input", "private-overlay"];

/** unset → on → off → unset. Three states, so a two-state control could never express it. */
function cycle(cell: DraftCell): DraftCell {
  if (cell === "unset") return "on";
  if (cell === "on") return "off";
  return "unset";
}

/** Every rung, directly clickable. No mode is set before a change is made. */
function RungCells({ contribution }: { contribution: Contribution }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);
  const workspaceId = useWorkspaceId();
  const resolved = resolveEnablement(withDraft(contribution, cells), { workspaceId });
  const failed = contribution.load._tag === "failed";

  return (
    <div className="flex items-center gap-1">
      {scopeOrder.map((kind) => {
        const scope: ScopeRef = workspaceBound.includes(kind) ? { kind, workspaceId } : { kind };
        const permitted = cellPermitted(contribution.kind, kind);
        const cell = permitted ? draftCellAt(contribution, scope, cells) : "unset";
        const wins = permitted && resolved.winner?.scope.kind === kind;

        const button = (
          <Button
            variant="outline"
            size="sm"
            disabled={!permitted || failed}
            className={cn("w-24 flex-col gap-0 py-1 h-auto", wins && "border-primary")}
            onClick={() => setCell(contribution.id, scope, cycle(cell))}
          >
            <span className="text-[10px] text-muted-foreground">{scopeShortLabels[kind]}</span>
            <span className="text-xs font-medium">
              {!permitted ? "not allowed" : cell === "unset" ? "not set" : cell}
            </span>
          </Button>
        );

        return (
          <Tooltip key={kind}>
            <TooltipTrigger render={<span />}>{button}</TooltipTrigger>
            <TooltipContent className="max-w-72">
              {permitted
                ? `${scopeLabels[kind]}${wins ? " — this is the value a Run gets" : ""}. Click to cycle on, off, not set.`
                : "A repository you cloned must not start a process on your machine. It may ship the file; it may not turn it on."}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ContributionRow({ contribution }: { contribution: Contribution }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const workspaceId = useWorkspaceId();
  const resolved = resolveEnablement(withDraft(contribution, cells), { workspaceId });
  const failed = contribution.load._tag === "failed";
  const Icon = kindIcons[contribution.kind];

  return (
    <Item variant="outline" className="items-start">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{contribution.localName}</span>
          <AuthorityBadge authority={contribution.authority} />
          {contribution.readiness ? <ReadinessBadge readiness={contribution.readiness} /> : null}
          {resolved.dropped.map((entry) => (
            <DiagnosticBadge key={entry.diagnostic._tag} diagnostic={entry.diagnostic} />
          ))}
          {failed ? <Badge variant="destructive">Failed to load</Badge> : null}
        </ItemTitle>
        <ItemDescription>{contribution.summary}</ItemDescription>
        {failed && contribution.load._tag === "failed" ? (
          <p className="mt-1 text-xs text-destructive">{contribution.load.reason}</p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {resolved.effective === undefined
              ? "Nothing written at any rung. Not off — not there."
              : `A Run gets ${resolved.effective ? "on" : "off"}.`}
          </p>
        )}
      </ItemContent>
      <ItemActions>
        <RungCells contribution={contribution} />
      </ItemActions>
    </Item>
  );
}

interface Group {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly rows: readonly Contribution[];
}

function groupRows(
  grouping: Grouping,
  rows: readonly Contribution[],
  workspaceId: WorkspaceId,
): readonly Group[] {
  if (grouping === "kind") {
    return contributionKinds
      .map((kind) => ({
        id: kind,
        label: kindLabelsPlural[kind],
        rows: rows.filter((contribution) => contribution.kind === kind),
      }))
      .filter((group) => group.rows.length > 0);
  }

  if (grouping === "plugin") {
    const byPlugin = plugins.map((plugin) => ({
      id: plugin.record.pluginId,
      label: plugin.name,
      detail: plugin.record.resolvedIdentity,
      rows: rows.filter(
        (contribution) =>
          contribution.authority._tag === "plugin" &&
          contribution.authority.pluginId === plugin.record.pluginId,
      ),
    }));
    const others = (["engine", "local"] as const).map((tag) => ({
      id: tag,
      label: tag === "engine" ? "Engine" : "This machine and this repository",
      detail: authorityLabel({ _tag: tag }),
      rows: rows.filter((contribution) => contribution.authority._tag === tag),
    }));
    return [...byPlugin, ...others].filter((group) => group.rows.length > 0);
  }

  // Group by the rung that *wins*, which is a question a filter cannot answer at all.
  const unwritten: Contribution[] = [];
  const byRung = new Map<ScopeKind, Contribution[]>(scopeOrder.map((kind) => [kind, []]));
  for (const contribution of rows) {
    const winner = resolveEnablement(contribution, { workspaceId }).winner;
    if (!winner) unwritten.push(contribution);
    else byRung.get(winner.scope.kind)?.push(contribution);
  }
  const written: Group[] = scopeOrder
    .map((kind) => ({
      id: kind as string,
      label: scopeLabels[kind],
      detail: "wins here",
      rows: byRung.get(kind) ?? [],
    }))
    .filter((group) => group.rows.length > 0);
  if (unwritten.length > 0) {
    written.push({
      id: "unwritten",
      label: "Nothing written",
      detail: "not off — not there",
      rows: unwritten,
    });
  }
  return written;
}

export function CustomizeVariantC() {
  const [grouping, setGrouping] = useState<Grouping>("kind");
  const [query, setQuery] = useState("");
  const cells = useConfigurationDraftStore((state) => state.cells);
  const workspaceId = useWorkspaceId();

  const needle = query.trim().toLowerCase();
  const rows = contributions
    .map((contribution) => withDraft(contribution, cells))
    .filter((contribution) =>
      needle === ""
        ? true
        : `${contribution.localName} ${contribution.summary} ${contribution.id}`
            .toLowerCase()
            .includes(needle),
    );
  const groups = groupRows(grouping, rows, workspaceId);

  return (
    <div className="flex flex-col gap-4">
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="outline" size="sm" className="w-full justify-start" />}>
          <RiBox3Line data-icon="inline-start" />
          Installed Plugins
          <Badge variant="ghost" className="ms-1 px-1">
            {plugins.length}
          </Badge>
          <RiArrowRightSLine data-icon="inline-end" className="ms-auto" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <PluginsPanel />
        </CollapsibleContent>
      </Collapsible>

      <div className="flex flex-wrap items-center gap-3">
        <InputGroup className="min-w-64 flex-1">
          <InputGroupInput
            placeholder="Search every contribution…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <InputGroupAddon>
            <RiSearchLine />
          </InputGroupAddon>
        </InputGroup>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Group by</span>
          <ToggleGroup
            value={[grouping]}
            onValueChange={(values) => {
              const next = values[0];
              if (next) setGrouping(next as Grouping);
            }}
            size="sm"
          >
            {groupings.map((option) => (
              <ToggleGroupItem key={option} value={option} aria-label={groupingLabels[option]}>
                {groupingLabels[option]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <WorkspacePicker />
      </div>

      <p className="text-xs text-muted-foreground">
        Nothing is filtered out. {rows.length} of {contributions.length} contributions shown, in{" "}
        {groups.length} {groups.length === 1 ? "group" : "groups"}. Every rung is editable from its row.
      </p>

      {groups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing matches</EmptyTitle>
            <EmptyDescription>No contribution matches this search.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.id} className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <h3 className="text-sm font-medium">{group.label}</h3>
                {group.detail ? <span className="text-xs text-muted-foreground">{group.detail}</span> : null}
                <Badge variant="ghost" className="px-1">
                  {group.rows.length}
                </Badge>
              </div>
              <ItemGroup className="gap-2">
                {group.rows.map((contribution) => (
                  <ContributionRow key={contribution.id} contribution={contribution} />
                ))}
              </ItemGroup>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
