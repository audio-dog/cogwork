// PROTOTYPE — Customize, Variant B: location columns.
//
// The three-column idea, rebuilt without the ladder. The columns are three *places*, not three
// rungs, so nothing is indented and nothing implies an order — a row simply sits in the column it
// lives in, and you can scan a column to see everything that came from there.
//
// The layout also teaches the one rule that survives from ADR 0013 for free: when a repository
// ships a Hook it cannot enable, the "ships here" marker and the switch land in *different
// columns*, with an arrow between them. Offer-versus-enable stops being a paragraph.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { Switch } from "@cogwork/ui/components/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@cogwork/ui/components/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowRightLine, RiSearchLine } from "@remixicon/react";
import { useState } from "react";
import { draftCellAt, withDraft } from "../features/configuration-draft";
import {
  type Contribution,
  type ScopeKind,
  scopeDescriptions,
  scopeLabels,
  scopeOrder,
} from "../features/configuration-model";
import { enableScopeFor, resolveEnablement, settingsSpreadAcross } from "../features/configuration-resolve";
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
import { definedAtCount, type Facet, visibleContributions } from "./customize-filter";
import { KindPills } from "./customize-kind-pills";

const workspaceBound: readonly ScopeKind[] = ["workspace-input", "private-overlay"];

function ContributionRow({ contribution }: { contribution: Contribution }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);
  const workspaceId = useWorkspaceId();

  const edited = withDraft(contribution, cells);
  const resolved = resolveEnablement(edited, { workspaceId });
  const target = enableScopeFor(contribution, workspaceId);
  const spread = settingsSpreadAcross(edited, { workspaceId });
  const failed = contribution.load._tag === "failed";
  const Icon = kindIcons[contribution.kind];
  const on = target ? draftCellAt(contribution, target, cells) === "on" : resolved.effective === true;
  const splitRow = target !== undefined && target.kind !== contribution.definedAt;

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
              {spread.length > 0 ? <Badge variant="secondary">set in {spread.length} places</Badge> : null}
            </span>
            <span className="text-xs text-muted-foreground">{contribution.summary}</span>
            <span className="font-mono text-[11px] text-muted-foreground/80">{contribution.file}</span>
          </div>
        </div>
      </TableCell>

      {scopeOrder.map((kind) => {
        const lives = contribution.definedAt === kind;
        const enablesHere = target?.kind === kind;

        return (
          <TableCell key={kind} className="text-center align-middle">
            {lives && !enablesHere ? (
              // Ships here, cannot be turned on here. The gap between the two cells is the rule.
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex cursor-help items-center gap-1" />}>
                  <Badge variant="outline">ships here</Badge>
                  <RiArrowRightLine className="size-3 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent className="max-w-80">
                  A repository you cloned may ship this file but may never start a process on your machine, so
                  it is turned on in {target ? scopeLabels[target.kind] : "your overlay"}.
                </TooltipContent>
              </Tooltip>
            ) : enablesHere ? (
              <span className="inline-flex flex-col items-center gap-0.5">
                <Switch
                  checked={on}
                  disabled={failed}
                  onCheckedChange={(checked) => {
                    if (target) setCell(contribution.id, target, checked ? "on" : "off");
                  }}
                />
                {splitRow ? <span className="text-[10px] text-muted-foreground">turned on here</span> : null}
              </span>
            ) : (
              <span className="text-muted-foreground/30">·</span>
            )}
          </TableCell>
        );
      })}
    </TableRow>
  );
}

export function CustomizeVariantB() {
  const [facet, setFacet] = useState<Facet>("skill");
  const [places, setPlaces] = useState<readonly ScopeKind[]>(scopeOrder);
  const [query, setQuery] = useState("");

  const toggle = (kind: ScopeKind) =>
    setPlaces((current) =>
      current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind],
    );

  const visible = visibleContributions(facet, places, query);
  const showWorkspace = places.some((kind) => workspaceBound.includes(kind));

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
        {showWorkspace ? <WorkspacePicker /> : null}
      </div>

      <KindPills facet={facet} places={places} onSelect={setFacet} />

      {facet === "plugins" ? (
        <PluginsPanel />
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contribution</TableHead>
                  {/* The header is the filter. One object, so there is nothing extra to learn. */}
                  {scopeOrder.map((kind) => {
                    const Icon = scopeIcons[kind];
                    const checked = places.includes(kind);
                    return (
                      <TableHead key={kind} className="text-center">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant={checked ? "secondary" : "ghost"}
                                size="sm"
                                className={cn("mx-auto", !checked && "text-muted-foreground/60")}
                                onClick={() => toggle(kind)}
                              />
                            }
                          >
                            <Icon />
                            {scopeLabels[kind]}
                            <Badge variant="ghost" className="ms-1 px-1">
                              {definedAtCount(kind, facet)}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-72">
                            {scopeDescriptions[kind]} Click to {checked ? "hide" : "show"} it.
                          </TooltipContent>
                        </Tooltip>
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((contribution) => (
                  <ContributionRow key={contribution.id} contribution={contribution} />
                ))}
              </TableBody>
            </Table>
          </div>

          {visible.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Nothing here</EmptyTitle>
                <EmptyDescription>
                  {places.length === 0
                    ? "No column is selected, so nothing can show."
                    : "Nothing of this kind lives in the selected places."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <p className="text-xs text-muted-foreground">
              A row sits in the column it lives in. The columns are three places, not an order — click a
              heading to show or hide that place.
            </p>
          )}
        </>
      )}
    </div>
  );
}
