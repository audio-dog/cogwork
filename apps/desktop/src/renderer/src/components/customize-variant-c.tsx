// PROTOTYPE — Customize, Variant C: three columns.
//
// The mode is deleted rather than relocated. One column per level, side by side, so the ladder is
// taught by the layout before any label is read: three columns, left to right, and the one that
// wins is ringed. "Swapping levels" stops being an action — you move your cursor.
//
// The honest costs: a table is denser than a list and gives a contribution's own description less
// room, and the layout only survives because the ladder lost a rung. At four levels this would not fit.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { Separator } from "@cogwork/ui/components/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@cogwork/ui/components/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiBox3Line, RiSearchLine } from "@remixicon/react";
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

const cellText: Record<string, string> = { on: "On", off: "Off", unset: "—" };

function LevelCell({
  contribution,
  kind,
  wins,
}: {
  contribution: Contribution;
  kind: ScopeKind;
  wins: boolean;
}) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);
  const workspaceId = useWorkspaceId();

  const permitted = cellPermitted(contribution.kind, kind);
  const failed = contribution.load._tag === "failed";
  const scope = scopeAt(kind, workspaceId);
  const cell = permitted ? draftCellAt(contribution, scope, cells) : "unset";

  if (!permitted) {
    return (
      <TableCell className="text-center">
        <Tooltip>
          <TooltipTrigger
            render={<span className="inline-block cursor-help px-2 text-muted-foreground/60" />}
          >
            ✕
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            A {kindLabelsPlural[contribution.kind]} value may not be written at {scopeLabels[kind]}. A cloned
            repository may ship the file; it may never turn it on. This cell is empty by decision, not merely
            unset.
          </TooltipContent>
        </Tooltip>
      </TableCell>
    );
  }

  return (
    <TableCell className="text-center">
      <Button
        variant={cell === "unset" ? "ghost" : "outline"}
        size="sm"
        disabled={failed}
        onClick={() => setCell(contribution.id, scope, cycleCell(cell))}
        className={cn("w-20 justify-center", wins && "border-primary ring-1 ring-primary/40")}
      >
        {cellText[cell]}
      </Button>
    </TableCell>
  );
}

function ContributionRow({ contribution }: { contribution: Contribution }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const workspaceId = useWorkspaceId();
  const resolved = resolveEnablement(withDraft(contribution, cells), { workspaceId });
  const failed = contribution.load._tag === "failed";
  const Icon = kindIcons[contribution.kind];

  return (
    <TableRow>
      <TableCell className="max-w-80">
        <div className="flex items-start gap-2">
          <Icon />
          <div className="flex min-w-0 flex-col">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{contribution.localName}</span>
              <AuthorityBadge authority={contribution.authority} />
              {contribution.readiness ? <ReadinessBadge readiness={contribution.readiness} /> : null}
              {resolved.dropped.map((entry) => (
                <DiagnosticBadge key={entry.diagnostic._tag} diagnostic={entry.diagnostic} />
              ))}
              {failed ? <Badge variant="destructive">Failed to load</Badge> : null}
            </span>
            <span className="text-xs text-muted-foreground">{contribution.summary}</span>
            {failed && contribution.load._tag === "failed" ? (
              <span className="text-xs text-destructive">{contribution.load.reason}</span>
            ) : null}
          </div>
        </div>
      </TableCell>
      {scopeOrder.map((kind) => (
        <LevelCell
          key={kind}
          contribution={contribution}
          kind={kind}
          wins={resolved.winner?.scope.kind === kind}
        />
      ))}
      <TableCell className="text-center">
        {resolved.effective === undefined ? (
          <Tooltip>
            <TooltipTrigger render={<Badge variant="ghost" className="cursor-help" />}>
              nothing
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              Nothing is written at any level. That is not the same as off — a level that says nothing shadows
              nothing.
            </TooltipContent>
          </Tooltip>
        ) : (
          <Badge variant={resolved.effective ? "secondary" : "outline"}>
            {resolved.effective ? "On" : "Off"}
          </Badge>
        )}
      </TableCell>
    </TableRow>
  );
}

export function CustomizeVariantC() {
  const [facet, setFacet] = useState<Facet>("skill");
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
      <div className="flex flex-wrap items-center gap-3">
        <InputGroup className="min-w-64 flex-1">
          <InputGroupInput
            placeholder="Search contributions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <InputGroupAddon>
            <RiSearchLine />
          </InputGroupAddon>
        </InputGroup>
        <WorkspacePicker />
      </div>

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
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contribution</TableHead>
                  {scopeOrder.map((kind, index) => (
                    <TableHead key={kind} className="text-center">
                      <Tooltip>
                        <TooltipTrigger
                          render={<span className="inline-flex cursor-help flex-col items-center" />}
                        >
                          <span>{scopeShortLabels[kind]}</span>
                          <span className="text-[10px] font-normal text-muted-foreground">
                            {index + 1} of {scopeOrder.length}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-72">
                          <span className="font-medium">{scopeLabels[kind]}</span> — {scopeDescriptions[kind]}
                        </TooltipContent>
                      </Tooltip>
                    </TableHead>
                  ))}
                  <TableHead className="text-center">A Run gets</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((contribution) => (
                  <ContributionRow key={contribution.id} contribution={contribution} />
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Columns run low to high, left to right, and the higher level wins whole. Click a cell to cycle it
            through On, Off, and not set. The ringed cell is the one a Run actually reads.
          </p>
        </>
      )}
    </div>
  );
}
