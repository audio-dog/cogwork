import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { Separator } from "@cogwork/ui/components/separator";
import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import { RiBox3Line, RiEqualizerLine, RiPulseLine, RiSearchLine } from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { kindIcons } from "../features/configuration-icons";
import {
  type ContributionKind,
  contributionInstanceKey,
  kindLabelsPlural,
} from "../features/configuration-model";
import { type Facet, facetLabel, facetSlug, facets } from "../features/customize-facets";
import { useConfiguration } from "./configuration-provider";
import { ContributionFileRow } from "./contribution-file-row";
import { FilteredEmpty } from "./customize-empty";
import { useCustomizeFilter } from "./customize-filter";
import { ListSection, ListSectionHeader, ListSectionRows } from "./customize-list";
import { CustomizePlaceMenu, PlaceFilterNotApplicable } from "./customize-place-menu";
import { McpFacet } from "./mcp-facet";
import { PluginsFacet } from "./plugins-facet";

function FacetPillContent({ facet }: { facet: Facet }) {
  const {
    meta: { places },
  } = useConfiguration();
  const {
    state: { places: selected },
  } = useCustomizeFilter();

  if (facet === "plugins")
    return (
      <>
        <RiBox3Line data-icon="inline-start" />
        {facetLabel(facet)}
      </>
    );
  return (
    <>
      {facetLabel(facet)}
      <Badge variant="ghost" className="ms-1 w-4 justify-center px-0 tabular-nums">
        {places.kindCount(facet, selected)}
      </Badge>
    </>
  );
}

function ActiveFacetPill({ facet }: { facet: Facet }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className="rounded-full"
      aria-current="page"
      nativeButton={false}
      render={<Link to="/customize/$facet" params={{ facet: facetSlug(facet) }} />}
    >
      <FacetPillContent facet={facet} />
    </Button>
  );
}

function InactiveFacetPill({ facet }: { facet: Facet }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="rounded-full"
      nativeButton={false}
      render={<Link to="/customize/$facet" params={{ facet: facetSlug(facet) }} />}
    >
      <FacetPillContent facet={facet} />
    </Button>
  );
}

function CustomizeSearch() {
  const {
    state: { query },
    actions: { setQuery },
  } = useCustomizeFilter();

  return (
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
  );
}

function CustomizeFilters({ active, children }: { active: Facet; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}
      <Separator orientation="vertical" className="h-6" />
      {facets.map((facet) =>
        facet === active ? (
          <ActiveFacetPill key={facet} facet={facet} />
        ) : (
          <InactiveFacetPill key={facet} facet={facet} />
        ),
      )}
    </div>
  );
}

function CustomizeFrame({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-2">
          <RiEqualizerLine />
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Customize</h1>
        </div>
        {children}
      </div>
    </TooltipProvider>
  );
}

function ContributionGroups({ kind }: { kind: ContributionKind }) {
  const {
    meta: { places },
  } = useConfiguration();
  const {
    state: { places: selected, query },
  } = useCustomizeFilter();

  const groups = places.groupContributions(kind, selected, query);
  if (groups.length === 0) {
    return <FilteredEmpty icon={kindIcons[kind]} label={kindLabelsPlural[kind].toLowerCase()} />;
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <ListSection key={group.key}>
          <ListSectionHeader title={group.label} count={group.rows.length} />
          <ListSectionRows items={group.rows} keyOf={contributionInstanceKey}>
            {(contribution) => <ContributionFileRow contribution={contribution} />}
          </ListSectionRows>
        </ListSection>
      ))}
    </div>
  );
}

export function PluginsFacetView() {
  return (
    <CustomizeFrame>
      <CustomizeSearch />
      <CustomizeFilters active="plugins">
        <PlaceFilterNotApplicable>
          Plugins are not filtered by place. An install is machine-local, so every installed Plugin is on this
          machine.
        </PlaceFilterNotApplicable>
      </CustomizeFilters>
      <PluginsFacet />
    </CustomizeFrame>
  );
}

export function McpServersFacetView() {
  return (
    <CustomizeFrame>
      <CustomizeSearch />
      <CustomizeFilters active="mcp-server">
        <CustomizePlaceMenu kind="mcp-server" />
      </CustomizeFilters>
      <McpFacet />
    </CustomizeFrame>
  );
}

export function HooksFacetView() {
  return (
    <CustomizeFrame>
      <CustomizeSearch />
      <CustomizeFilters active="hook">
        <CustomizePlaceMenu kind="hook" />
      </CustomizeFilters>
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiPulseLine />
          </EmptyMedia>
          <EmptyTitle>Hooks aren't ready yet</EmptyTitle>
          <EmptyDescription>We're still building them.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </CustomizeFrame>
  );
}

export function ContributionFacetView({ kind }: { kind: ContributionKind }) {
  return (
    <CustomizeFrame>
      <CustomizeSearch />
      <CustomizeFilters active={kind}>
        <CustomizePlaceMenu kind={kind} />
      </CustomizeFilters>
      <ContributionGroups kind={kind} />
    </CustomizeFrame>
  );
}
