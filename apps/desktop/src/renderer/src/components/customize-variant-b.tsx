// PROTOTYPE — place menu B: the preview.
//
// The settled shell, and the right pane answers its leftover space with information: under each
// place sits what actually lives there.
//
// The argument for it is that choosing a place is a guess until you know what is in it. A count
// tells you three Skills are in the repo; it does not tell you that one of them is `pr-summary`,
// which is the thing you were looking for. The cost is the only scrolling menu of the three.

import { Badge } from "@cogwork/ui/components/badge";
import { Separator } from "@cogwork/ui/components/separator";
import { useState } from "react";
import { type Contribution, type ScopeRef, scopeCopy, scopeKey } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { kindIcons } from "./configuration-atoms";
import { CustomizePageShell, PlacePickerButton } from "./customize-atoms";
import { PlaceMenu, PlaceMenuHeader, useHighlightedPlaces, usePlaceMenu } from "./customize-menu";
import { MenuPlaceRow } from "./customize-menu-atoms";
import { allPlaceKeys, type Facet, placeOf, toggle } from "./customize-places";

const { contributions } = placeholderConfiguration;

function livingAt(place: ScopeRef, facet: Facet): readonly Contribution[] {
  const key = scopeKey(place);
  return contributions.filter(
    (contribution) => placeOf(contribution) === key && (facet === "plugins" || contribution.kind === facet),
  );
}

function Preview({ rows }: { rows: readonly Contribution[] }) {
  if (rows.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">Nothing of this kind lives here.</p>;
  }
  return (
    <div className="flex flex-col">
      {rows.map((contribution) => {
        const Icon = kindIcons[contribution.kind];
        return (
          <span key={contribution.id} className="flex items-center gap-2 px-2 py-1">
            <span className="text-muted-foreground">
              <Icon />
            </span>
            <span className="min-w-0 flex-1 truncate text-xs">{contribution.localName}</span>
            {contribution.load._tag === "failed" ? (
              <Badge variant="destructive" className="shrink-0">
                failed
              </Badge>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function PreviewPane() {
  const { places, facet, onChange } = usePlaceMenu();
  const shown = useHighlightedPlaces();

  return (
    <>
      <PlaceMenuHeader />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-1">
        {shown.map((place, index) => {
          const key = scopeKey(place);
          const rows = livingAt(place, facet);
          return (
            <div key={key} className="flex flex-col">
              {index > 0 ? <Separator className="my-1.5" /> : null}
              <MenuPlaceRow
                name={scopeCopy[place.kind].name}
                hint={scopeCopy[place.kind].hint}
                count={rows.length}
                checked={places.includes(key)}
                onToggle={() => onChange(toggle(places, key))}
              />
              <div className="ps-7">
                <Preview rows={rows} />
              </div>
            </div>
          );
        })}
      </div>
    </>
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
        <PlacePickerButton places={places} menuWidth="36rem">
          <PlaceMenu places={places} facet={facet} onChange={setPlaces} height="h-80">
            <PreviewPane />
          </PlaceMenu>
        </PlacePickerButton>
      }
    />
  );
}
