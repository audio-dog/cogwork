// PROTOTYPE — Customize, Variant A: two rows.
//
// The claim: **kind filters, Scope does not.** Scope is a ladder, so filtering by it answers the
// wrong question — a filter says what is visible, and ADR 0013's direction says what won. So the
// second row names the *write target* instead, always visible, and every row carries the whole
// three-rung ladder. Nothing about resolution is ever hidden behind a filter state.

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
import { RiBox3Line, RiSearchLine } from "@remixicon/react";
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
import { cellPermitted, resolveEnablement } from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import { AuthorityBadge, DiagnosticBadge, kindIcons, ReadinessBadge } from "./configuration-atoms";
import { PluginsPanel } from "./configuration-plugins-panel";
import { useWorkspaceId, WorkspacePicker } from "./customize-atoms";

type Facet = "plugins" | ContributionKind;

const { contributions } = placeholderConfiguration;

const workspaceBound: readonly ScopeKind[] = ["workspace-input", "private-overlay"];

/**
 * The whole ladder on every row. Three rungs, low to high, the winner marked. A cell the kind may
 * not be written at is not blank — it says so, because ADR 0013's empty cells are empty by decision.
 */
function ScopeLadder({
  contribution,
  resolvedWinnerKind,
  writeKind,
}: {
  contribution: Contribution;
  resolvedWinnerKind?: ScopeKind;
  writeKind: ScopeKind;
}) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const workspaceId = useWorkspaceId();

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {scopeOrder.map((kind, index) => {
        const scope: ScopeRef = workspaceBound.includes(kind) ? { kind, workspaceId } : { kind };
        const permitted = cellPermitted(contribution.kind, kind);
        const cell = permitted ? draftCellAt(contribution, scope, cells) : "unset";
        const wins = permitted && resolvedWinnerKind === kind;
        const label = scopeShortLabels[kind];

        const body = (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
              wins ? "border-primary text-foreground" : "border-border text-muted-foreground",
              kind === writeKind && "ring-1 ring-ring/50",
              !permitted && "opacity-60",
            )}
          >
            <span>{label}</span>
            <span className="font-medium">{!permitted ? "not allowed" : cell === "unset" ? "—" : cell}</span>
            {wins ? <span className="text-primary">wins</span> : null}
          </span>
        );

        return (
          <span key={kind} className="flex items-center gap-1">
            {index > 0 ? <span className="text-xs text-muted-foreground">›</span> : null}
            {permitted ? (
              body
            ) : (
              <Tooltip>
                <TooltipTrigger render={<span />}>{body}</TooltipTrigger>
                <TooltipContent className="max-w-72">
                  A repository you cloned must not start a process on your machine. It may still ship the
                  file; it may not turn it on.
                </TooltipContent>
              </Tooltip>
            )}
          </span>
        );
      })}
    </div>
  );
}

function ContributionRow({ contribution, writeKind }: { contribution: Contribution; writeKind: ScopeKind }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);
  const workspaceId = useWorkspaceId();

  const edited = withDraft(contribution, cells);
  const resolved = resolveEnablement(edited, { workspaceId });
  const writeScope: ScopeRef = workspaceBound.includes(writeKind)
    ? { kind: writeKind, workspaceId }
    : { kind: writeKind };
  const permitted = cellPermitted(contribution.kind, writeKind);
  const cell = draftCellAt(contribution, writeScope, cells);
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
        ) : null}
        <ScopeLadder
          contribution={contribution}
          resolvedWinnerKind={resolved.winner?.scope.kind}
          writeKind={writeKind}
        />
      </ItemContent>
      <ItemActions className="flex-col items-end gap-1">
        <ToggleGroup
          value={[cell]}
          disabled={!permitted || failed}
          onValueChange={(values) => {
            const next = values[0];
            if (next) setCell(contribution.id, writeScope, next as DraftCell);
          }}
          size="sm"
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
        <span className="text-xs text-muted-foreground">
          {permitted ? `writes to ${scopeShortLabels[writeKind]}` : "not writable here"}
        </span>
      </ItemActions>
    </Item>
  );
}

export function CustomizeVariantA() {
  const [facet, setFacet] = useState<Facet>("skill");
  const [writeKind, setWriteKind] = useState<ScopeKind>("runtime-host");
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

      {/* Row one — the only real filter on this page. */}
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
        {contributionKinds.map((kind) => {
          const count = contributions.filter((contribution) => contribution.kind === kind).length;
          return (
            <Button
              key={kind}
              variant={facet === kind ? "secondary" : "outline"}
              size="sm"
              className="rounded-full"
              onClick={() => setFacet(kind)}
            >
              {kindLabelsPlural[kind]}
              <Badge variant="ghost" className="ms-1 px-1">
                {count}
              </Badge>
            </Button>
          );
        })}
      </div>

      {facet === "plugins" ? (
        <PluginsPanel />
      ) : (
        <>
          {/* Row two — not a filter. Which rung a switch writes to. */}
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium">Editing</span>
              <ToggleGroup
                value={[writeKind]}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next) setWriteKind(next as ScopeKind);
                }}
                size="sm"
              >
                {scopeOrder.map((kind) => (
                  <ToggleGroupItem
                    key={kind}
                    value={kind}
                    aria-label={scopeLabels[kind]}
                    disabled={!cellPermitted(facet, kind)}
                  >
                    {scopeShortLabels[kind]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {workspaceBound.includes(writeKind) ? <WorkspacePicker label="in" /> : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {scopeDescriptions[writeKind]} Values at the other rungs stay visible on every row — this
              chooses where a change lands, not what you can see.
            </p>
          </div>

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
                <ContributionRow key={contribution.id} contribution={contribution} writeKind={writeKind} />
              ))}
            </ItemGroup>
          )}
        </>
      )}
    </div>
  );
}
