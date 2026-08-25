// PROTOTYPE — the parts of Customize every split-dropdown variant holds constant.
//
// The page shell, the kind pills and the outer split pill are identical in all three variants, so
// the only thing that differs on screen is the menu body. That is what is being compared.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { ItemGroup } from "@cogwork/ui/components/item";
import { Popover, PopoverContent, PopoverTrigger } from "@cogwork/ui/components/popover";
import { Separator } from "@cogwork/ui/components/separator";
import { RiArrowDownSLine, RiBox3Line, RiSearchLine } from "@remixicon/react";
import type { ReactNode } from "react";
import { contributionKinds, kindLabelsPlural } from "../features/configuration-model";
import { scopeIcons } from "./configuration-atoms";
import { PluginsPanel } from "./configuration-plugins-panel";
import { allPlaceKeys, type Facet, kindCount, summarize, visibleContributions } from "./customize-places";
import { CustomizeRow } from "./customize-row";

const MachineIcon = scopeIcons["runtime-host"];

/**
 * The split pill: a summary segment and a caret segment, divided. Clicking the summary is the
 * escape hatch back to everything, so no menu design can trap a person in an empty list.
 */
export function SplitPlacePill({
  places,
  facet,
  onSetAll,
  menuWidth = "26rem",
  children,
}: {
  places: readonly string[];
  facet: Facet;
  onSetAll: (next: readonly string[]) => void;
  menuWidth?: string;
  children: ReactNode;
}) {
  const everywhere = places.length === allPlaceKeys.length;
  return (
    <div className="flex items-stretch rounded-full border border-input">
      <Button
        variant="ghost"
        size="sm"
        className="rounded-s-full rounded-e-none border-0 pe-2"
        onClick={() => onSetAll(everywhere ? [] : allPlaceKeys)}
      >
        <MachineIcon />
        <span className="max-w-56 truncate">{summarize(places, facet)}</span>
      </Button>
      <Separator orientation="vertical" />
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="rounded-s-none rounded-e-full border-0 px-1.5"
              aria-label="Choose where to look"
            />
          }
        >
          <RiArrowDownSLine />
        </PopoverTrigger>
        <PopoverContent align="start" className="p-0" style={{ width: menuWidth }}>
          {children}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Search, the kind pills with the place picker beside them, and the list. Identical everywhere. */
export function CustomizePageShell({
  facet,
  onFacet,
  places,
  query,
  onQuery,
  picker,
}: {
  facet: Facet;
  onFacet: (facet: Facet) => void;
  places: readonly string[];
  query: string;
  onQuery: (query: string) => void;
  picker: ReactNode;
}) {
  const visible = visibleContributions(facet, places, query);

  return (
    <div className="flex flex-col gap-4">
      <InputGroup>
        <InputGroupInput
          placeholder="Search contributions…"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        <InputGroupAddon>
          <RiSearchLine />
        </InputGroupAddon>
      </InputGroup>

      <div className="flex flex-wrap items-center gap-2">
        {picker}
        <Separator orientation="vertical" className="h-6" />
        <Button
          variant={facet === "plugins" ? "secondary" : "outline"}
          size="sm"
          className="rounded-full"
          onClick={() => onFacet("plugins")}
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
            onClick={() => onFacet(kind)}
          >
            {kindLabelsPlural[kind]}
            <Badge variant="ghost" className="ms-1 px-1">
              {kindCount(kind, places)}
            </Badge>
          </Button>
        ))}
      </div>

      {facet === "plugins" ? (
        <PluginsPanel />
      ) : visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing here</EmptyTitle>
            <EmptyDescription>
              {places.length === 0
                ? "No place is checked, so nothing can show."
                : "Nothing of this kind lives in the checked places."}
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
