// PROTOTYPE — Customize, Variant B: the layer rail.
//
// The mode is not removed here — it is given somewhere to live. Variant A's failure was a
// segmented control with no room to say what a level *means*, so the mode was both invisible and
// unexplained. A rail has room: each layer carries its name, its one-line meaning, how many values
// are written there, and how many of those actually win.
//
// The stack is drawn as a stack — indented, connected, low rung at the top — so the ladder is
// legible before a single word is read. The active layer's accent then follows you onto every row
// control, so "where am I writing" is answered at the point of action, not only at the top of the page.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
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
import { Separator } from "@cogwork/ui/components/separator";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowDownLine, RiBox3Line, RiSearchLine } from "@remixicon/react";
import { useState } from "react";
import { draftCellAt, withDraft } from "../features/configuration-draft";
import {
  type Contribution,
  type ContributionKind,
  contributionKinds,
  type DraftCell,
  kindLabelsPlural,
  type ScopeKind,
  type ScopeRef,
  scopeDescriptions,
  scopeLabels,
  scopeOrder,
  scopeShortLabels,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { cellPermitted, resolveEnablement, scopeTally } from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import {
  AuthorityBadge,
  DiagnosticBadge,
  kindIcons,
  ReadinessBadge,
  scopeIcons,
} from "./configuration-atoms";
import { PluginsPanel } from "./configuration-plugins-panel";
import { useWorkspaceId, WorkspacePicker } from "./customize-atoms";

type Facet = "plugins" | ContributionKind;

const { contributions } = placeholderConfiguration;

const workspaceBound: readonly ScopeKind[] = ["workspace-input", "private-overlay"];

function scopeAt(kind: ScopeKind, workspaceId: string): ScopeRef {
  return workspaceBound.includes(kind) ? { kind, workspaceId: workspaceId as never } : { kind };
}

/** One layer in the rail. Indent grows with the rung, so the stack reads as a stack. */
function LayerCard({
  kind,
  index,
  active,
  facet,
  onSelect,
}: {
  kind: ScopeKind;
  index: number;
  active: boolean;
  facet: Facet;
  onSelect: () => void;
}) {
  const workspaceId = useWorkspaceId();
  const cells = useConfigurationDraftStore((state) => state.cells);
  const edited = contributions.map((contribution) => withDraft(contribution, cells));
  const tally = scopeTally(edited, scopeAt(kind, workspaceId), { workspaceId });
  const Icon = scopeIcons[kind];
  const applies = facet === "plugins" || cellPermitted(facet, kind);

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!applies}
      style={{ marginInlineStart: `${index * 0.75}rem` }}
      className={cn(
        "flex flex-col gap-1 rounded-lg border p-3 text-start transition-colors",
        active ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
        !applies && "opacity-50",
      )}
    >
      <span className="flex items-center gap-2">
        <Icon />
        <span className="text-sm font-medium">{scopeLabels[kind]}</span>
        {active ? <Badge className="ms-auto">editing</Badge> : null}
      </span>
      <span className="text-xs text-muted-foreground">{scopeDescriptions[kind]}</span>
      <span className="mt-1 flex items-center gap-1.5">
        {applies ? (
          <>
            <Badge variant="outline">{tally.written} set here</Badge>
            <Badge variant={tally.winning > 0 ? "secondary" : "ghost"}>{tally.winning} winning</Badge>
          </>
        ) : (
          <Badge variant="ghost">not allowed for {kindLabelsPlural[facet as ContributionKind]}</Badge>
        )}
      </span>
    </button>
  );
}

function LayerRail({
  active,
  facet,
  onSelect,
}: {
  active: ScopeKind;
  facet: Facet;
  onSelect: (kind: ScopeKind) => void;
}) {
  return (
    <div className="flex w-72 shrink-0 flex-col gap-2 self-start">
      <span className="text-xs font-medium text-muted-foreground">Editing</span>
      <div className="flex flex-col gap-1.5">
        {scopeOrder.map((kind, index) => (
          <LayerCard
            key={kind}
            kind={kind}
            index={index}
            active={kind === active}
            facet={facet}
            onSelect={() => onSelect(kind)}
          />
        ))}
      </div>
      <span className="flex items-center gap-1 ps-1 text-xs text-muted-foreground">
        <RiArrowDownLine className="size-3" />
        more specific wins whole
      </span>
      {workspaceBound.includes(active) ? (
        <>
          <Separator className="my-1" />
          <WorkspacePicker label="in" />
        </>
      ) : null}
    </div>
  );
}

