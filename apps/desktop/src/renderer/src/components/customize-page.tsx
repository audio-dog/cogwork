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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { Separator } from "@cogwork/ui/components/separator";
import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import { RiBox3Line, RiPulseLine, RiSearchLine } from "@remixicon/react";
import { useState } from "react";
import { contributionKinds, kindLabelsPlural } from "../features/configuration-model";
import { allPlaceKeys, type Facet, groupContributions, kindCount } from "../features/customize-places";
import { kindIcons } from "./configuration-atoms";
import { ListRows, ListSection } from "./customize-list";
import { CustomizePlaceMenu } from "./customize-place-menu";
import { CustomizeRow } from "./customize-row";
import { McpFacet } from "./mcp-facet";
import { PluginsFacet } from "./plugins-facet";

export function CustomizePage() {
  const [facet, setFacet] = useState<Facet>("skill");
  const [places, setPlaces] = useState<readonly string[]>(allPlaceKeys);
  const [query, setQuery] = useState("");

  const groups = groupContributions(facet, places, query);
  const plugins = facet === "plugins";
  const FacetIcon = plugins ? RiBox3Line : kindIcons[facet];

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4">
        <InputGroup>
          <InputGroupInput
            placeholder="Search Plugins, Skills, MCPs..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <InputGroupAddon>
            <RiSearchLine />
          </InputGroupAddon>
        </InputGroup>

        <div className="flex flex-wrap items-center gap-2">
          {/*
          An install is machine-local, so a Plugin has no place to be filtered by — but the control
          stays put and goes disabled rather than disappearing. Removing it reflowed every pill after
          it the moment you picked Plugins, and a row that jumps is worse than a button that says no.
        */}
          <CustomizePlaceMenu
            places={places}
            facet={facet}
            onChange={setPlaces}
            unavailable={
              plugins
                ? "Plugins are not filtered by place. An install is machine-local, so every installed Plugin is on this machine."
                : undefined
            }
          />
          <Separator orientation="vertical" className="h-6" />
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
          <PluginsFacet />
        ) : facet === "mcp-server" ? (
          <McpFacet />
        ) : facet === "hook" ? (
          // Hooks are out of scope for this map. Saying so beats an empty list that looks broken.
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RiPulseLine />
              </EmptyMedia>
              <EmptyTitle>Hooks aren't ready yet</EmptyTitle>
              <EmptyDescription>We're still building them.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : groups.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FacetIcon />
              </EmptyMedia>
              <EmptyTitle>
                {places.length === 0 ? "Nothing selected" : `No ${kindLabelsPlural[facet].toLowerCase()} yet`}
              </EmptyTitle>
              <EmptyDescription>
                {places.length === 0 ? "Choose where to look." : "Nothing in the places you picked."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          // One section per source. A Plugin's contributions are its own, so a Skill it ships never
          // sits in the same list as one you wrote — which place-grouping alone could not do,
          // because an install is machine-local and puts them all at the machine.
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <ListSection key={group.key} title={group.label} count={group.rows.length}>
                <ListRows>
                  {group.rows.map((contribution) => (
                    <CustomizeRow key={contribution.id} contribution={contribution} />
                  ))}
                </ListRows>
              </ListSection>
            ))}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
