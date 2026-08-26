// The Customize page: what each Plugin contributes, and whether it is on.
//
// Two filters, and they are not the same kind of thing. Kind is a facet — one at a time, because a
// person is looking for a Skill or a Hook, not both. Where it lives is a union, because the levels
// are places a file can sit rather than a precedence ladder, so showing two at once is a real
// question rather than an ambiguous one.
//
// Placeholder data. See `features/configuration-placeholder.ts`.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { ItemGroup } from "@cogwork/ui/components/item";
import { Separator } from "@cogwork/ui/components/separator";
import { RiBox3Line, RiSearchLine } from "@remixicon/react";
import { useState } from "react";
import { contributionKinds, kindLabelsPlural } from "../features/configuration-model";
import { allPlaceKeys, type Facet, kindCount, visibleContributions } from "../features/customize-places";
import { PluginsPanel } from "./configuration-plugins-panel";
import { CustomizePlaceMenu } from "./customize-place-menu";
import { CustomizeRow } from "./customize-row";

export function CustomizePage() {
  const [facet, setFacet] = useState<Facet>("skill");
  const [places, setPlaces] = useState<readonly string[]>(allPlaceKeys);
  const [query, setQuery] = useState("");

  const visible = visibleContributions(facet, places, query);
  const plugins = facet === "plugins";

  return (
    <div className="flex flex-col gap-4">
      <InputGroup>
        <InputGroupInput
          placeholder="Search contributions…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <InputGroupAddon>
          <RiSearchLine />
        </InputGroupAddon>
      </InputGroup>

      <div className="flex flex-wrap items-center gap-2">
        {/*
          An install is machine-local, so a Plugin has no place to be filtered by. A control that
          cannot change what you see is worse than no control, so it is absent rather than inert.
        */}
        {plugins ? null : (
          <>
            <CustomizePlaceMenu places={places} facet={facet} onChange={setPlaces} />
            <Separator orientation="vertical" className="h-6" />
          </>
        )}
        <Button
          variant={plugins ? "secondary" : "outline"}
          size="sm"
          className="rounded-full"
          onClick={() => setFacet("plugins")}
        >
          <RiBox3Line data-icon="inline-start" />
          Plugins
        </Button>
        {contributionKinds.map((kind) => (
          <Button
            key={kind}
            variant={facet === kind ? "secondary" : "outline"}
            size="sm"
            className="rounded-full"
            onClick={() => setFacet(kind)}
          >
            {kindLabelsPlural[kind]}
            {/* Fixed width and tabular: the count moves with the selection, and a resizing pill
                shoves its neighbours along the row. */}
            <Badge variant="ghost" className="ms-1 w-4 justify-center px-0 tabular-nums">
              {kindCount(kind, places)}
            </Badge>
          </Button>
        ))}
      </div>

      {plugins ? (
        <PluginsPanel />
      ) : visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing here</EmptyTitle>
            <EmptyDescription>
              {places.length === 0
                ? "No place is selected, so nothing can show."
                : `No ${kindLabelsPlural[facet].toLowerCase()} live in the selected places.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {visible.map((contribution) => (
            <CustomizeRow key={contribution.id} contribution={contribution} />
          ))}
        </ItemGroup>
      )}
    </div>
  );
}
