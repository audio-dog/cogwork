// PROTOTYPE — place menu D: plain rows.
//
// The right pane exactly as it was in the last round's Variant A: the header, then the place rows at
// their natural height, and nothing else. No card stretched to fill, no preview, no pinned summary.
//
// It is the control. The other three each spend something to close the gap at the bottom — A spends
// honesty about card size, B spends a scrollbar, C spends vertical room on a summary — and this one
// spends nothing. Worth judging on its own now that the left pane is settled, because the gap may
// simply have been reading worse than it was next to an unbalanced left column.

import { useState } from "react";
import { scopeCopy, scopeKey } from "../features/configuration-model";
import { CustomizePageShell, PlacePickerButton } from "./customize-atoms";
import { PlaceMenu, PlaceMenuHeader, useHighlightedPlaces, usePlaceMenu } from "./customize-menu";
import { MenuPlaceRow } from "./customize-menu-atoms";
import { allPlaceKeys, countAt, type Facet, toggle } from "./customize-places";

function PlainRows() {
  const { places, facet, onChange } = usePlaceMenu();
  const shown = useHighlightedPlaces();

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
    </>
  );
}

export function CustomizeVariantD() {
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
          <PlaceMenu places={places} facet={facet} onChange={setPlaces}>
            <PlainRows />
          </PlaceMenu>
        </PlacePickerButton>
      }
    />
  );
}
