// PROTOTYPE — split dropdown, menu C: segmented rows.
//
// No hierarchy and no columns. Each workspace is one row, and its two places are a pair of chips on
// the right of that row carrying their own state and count. Everything is visible on open and every
// place is one click, with no alignment grid to read across.
//
// It is the most compact of the three and the least abstract — a chip that says "Repo 1" is easier
// to read than a checkbox under a heading three rows up. What it gives up is the matrix's column
// action: there is no way to say "every repository" in one click, because there is no column.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Separator } from "@cogwork/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiCheckLine } from "@remixicon/react";
import { useState } from "react";
import {
  type ScopeKind,
  scopeDescriptions,
  scopeHints,
  scopeKey,
  scopeLabels,
  scopeShortLabels,
  type WorkspaceId,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { scopeIcons } from "./configuration-atoms";
import { CustomizePageShell, SplitPlacePill } from "./customize-atoms";
import {
  allPlaceKeys,
  countAt,
  type Facet,
  machinePlace,
  toggle,
  workspaceScopeKinds,
} from "./customize-places";

const { workspaces } = placeholderConfiguration;
const MachineIcon = scopeIcons["runtime-host"];

/** A place, its state and its count, in one clickable object. */
function PlaceChip({
  kind,
  workspaceId,
  checked,
  facet,
  onToggle,
}: {
  kind: ScopeKind;
  workspaceId?: WorkspaceId;
  checked: boolean;
  facet: Facet;
  onToggle: () => void;
}) {
  const place = workspaceId === undefined ? { kind } : { kind, workspaceId };
  const count = countAt(place, facet);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={checked ? "secondary" : "outline"}
            size="xs"
            className={cn("rounded-full", !checked && "text-muted-foreground")}
            onClick={onToggle}
          />
        }
      >
        {checked ? <RiCheckLine data-icon="inline-start" /> : null}
        {scopeShortLabels[kind]}
        <Badge variant="ghost" className="ms-1 px-1 text-[11px]">
          {count}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <span className="font-medium">{scopeLabels[kind]}</span> — {scopeHints[kind]}
      </TooltipContent>
    </Tooltip>
  );
}

function SegmentedMenu({
  places,
  facet,
  onChange,
}: {
  places: readonly string[];
  facet: Facet;
  onChange: (next: readonly string[]) => void;
}) {
  const machineKey = scopeKey(machinePlace);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <MachineIcon />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{scopeLabels["runtime-host"]}</span>
          <span className="text-xs text-muted-foreground">{scopeDescriptions["runtime-host"]}</span>
        </span>
        <PlaceChip
          kind="runtime-host"
          checked={places.includes(machineKey)}
          facet={facet}
          onToggle={() => onChange(toggle(places, machineKey))}
        />
      </div>

      <Separator />

      <div className="flex flex-col p-1">
        <span className="px-2 py-1.5 text-xs text-muted-foreground">Workspaces</span>
        {workspaces.map((workspace) => (
          <div key={workspace.id} className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">{workspace.name}</span>
              {/* The path, not the remote: two of these share one remote. */}
              <span className="truncate font-mono text-xs text-muted-foreground">
                {workspace.checkoutPath}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {workspaceScopeKinds.map((kind) => {
                const key = scopeKey({ kind, workspaceId: workspace.id });
                return (
                  <PlaceChip
                    key={kind}
                    kind={kind}
                    workspaceId={workspace.id}
                    checked={places.includes(key)}
                    facet={facet}
                    onToggle={() => onChange(toggle(places, key))}
                  />
                );
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CustomizeVariantC() {
  const [facet, setFacet] = useState<Facet>("skill");
  const [places, setPlaces] = useState<readonly string[]>(allPlaceKeys);
  const [query, setQuery] = useState("");

  return (
    <CustomizePageShell
      facet={facet}
      onFacet={setFacet}
      places={places}
      query={query}
      onQuery={setQuery}
      picker={
        <SplitPlacePill places={places} facet={facet} onSetAll={setPlaces} menuWidth="30rem">
          <SegmentedMenu places={places} facet={facet} onChange={setPlaces} />
        </SplitPlacePill>
      }
    />
  );
}
