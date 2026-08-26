// PROTOTYPE — the parts of Customize every menu variant holds constant.
//
// The page shell, the kind pills and the trigger are identical in all three variants, so the only
// thing that differs on screen is the menu body. That is what is being compared.

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
import { type Facet, kindCount, summarize, visibleContributions } from "./customize-places";
import { CustomizeRow } from "./customize-row";

const MachineIcon = scopeIcons["runtime-host"];

/**
 * The trigger. One button, and the whole of it opens the menu.
 *
 * Two things keep the menu still. The button *is* `Popover.Trigger`, so the anchor's leading edge
 * never moves — previously the trigger was only the caret half of a split button, so a longer
 * summary pushed the caret right and dragged the popup with it. And the label has a fixed width and
 * truncates, so a change in the selection cannot resize the button and shove the kind pills along
 * with it.
 */
export function PlacePickerButton({
  places,
  menuWidth = "38rem",
  children,
}: {
  places: readonly string[];
  menuWidth?: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="rounded-full" />}>
        <MachineIcon data-icon="inline-start" />
        <span className="w-32 truncate text-start">{summarize(places)}</span>
        <RiArrowDownSLine data-icon="inline-end" />
      </PopoverTrigger>
      {/* `align="start"` pins the popup's leading edge to the button's, which does not move. */}
      <PopoverContent align="start" className="p-0" style={{ width: menuWidth }}>
        {children}
      </PopoverContent>
    </Popover>
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
            {/* Fixed width: the count changes with the selection, and a resizing pill moves its
                neighbours. */}
            <Badge variant="ghost" className="ms-1 w-4 justify-center px-0 tabular-nums">
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
                ? "No place is selected, so nothing can show."
                : "Nothing of this kind lives in the selected places."}
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
