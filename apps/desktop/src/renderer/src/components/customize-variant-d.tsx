// PROTOTYPE — Customize, Variant D: effective first.
//
// The mode is defused by demoting it. Most of the time a person wants one thing — "is this on?" —
// and every previous variant made them answer "at which level?" first. Here each row shows one
// switch and a chip saying where the value came from. The three levels appear only when a row is
// opened.
//
// The level a change lands at is a **preference**, set once at the top, not a mode flipped between
// clicks. That is the whole difference from Variant A's second row: same information, but it stops
// being something you operate.
//
// The third state survives without a third position on the switch: "not set" is reached by
// resetting to inherited, which is an action, not a control position.

import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@cogwork/ui/components/select";
import { Separator } from "@cogwork/ui/components/separator";
import { Switch } from "@cogwork/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowRightSLine, RiBox3Line, RiCloseLine, RiSearchLine } from "@remixicon/react";
import { useState } from "react";
import { cycleCell, draftCellAt, withDraft } from "../features/configuration-draft";
import {
  type Contribution,
  type ContributionKind,
  contributionKinds,
  kindLabelsPlural,
  type ScopeKind,
  type ScopeRef,
  scopeDescriptions,
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

type Facet = "plugins" | ContributionKind;

const { contributions } = placeholderConfiguration;

const workspaceBound: readonly ScopeKind[] = ["workspace-input", "private-overlay"];

function scopeAt(kind: ScopeKind, workspaceId: WorkspaceId): ScopeRef {
  return workspaceBound.includes(kind) ? { kind, workspaceId } : { kind };
}

const levelItems = Object.fromEntries(scopeOrder.map((kind) => [kind, scopeLabels[kind]]));

/** Named once, at the top, and then left alone. */
function LevelPreference({ value, onChange }: { value: ScopeKind; onChange: (kind: ScopeKind) => void }) {
  return (
    <Alert>
      <RiArrowRightSLine />
      <AlertTitle>Three levels, lowest first</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span className="flex flex-wrap items-center gap-1.5">
          {scopeOrder.map((kind, index) => (
            <span key={kind} className="flex items-center gap-1.5">
              {index > 0 ? <span className="text-muted-foreground">›</span> : null}
              <Tooltip>
                <TooltipTrigger render={<Badge variant="outline" className="cursor-help" />}>
                  {scopeLabels[kind]}
                </TooltipTrigger>
                <TooltipContent className="max-w-72">{scopeDescriptions[kind]}</TooltipContent>
              </Tooltip>
            </span>
          ))}
          <span className="text-xs text-muted-foreground">— the rightmost one that has a value wins.</span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs">Changes go to</span>
          <Select
            items={levelItems}
            value={value}
            onValueChange={(next) => onChange(String(next) as ScopeKind)}
          >
            <SelectTrigger size="sm" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {scopeOrder.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {scopeLabels[kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {workspaceBound.includes(value) ? <WorkspacePicker label="in" /> : null}
        </span>
      </AlertDescription>
    </Alert>
  );
}

/** The cascade for one row, on demand. Nobody sees this until they ask a question about levels. */
function RowCascade({ contribution }: { contribution: Contribution }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);
  const workspaceId = useWorkspaceId();
  const resolved = resolveEnablement(withDraft(contribution, cells), { workspaceId });

  return (
    <div className="mt-2 flex flex-col gap-1 rounded-lg border border-border p-2">
      {scopeOrder.map((kind) => {
        const permitted = cellPermitted(contribution.kind, kind);
        const scope = scopeAt(kind, workspaceId);
        const cell = permitted ? draftCellAt(contribution, scope, cells) : "unset";
        const wins = permitted && resolved.winner?.scope.kind === kind;
        return (
          <div
            key={kind}
            className={cn(
              "flex items-center gap-2 rounded px-2 py-1",
              wins && "bg-primary/5",
              !permitted && "opacity-60",
            )}
          >
            <span className="w-44 shrink-0 text-xs">{scopeLabels[kind]}</span>
            <span className="flex-1 text-xs text-muted-foreground">
              {!permitted
                ? "not allowed here — a cloned repository may ship the file, never enable it"
                : cell === "unset"
                  ? "nothing written"
                  : `written ${cell}`}
            </span>
            {wins ? <Badge variant="secondary">wins</Badge> : null}
            <Button
              variant="outline"
              size="xs"
              disabled={!permitted}
              className="w-16"
              onClick={() => setCell(contribution.id, scope, cycleCell(cell))}
            >
              {cell === "unset" ? "—" : cell}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function ContributionRow({ contribution, writeKind }: { contribution: Contribution; writeKind: ScopeKind }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);
  const workspaceId = useWorkspaceId();

  const resolved = resolveEnablement(withDraft(contribution, cells), { workspaceId });
  const failed = contribution.load._tag === "failed";
  const Icon = kindIcons[contribution.kind];

  const writable = cellPermitted(contribution.kind, writeKind);
  // When the preferred level cannot hold this kind, fall back to the lowest one that can.
  const targetKind = writable ? writeKind : scopeOrder.find((kind) => cellPermitted(contribution.kind, kind));
  const target = targetKind ? scopeAt(targetKind, workspaceId) : undefined;
  const writtenHere = target ? draftCellAt(contribution, target, cells) !== "unset" : false;
  const winner = resolved.winner;

  const provenance = !winner
    ? "not set anywhere"
    : targetKind && winner.scope.kind === targetKind
      ? `set at ${scopeShortLabels[winner.scope.kind]}`
      : `from ${scopeShortLabels[winner.scope.kind]}`;

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
        ) : null}

        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="xs" className="mt-1 w-fit ps-0" />}>
            Where is this set?
            <RiArrowRightSLine data-icon="inline-end" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <RowCascade contribution={contribution} />
          </CollapsibleContent>
        </Collapsible>
      </ItemContent>

      <ItemActions className="flex-col items-end gap-1.5">
        <Switch
          checked={resolved.effective === true}
          disabled={failed || target === undefined}
          onCheckedChange={(checked) => {
            if (target) setCell(contribution.id, target, checked ? "on" : "off");
          }}
        />
        <span className="flex items-center gap-1">
          <Badge variant={writtenHere ? "secondary" : "ghost"}>{provenance}</Badge>
          {writtenHere && target ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Reset to inherited"
                    onClick={() => setCell(contribution.id, target, "unset")}
                  />
                }
              >
                <RiCloseLine />
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                Reset to inherited. This clears the value rather than writing off — a level that says nothing
                shadows nothing.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </span>
        {!writable ? (
          <span className="max-w-52 text-end text-[11px] text-muted-foreground">
            {kindLabelsPlural[contribution.kind]} cannot be written at {scopeShortLabels[writeKind]}; this
            writes to {targetKind ? scopeShortLabels[targetKind] : "nowhere"}.
          </span>
        ) : null}
      </ItemActions>
    </Item>
  );
}

export function CustomizeVariantD() {
  const [facet, setFacet] = useState<Facet>("skill");
  const [writeKind, setWriteKind] = useState<ScopeKind>("private-overlay");
  const [query, setQuery] = useState("");

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
      <LevelPreference value={writeKind} onChange={setWriteKind} />

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
          onClick={() => setFacet("plugins")}
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
            onClick={() => setFacet(kind)}
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
      ) : visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No {kindLabelsPlural[facet]}</EmptyTitle>
            <EmptyDescription>Nothing matches this search.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {visible.map((contribution) => (
            <ContributionRow key={contribution.id} contribution={contribution} writeKind={writeKind} />
          ))}
        </ItemGroup>
      )}
    </div>
  );
}
