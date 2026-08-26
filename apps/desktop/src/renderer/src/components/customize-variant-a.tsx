// PROTOTYPE — place menu A: two panes with a footer bar.
//
// Fixes the imbalance by giving the menu a bottom edge. A footer spans both panes, so the right
// pane's leftover space is bounded rather than trailing off, and it is where "select all" and
// "select none" now live — out of the trigger, where they were doing nothing useful.
//
// The right pane opens with a header naming what the pointer is on, which mirrors the left pane's
// User row at the top. Both panes now start with a header and end at the footer.

import { Button } from "@cogwork/ui/components/button";
import { Separator } from "@cogwork/ui/components/separator";
import { useState } from "react";
import { scopeCopy, scopeKey, type WorkspaceId } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { scopeIcons } from "./configuration-atoms";
import { CustomizePageShell, PlacePickerButton } from "./customize-atoms";
import { CountBadge, MenuNavRow, MenuPlaceRow } from "./customize-menu-atoms";
import {
  allPlaceKeys,
  countAt,
  type Facet,
  machinePlace,
  placeCount,
  toggle,
  visibleContributions,
  workspaceScopeKinds,
} from "./customize-places";

const { workspaces } = placeholderConfiguration;
const MachineIcon = scopeIcons["runtime-host"];

type Highlight = { readonly _tag: "user" } | { readonly _tag: "workspace"; readonly id: WorkspaceId };

function FooterMenu({
  places,
  facet,
  onChange,
}: {
  places: readonly string[];
  facet: Facet;
  onChange: (next: readonly string[]) => void;
}) {
  const [highlight, setHighlight] = useState<Highlight>({ _tag: "user" });
  const machineKey = scopeKey(machinePlace);
  const active = highlight._tag === "workspace" ? workspaces.find((w) => w.id === highlight.id) : undefined;
  const shown = visibleContributions(facet, places, "").length;

  return (
    <div className="flex flex-col">
      <div className="flex h-64">
        <div className="flex w-[19rem] shrink-0 flex-col overflow-y-auto p-1.5">
          <MenuNavRow
            icon={MachineIcon}
            title={scopeCopy["runtime-host"].name}
            active={highlight._tag === "user"}
            onHover={() => setHighlight({ _tag: "user" })}
            meta={<CountBadge count={countAt(machinePlace, facet)} muted={!places.includes(machineKey)} />}
          />
          <span className="px-2 pt-3 pb-1 text-xs text-muted-foreground">Workspaces</span>
          {workspaces.map((workspace) => {
            const keys = workspaceScopeKinds.map((kind) => scopeKey({ kind, workspaceId: workspace.id }));
            const checked = keys.filter((key) => places.includes(key)).length;
            return (
              <MenuNavRow
                key={workspace.id}
                title={workspace.name}
                // The path, not the remote: two of these share one remote.
                subtitle={workspace.checkoutPath}
                active={highlight._tag === "workspace" && highlight.id === workspace.id}
                onHover={() => setHighlight({ _tag: "workspace", id: workspace.id as WorkspaceId })}
                meta={<CountBadge count={checked} muted={checked === 0} />}
              />
            );
          })}
        </div>

        <Separator orientation="vertical" />

        <div className="flex min-w-0 flex-1 flex-col p-1.5">
          {/* Mirrors the left pane's top row, so neither pane starts with dead space. */}
          <div className="flex items-center gap-2.5 px-2 pt-1 pb-2">
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">
                {highlight._tag === "user" ? scopeCopy["runtime-host"].name : (active?.name ?? "")}
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {highlight._tag === "user" ? "~/.cogwork" : (active?.checkoutPath ?? "")}
              </span>
            </span>
          </div>
          <Separator className="mb-1" />

          {highlight._tag === "user" ? (
            <MenuPlaceRow
              name={scopeCopy["runtime-host"].name}
              hint={scopeCopy["runtime-host"].hint}
              count={countAt(machinePlace, facet)}
              checked={places.includes(machineKey)}
              onToggle={() => onChange(toggle(places, machineKey))}
            />
          ) : active ? (
            workspaceScopeKinds.map((kind) => {
              const place = { kind, workspaceId: active.id };
              const key = scopeKey(place);
              return (
                <MenuPlaceRow
                  key={kind}
                  name={scopeCopy[kind].name}
                  hint={scopeCopy[kind].hint}
                  count={countAt(place, facet)}
                  checked={places.includes(key)}
                  onToggle={() => onChange(toggle(places, key))}
                />
              );
            })
          ) : null}
        </div>
      </div>

      <Separator />

      {/* The footer: a bottom edge for both panes, and where select-all belongs. */}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Button variant="ghost" size="xs" onClick={() => onChange(allPlaceKeys)}>
          Select all
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onChange([])}>
          Select none
        </Button>
        <span className="ms-auto pe-1 text-xs text-muted-foreground tabular-nums">
          {places.length} of {placeCount} places · {shown} shown
        </span>
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
        <PlacePickerButton places={places} menuWidth="34rem">
          <FooterMenu places={places} facet={facet} onChange={setPlaces} />
        </PlacePickerButton>
      }
    />
  );
}
