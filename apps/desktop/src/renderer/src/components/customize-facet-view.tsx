import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { Separator } from "@cogwork/ui/components/separator";
import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import { RiBox3Line, RiEqualizerLine, RiPulseLine, RiSearchLine } from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { type ContributionKind, kindLabelsPlural } from "../features/configuration-model";
import { type Facet, facetLabel, facetSlug, facets } from "../features/customize-facets";
import { allPlaceKeys, groupContributions, kindCount } from "../features/customize-places";
import { kindIcons } from "./configuration-atoms";
import { ContributionFileRow } from "./contribution-file-row";
import { ListSection, ListSectionHeader, ListSectionRows } from "./customize-list";
import { CustomizePlaceMenu } from "./customize-place-menu";
import { McpFacet } from "./mcp-facet";
import { PluginsFacet } from "./plugins-facet";

function FacetPill({ facet, active, places }: { facet: Facet; active: boolean; places: readonly string[] }) {
  return (
    <Button
      variant={active ? "secondary" : "outline"}
      size="sm"
      className="rounded-full"
      render={<Link to="/customize/$facet" params={{ facet: facetSlug(facet) }} />}
    >
      {facet === "plugins" ? <RiBox3Line data-icon="inline-start" /> : null}
      {facetLabel(facet)}
      {facet === "plugins" ? null : (
        <Badge variant="ghost" className="ms-1 w-4 justify-center px-0 tabular-nums">
          {kindCount(facet, places)}
        </Badge>
      )}
    </Button>
  );
}

function HooksEmpty() {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiPulseLine />
        </EmptyMedia>
        <EmptyTitle>Hooks aren't ready yet</EmptyTitle>
        <EmptyDescription>We're still building them.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function NothingHere({ kind, anyPlace }: { kind: ContributionKind; anyPlace: boolean }) {
  const Icon = kindIcons[kind];
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>
          {anyPlace ? `No ${kindLabelsPlural[kind].toLowerCase()} yet` : "Nothing selected"}
        </EmptyTitle>
        <EmptyDescription>
          {anyPlace ? "Nothing in the places you picked." : "Choose where to look."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ContributionGroups({
  kind,
  places,
  query,
}: {
  kind: ContributionKind;
  places: readonly string[];
  query: string;
}) {
  const groups = groupContributions(kind, places, query);
  if (groups.length === 0) return <NothingHere kind={kind} anyPlace={places.length > 0} />;

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <ListSection key={group.key}>
          <ListSectionHeader title={group.label} count={group.rows.length} />
          <ListSectionRows>
            {group.rows.map((contribution) => (
              <ContributionFileRow key={contribution.id} contribution={contribution} />
            ))}
          </ListSectionRows>
        </ListSection>
      ))}
    </div>
  );
}

function FacetBody({ facet, places, query }: { facet: Facet; places: readonly string[]; query: string }) {
  if (facet === "plugins") return <PluginsFacet />;
  if (facet === "mcp-server") return <McpFacet />;
  if (facet === "hook") return <HooksEmpty />;
  return <ContributionGroups kind={facet} places={places} query={query} />;
}

export function CustomizeFacetView({ facet }: { facet: Facet }) {
  const [places, setPlaces] = useState<readonly string[]>(allPlaceKeys);
  const [query, setQuery] = useState("");

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-2">
          <RiEqualizerLine />
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Customize</h1>
        </div>

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
          <CustomizePlaceMenu
            places={places}
            facet={facet}
            onChange={setPlaces}
            unavailable={
              facet === "plugins"
                ? "Plugins are not filtered by place. An install is machine-local, so every installed Plugin is on this machine."
                : undefined
            }
          />
          <Separator orientation="vertical" className="h-6" />
          {facets.map((entry) => (
            <FacetPill key={entry} facet={entry} active={entry === facet} places={places} />
          ))}
        </div>

        <FacetBody facet={facet} places={places} query={query} />
      </div>
    </TooltipProvider>
  );
}
