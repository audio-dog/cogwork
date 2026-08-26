// PROTOTYPE — place menu A: cards that fill.
//
// The settled shell, and the right pane answers its leftover space with geometry: each place is a
// card that grows to take an equal share of the height. One place or two, the pane is full.
//
// Cheapest of the three and the only one that cannot scroll. What it gives up is telling you
// anything you did not already know — a bigger card is not a more informative one.

import { Checkbox } from "@cogwork/ui/components/checkbox";
import { Label } from "@cogwork/ui/components/label";
import { cn } from "@cogwork/ui/lib/utils";
import { useState } from "react";
import { scopeCopy, scopeKey } from "../features/configuration-model";
import { scopeIcons } from "./configuration-atoms";
import { CustomizePageShell, PlacePickerButton } from "./customize-atoms";
import { PlaceMenu, PlaceMenuHeader, useHighlightedPlaces, usePlaceMenu } from "./customize-menu";
import { CountBadge } from "./customize-menu-atoms";
import { allPlaceKeys, countAt, type Facet, toggle } from "./customize-places";

function FillingCards() {
  const { places, facet, onChange } = usePlaceMenu();
  const shown = useHighlightedPlaces();

  return (
    <>
      <PlaceMenuHeader />
      <div className="flex min-h-0 flex-1 flex-col gap-2 pt-1.5">
        {shown.map((place) => {
          const key = scopeKey(place);
          const checked = places.includes(key);
          const Icon = scopeIcons[place.kind];
          return (
            <Label
              key={key}
              className={cn(
                "flex flex-1 cursor-pointer flex-col gap-1.5 rounded-lg border p-3 transition-colors",
                checked ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  <Icon />
                </span>
                <span className="flex-1 text-sm font-medium">{scopeCopy[place.kind].name}</span>
                <CountBadge count={countAt(place, facet)} />
                <Checkbox checked={checked} onCheckedChange={() => onChange(toggle(places, key))} />
              </span>
              <span className="text-xs font-normal text-muted-foreground">{scopeCopy[place.kind].hint}</span>
            </Label>
          );
        })}
      </div>
    </>
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
          <PlaceMenu places={places} facet={facet} onChange={setPlaces}>
            <FillingCards />
          </PlaceMenu>
        </PlacePickerButton>
      }
    />
  );
}
