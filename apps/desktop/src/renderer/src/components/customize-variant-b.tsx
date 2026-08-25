// PROTOTYPE — split dropdown, menu B: two panes.
//
// The classic split menu, and the literal reading of "split dropdown". The left pane lists the
// machine and every workspace; the right pane shows whatever the pointer is resting on. Browsing
// costs no clicks at all — moving down the left pane reveals each workspace's places in turn — and
// a click is only ever spent on an actual change.
//
// It is the only shape here that scales: at twenty workspaces the left pane scrolls and the right
// pane stays the same size. The matrix would be twenty rows deep and the segmented list forty chips.
//
// The cost is that you see one workspace's places at a time, so "which of my repos is checked" takes
// a sweep down the pane rather than a glance.

import { Badge } from "@cogwork/ui/components/badge";
import { Checkbox } from "@cogwork/ui/components/checkbox";
import { Label } from "@cogwork/ui/components/label";
import { Separator } from "@cogwork/ui/components/separator";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowRightSLine } from "@remixicon/react";
import { useState } from "react";
import {
  scopeDescriptions,
  scopeHints,
  scopeKey,
  scopeLabels,
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

type Highlight = { readonly _tag: "machine" } | { readonly _tag: "workspace"; readonly id: WorkspaceId };

function TwoPaneMenu({
  places,
  facet,
  onChange,
}: {
  places: readonly string[];
  facet: Facet;
  onChange: (next: readonly string[]) => void;
}) {
  const [highlight, setHighlight] = useState<Highlight>({ _tag: "machine" });
  const machineKey = scopeKey(machinePlace);

  const active = highlight._tag === "workspace" ? workspaces.find((w) => w.id === highlight.id) : undefined;

  return (
    <div className="flex h-72">
      {/* Left: what there is. Hovering is enough — no click is needed to look. */}
      <div className="flex w-1/2 shrink-0 flex-col overflow-y-auto p-1">
        <button
          type="button"
          onMouseEnter={() => setHighlight({ _tag: "machine" })}
          onFocus={() => setHighlight({ _tag: "machine" })}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-2 text-start",
            highlight._tag === "machine" ? "bg-accent" : "hover:bg-accent/60",
          )}
        >
          <MachineIcon />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{scopeLabels["runtime-host"]}</span>
          <Badge variant={places.includes(machineKey) ? "secondary" : "ghost"} className="px-1">
            {places.includes(machineKey) ? "on" : "off"}
          </Badge>
        </button>

        <span className="px-2 pt-3 pb-1 text-xs text-muted-foreground">Workspaces</span>
        {workspaces.map((workspace) => {
          const keys = workspaceScopeKinds.map((kind) => scopeKey({ kind, workspaceId: workspace.id }));
          const checked = keys.filter((key) => places.includes(key)).length;
          const hot = highlight._tag === "workspace" && highlight.id === workspace.id;
          return (
            <button
              key={workspace.id}
              type="button"
              onMouseEnter={() => setHighlight({ _tag: "workspace", id: workspace.id as WorkspaceId })}
              onFocus={() => setHighlight({ _tag: "workspace", id: workspace.id as WorkspaceId })}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-start",
                hot ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{workspace.name}</span>
                {/* The path, not the remote: two of these share one remote. */}
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {workspace.checkoutPath}
                </span>
              </span>
              <Badge variant={checked > 0 ? "secondary" : "ghost"} className="px-1">
                {checked}/{keys.length}
              </Badge>
              <RiArrowRightSLine className="size-3 text-muted-foreground" />
            </button>
          );
        })}
      </div>

      <Separator orientation="vertical" />

      {/* Right: the places for whatever is under the pointer. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {highlight._tag === "machine" ? (
          <Label className="flex cursor-pointer flex-col gap-1 rounded-md p-2 hover:bg-accent">
            <span className="flex items-center gap-2">
              <span className="flex-1 text-sm font-medium">{scopeLabels["runtime-host"]}</span>
              <Badge variant="ghost" className="px-1">
                {countAt(machinePlace, facet)}
              </Badge>
              <Checkbox
                checked={places.includes(machineKey)}
                onCheckedChange={() => onChange(toggle(places, machineKey))}
              />
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              {scopeDescriptions["runtime-host"]}
            </span>
          </Label>
        ) : active ? (
          <>
            <span className="px-2 pb-1 text-xs text-muted-foreground">{active.name}</span>
            {workspaceScopeKinds.map((kind) => {
              const place = { kind, workspaceId: active.id };
              const key = scopeKey(place);
              return (
                <Label
                  key={kind}
                  className="flex cursor-pointer flex-col gap-1 rounded-md p-2 hover:bg-accent"
                >
                  <span className="flex items-center gap-2">
                    <span className="flex-1 text-sm font-medium">{scopeLabels[kind]}</span>
                    <Badge variant="ghost" className="px-1">
                      {countAt(place, facet)}
                    </Badge>
                    <Checkbox
                      checked={places.includes(key)}
                      onCheckedChange={() => onChange(toggle(places, key))}
                    />
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">{scopeHints[kind]}</span>
                </Label>
              );
            })}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function CustomizeVariantB() {
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
        <SplitPlacePill places={places} facet={facet} onSetAll={setPlaces} menuWidth="34rem">
          <TwoPaneMenu places={places} facet={facet} onChange={setPlaces} />
        </SplitPlacePill>
      }
    />
  );
}
