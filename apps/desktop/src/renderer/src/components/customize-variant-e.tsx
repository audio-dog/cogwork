// PROTOTYPE — place menu E: filling cards, visibility state.
//
// Same shell and same filling-card geometry as Variant A. The only difference is how a card says
// whether it is on: see `customize-place-cards.tsx` for what each treatment trades away.

import { useState } from "react";
import { scopeKey } from "../features/configuration-model";
import { CustomizePageShell, PlacePickerButton } from "./customize-atoms";
import { PlaceMenu, PlaceMenuHeader, useHighlightedPlaces, usePlaceMenu } from "./customize-menu";
import { VisibilityCard } from "./customize-place-cards";
import { allPlaceKeys, countAt, type Facet, toggle } from "./customize-places";

function CardPane() {
  const { places, facet, onChange } = usePlaceMenu();
  const shown = useHighlightedPlaces();

  return (
    <>
      <PlaceMenuHeader />
      <div className="flex min-h-0 flex-1 flex-col gap-2 pt-1.5">
        {shown.map((place) => {
          const key = scopeKey(place);
          return (
            <VisibilityCard
              key={key}
              kind={place.kind}
              count={countAt(place, facet)}
              selected={places.includes(key)}
              onToggle={() => onChange(toggle(places, key))}
            />
          );
        })}
      </div>
    </>
  );
}

export function CustomizeVariantE() {
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
            <CardPane />
          </PlaceMenu>
        </PlacePickerButton>
      }
    />
  );
}
