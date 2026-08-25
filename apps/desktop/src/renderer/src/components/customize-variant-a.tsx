// PROTOTYPE — split dropdown, menu A: the matrix.
//
// The drill-in dies because the hierarchy does. One row per workspace, and the two places become
// two aligned checkbox columns, so every place on the machine is visible and one click away the
// moment the menu opens. No workspace has to be "selected" to reveal anything.
//
// It also buys something no other shape here can offer: the column headings toggle a whole column,
// so "every repository, none of my private overlays" is one click. That is a real question — it is
// the difference between what your team shares and what only you have.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Checkbox } from "@cogwork/ui/components/checkbox";
import { Label } from "@cogwork/ui/components/label";
import { Separator } from "@cogwork/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { useState } from "react";
import {
  scopeDescriptions,
  scopeHints,
  scopeKey,
  scopeLabels,
  scopeShortLabels,
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
  toggleColumn,
  workspaceScopeKinds,
} from "./customize-places";

const { workspaces } = placeholderConfiguration;
const MachineIcon = scopeIcons["runtime-host"];

function MatrixMenu({
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
      {/* The machine has no columns — it is one place. That is the split in the split menu. */}
      <Label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-accent">
        <MachineIcon />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{scopeLabels["runtime-host"]}</span>
          <span className="text-xs font-normal text-muted-foreground">{scopeHints["runtime-host"]}</span>
        </span>
        <Badge variant="ghost" className="px-1">
          {countAt(machinePlace, facet)}
        </Badge>
        <Checkbox
          checked={places.includes(machineKey)}
          onCheckedChange={() => onChange(toggle(places, machineKey))}
        />
      </Label>

      <Separator />

      <div className="flex flex-col p-1">
        {/* Column headings, which are also column toggles. */}
        <div className="flex items-end gap-2 px-2 pt-2 pb-1">
          <span className="flex-1 text-xs text-muted-foreground">Workspaces</span>
          {workspaceScopeKinds.map((kind) => (
            <Tooltip key={kind}>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    className="w-24 justify-center px-1"
                    onClick={() => onChange(toggleColumn(places, kind))}
                  />
                }
              >
                {scopeShortLabels[kind]}
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                {scopeDescriptions[kind]} Click to check or clear this column for every workspace.
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        {workspaces.map((workspace) => (
          <div key={workspace.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">{workspace.name}</span>
              {/* The path, not the remote: two of these share one remote. */}
              <span className="truncate font-mono text-xs text-muted-foreground">
                {workspace.checkoutPath}
              </span>
            </span>
            {workspaceScopeKinds.map((kind) => {
              const place = { kind, workspaceId: workspace.id };
              const key = scopeKey(place);
              const count = countAt(place, facet);
              return (
                <Label
                  key={kind}
                  className={cn(
                    "flex w-24 cursor-pointer items-center justify-center gap-1.5 rounded px-1 py-1",
                    "hover:bg-background",
                  )}
                >
                  <Badge variant="ghost" className="px-1 text-[11px]">
                    {count}
                  </Badge>
                  <Checkbox
                    checked={places.includes(key)}
                    onCheckedChange={() => onChange(toggle(places, key))}
                  />
                </Label>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CustomizeVariantA() {
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
          <MatrixMenu places={places} facet={facet} onChange={setPlaces} />
        </SplitPlacePill>
      }
    />
  );
}
