// PROTOTYPE — place menu C: the detail pane.
//
// The settled shell, and a third reading of the leftover space: stop treating it as a gap to close.
// The place rows sit at their natural height under the header, and a summary of the highlighted
// thing is pinned to the bottom. Content at the top, content at the bottom, and the space between
// them reads as deliberate rather than as something that ran out.
//
// The summary answers what a checkbox cannot: which tracker this workspace is on, whether its
// remote is shared with another workspace, and what is in these places across every kind — not just
// the kind currently filtered to. That last part matters, because the counts everywhere else on
// this menu are scoped to the active kind and can all read zero while the place is full.

import { Badge } from "@cogwork/ui/components/badge";
import { Separator } from "@cogwork/ui/components/separator";
import { useState } from "react";
import {
  contributionKinds,
  kindLabelsPlural,
  type ScopeRef,
  scopeCopy,
  scopeKey,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { CustomizePageShell, PlacePickerButton } from "./customize-atoms";
import { PlaceMenu, PlaceMenuHeader, useHighlightedPlaces, usePlaceMenu } from "./customize-menu";
import { MenuPlaceRow } from "./customize-menu-atoms";
import { allPlaceKeys, countAt, type Facet, placeOf, toggle } from "./customize-places";

const { contributions, workspaces, principal } = placeholderConfiguration;

/** Across every kind, not just the filtered one — the point of a summary is what you cannot see. */
function tally(places: readonly ScopeRef[]) {
  const keys = places.map(scopeKey);
  const here = contributions.filter((contribution) => keys.includes(placeOf(contribution)));
  return contributionKinds
    .map((kind) => ({ kind, count: here.filter((entry) => entry.kind === kind).length }))
    .filter((entry) => entry.count > 0);
}

function DetailPane() {
  const { places, facet, onChange, highlight, workspace } = usePlaceMenu();
  const shown = useHighlightedPlaces();
  const counts = tally(shown);

  const sharesRemote =
    workspace?.remote !== undefined &&
    workspaces.filter((entry) => entry.remote === workspace.remote).length > 1;

  return (
    <>
      <PlaceMenuHeader />

      <div className="flex flex-col pt-1">
        {shown.map((place) => {
          const key = scopeKey(place);
          return (
            <MenuPlaceRow
              key={key}
              name={scopeCopy[place.kind].name}
              hint={scopeCopy[place.kind].hint}
              count={countAt(place, facet)}
              checked={places.includes(key)}
              onToggle={() => onChange(toggle(places, key))}
            />
          );
        })}
      </div>

      {/* Pinned to the bottom, so the space above it is spacing rather than shortfall. */}
      <div className="mt-auto flex flex-col gap-2 px-2 pt-3">
        <Separator />
        <div className="flex flex-col gap-1.5 pt-0.5">
          {highlight._tag === "user" ? (
            <span className="text-xs text-muted-foreground">
              This machine, as {principal}. Nothing synchronizes it, so what is installed here is here only.
            </span>
          ) : workspace ? (
            <>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>Tracked in</span>
                <Badge variant="outline">{workspace.tracker}</Badge>
              </span>
              {sharesRemote ? (
                <span className="text-xs text-muted-foreground">
                  Another workspace shares this remote. The path above is what tells them apart.
                </span>
              ) : null}
            </>
          ) : null}

          <span className="flex flex-wrap items-center gap-1">
            {counts.length === 0 ? (
              <span className="text-xs text-muted-foreground">Nothing lives here yet.</span>
            ) : (
              counts.map((entry) => (
                <Badge key={entry.kind} variant="ghost" className="tabular-nums">
                  {entry.count} {kindLabelsPlural[entry.kind]}
                </Badge>
              ))
            )}
          </span>
        </div>
      </div>
    </>
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
        <PlacePickerButton places={places} menuWidth="34rem">
          <PlaceMenu places={places} facet={facet} onChange={setPlaces} height="h-72">
            <DetailPane />
          </PlaceMenu>
        </PlacePickerButton>
      }
    />
  );
}