/** The other two rungs, small, so the active one stays the loud thing on the row. */
function InheritTrail({ contribution, active }: { contribution: Contribution; active: ScopeKind }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const workspaceId = useWorkspaceId();
  const resolved = resolveEnablement(withDraft(contribution, cells), { workspaceId });

  return (
    <span className="flex flex-wrap items-center gap-1">
      {scopeOrder
        .filter((kind) => kind !== active)
        .map((kind) => {
          const permitted = cellPermitted(contribution.kind, kind);
          const cell = permitted ? draftCellAt(contribution, scopeAt(kind, workspaceId), cells) : "unset";
          const wins = permitted && resolved.winner?.scope.kind === kind;
          return (
            <Tooltip key={kind}>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "rounded px-1 py-0.5 text-[11px]",
                      wins ? "bg-primary/10 text-foreground" : "text-muted-foreground",
                    )}
                  />
                }
              >
                {scopeShortLabels[kind]} {!permitted ? "✕" : cell === "unset" ? "—" : cell}
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                {permitted
                  ? `${scopeLabels[kind]}${wins ? " — this is the value a Run gets" : ""}`
                  : "A cloned repository may ship the file but may never turn it on."}
              </TooltipContent>
            </Tooltip>
          );
        })}
    </span>
  );
}

function ContributionRow({ contribution, active }: { contribution: Contribution; active: ScopeKind }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);
  const workspaceId = useWorkspaceId();

  const scope = scopeAt(active, workspaceId);
  const resolved = resolveEnablement(withDraft(contribution, cells), { workspaceId });
  const permitted = cellPermitted(contribution.kind, active);
  const cell = draftCellAt(contribution, scope, cells);
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
              ? "Nothing written at any layer. Not off — not there."
              : `A Run gets ${resolved.effective ? "on" : "off"}.`}
          </p>
        )}
      </ItemContent>
      <ItemActions className="flex-col items-end gap-1.5">
        <ToggleGroup
          value={[cell]}
          disabled={!permitted || failed}
          onValueChange={(values) => {
            const next = values[0];
            if (next) setCell(contribution.id, scope, next as DraftCell);
          }}
          size="sm"
          className={cn(permitted && "ring-1 ring-primary/40 rounded-lg")}
        >
          <ToggleGroupItem value="on" aria-label="On">
            On
          </ToggleGroupItem>
          <ToggleGroupItem value="off" aria-label="Off">
            Off
          </ToggleGroupItem>
          <ToggleGroupItem value="unset" aria-label="Not set">
            Not set
          </ToggleGroupItem>
        </ToggleGroup>
        <InheritTrail contribution={contribution} active={active} />
      </ItemActions>
    </Item>
  );
}

export function CustomizeVariantB() {
  const [facet, setFacet] = useState<Facet>("skill");
  const [active, setActive] = useState<ScopeKind>("runtime-host");
  const [query, setQuery] = useState("");

  // Selecting a kind the active layer cannot hold moves you to a layer that can, rather than
  // leaving every control disabled with no explanation.
  const selectFacet = (next: Facet) => {
    setFacet(next);
    if (next !== "plugins" && !cellPermitted(next, active)) setActive("runtime-host");
  };

  const needle = query.trim().toLowerCase();
  const visible = contributions
    .filter((contribution) => facet !== "plugins" && contribution.kind === facet)
    .filter((contribution) =>
      needle === ""
        ? true
        : `${contribution.localName} ${contribution.summary}`.toLowerCase().includes(needle),
    );

  return (
    <div className="flex flex-col gap-4">
      <InputGroup>
        <InputGroupInput
          placeholder="Search contributions…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <InputGroupAddon>
          <RiSearchLine />
        </InputGroupAddon>
      </InputGroup>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={facet === "plugins" ? "secondary" : "outline"}
          size="sm"
          className="rounded-full"
          onClick={() => selectFacet("plugins")}
        >
          <RiBox3Line data-icon="inline-start" />
          Plugins
        </Button>
        <Separator orientation="vertical" className="h-6" />
        {contributionKinds.map((kind) => (
          <Button
            key={kind}
            variant={facet === kind ? "secondary" : "outline"}
            size="sm"
            className="rounded-full"
            onClick={() => selectFacet(kind)}
          >
            {kindLabelsPlural[kind]}
            <Badge variant="ghost" className="ms-1 px-1">
              {contributions.filter((contribution) => contribution.kind === kind).length}
            </Badge>
          </Button>
        ))}
      </div>

      {facet === "plugins" ? (
        <PluginsPanel />
      ) : (
        <div className="flex min-h-0 gap-6">
          <LayerRail active={active} facet={facet} onSelect={setActive} />
          <div className="min-w-0 flex-1">
            {visible.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No {kindLabelsPlural[facet]}</EmptyTitle>
                  <EmptyDescription>Nothing matches this search.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup className="gap-2">
                {visible.map((contribution) => (
                  <ContributionRow key={contribution.id} contribution={contribution} active={active} />
                ))}
              </ItemGroup>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
