// Where Customize looks: the machine, and each workspace's two places.
//
// The menu is a filter, not a selection — unchecking a place hides what lives there. Three
// decisions it rests on:
//
//   · A place is fully named or it is not a place. "The repository" means nothing until it says
//     which repository, so a place is `runtime-host` or a Scope kind paired with a WorkspaceId.
//   · The checkout path is stated once, in the right pane. The left pane identifies a workspace;
//     the right pane describes it.
//   · The trigger is the whole button. It used to be the caret half of a split control, and a
//     longer label pushed the caret right and dragged the popup with it.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Checkbox } from "@cogwork/ui/components/checkbox";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { Label } from "@cogwork/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@cogwork/ui/components/popover";
import { Separator } from "@cogwork/ui/components/separator";
import { RiArrowDownSLine, RiArrowRightSLine, RiCheckDoubleLine } from "@remixicon/react";
import { useState } from "react";
import {
  type ScopeRef,
  scopeCopy,
  scopeKey,
  type Workspace,
  type WorkspaceId,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import {
  allPlaceKeys,
  countAt,
  type Facet,
  machinePlace,
  placeCount,
  summarize,
  toggle,
  workspaceScopeKinds,
} from "../features/customize-places";
import { scopeIcons } from "./configuration-atoms";

const { workspaces } = placeholderConfiguration;
const MachineIcon = scopeIcons["runtime-host"];

type Highlight = { readonly _tag: "user" } | { readonly _tag: "workspace"; readonly id: WorkspaceId };

/** Counts are fixed-width and tabular so a row never resizes as the selection changes. */
function CountBadge({ count, muted }: { count: number; muted: boolean }) {
  return (
    <Badge
      variant={muted || count === 0 ? "ghost" : "outline"}
      className="w-6 justify-center px-0 tabular-nums"
    >
      {count}
    </Badge>
  );
}

/** A left-pane row. Pointing at it is enough to reveal its places; it selects nothing itself. */
function NavRow({
  icon: Icon,
  title,
  count,
  muted,
  active,
  onHighlight,
}: {
  icon?: typeof MachineIcon;
  title: string;
  count: number;
  muted: boolean;
  active: boolean;
  onHighlight: () => void;
}) {
  return (
    <Item
      size="xs"
      variant={active ? "muted" : "default"}
      render={<button type="button" onMouseEnter={onHighlight} onFocus={onHighlight} />}
      className="cursor-pointer text-left hover:bg-muted/50"
    >
      {Icon ? (
        <ItemMedia variant="icon">
          <Icon />
        </ItemMedia>
      ) : null}
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <CountBadge count={count} muted={muted} />
        <RiArrowRightSLine className="size-3.5 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/** A right-pane row. Rendered as a label so the whole row toggles its checkbox. */
function PlaceRow({
  place,
  facet,
  checked,
  onToggle,
}: {
  place: ScopeRef;
  facet: Facet;
  checked: boolean;
  onToggle: () => void;
}) {
  const copy = scopeCopy[place.kind];
  return (
    <Item size="sm" render={<Label />} className="cursor-pointer items-start hover:bg-muted/50">
      <ItemMedia>
        <Checkbox checked={checked} onCheckedChange={onToggle} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{copy.name}</ItemTitle>
        <ItemDescription>{copy.hint}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <CountBadge count={countAt(place, facet)} muted={!checked} />
      </ItemActions>
    </Item>
  );
}

function placesOf(highlight: Highlight, workspace?: Workspace): readonly ScopeRef[] {
  if (highlight._tag === "user") return [machinePlace];
  if (!workspace) return [];
  return workspaceScopeKinds.map((kind) => ({ kind, workspaceId: workspace.id }));
}

export function CustomizePlaceMenu({
  places,
  facet,
  onChange,
}: {
  places: readonly string[];
  facet: Facet;
  onChange: (next: readonly string[]) => void;
}) {
  const [highlight, setHighlight] = useState<Highlight>({ _tag: "user" });

  const machineKey = scopeKey(machinePlace);
  const everything = places.length === placeCount;
  const workspace =
    highlight._tag === "workspace" ? workspaces.find((entry) => entry.id === highlight.id) : undefined;
  const shown = placesOf(highlight, workspace);
  const user = highlight._tag === "user";

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="rounded-full" />}>
        <MachineIcon data-icon="inline-start" />
        {/* Fixed width: a label that resizes shoves every kind pill after it along the row. */}
        <span className="w-32 truncate text-start">{summarize(places)}</span>
        <RiArrowDownSLine data-icon="inline-end" />
      </PopoverTrigger>
      {/* `align="start"` pins the popup's leading edge to the trigger's, which does not move. */}
      <PopoverContent align="start" className="w-136 gap-0 p-0">
        <div className="flex h-64">
          <div className="flex w-68 shrink-0 flex-col gap-0.5 overflow-y-auto p-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={() => onChange(everything ? [] : allPlaceKeys)}
            >
              <RiCheckDoubleLine data-icon="inline-start" />
              {everything ? "Clear All" : "Select All"}
              <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                {places.length}/{placeCount}
              </span>
            </Button>
            <Separator className="my-1" />

            <NavRow
              icon={MachineIcon}
              title={scopeCopy["runtime-host"].name}
              count={countAt(machinePlace, facet)}
              muted={!places.includes(machineKey)}
              active={user}
              onHighlight={() => setHighlight({ _tag: "user" })}
            />

            <span className="px-2 pt-3 pb-1 text-xs text-muted-foreground">Workspaces</span>
            {workspaces.map((entry) => {
              const keys = workspaceScopeKinds.map((kind) => scopeKey({ kind, workspaceId: entry.id }));
              const checked = keys.filter((key) => places.includes(key)).length;
              return (
                <NavRow
                  key={entry.id}
                  title={entry.name}
                  count={checked}
                  muted={checked === 0}
                  active={highlight._tag === "workspace" && highlight.id === entry.id}
                  onHighlight={() => setHighlight({ _tag: "workspace", id: entry.id as WorkspaceId })}
                />
              );
            })}
          </div>

          <Separator orientation="vertical" />

          <div className="flex min-w-0 flex-1 flex-col p-1.5">
            <div className="flex flex-col px-2 pt-1.5 pb-2">
              <span className="truncate text-sm font-medium">
                {user ? scopeCopy["runtime-host"].name : (workspace?.name ?? "")}
              </span>
              {/* The one place the checkout path is stated. */}
              <span className="truncate font-mono text-xs text-muted-foreground">
                {user ? "~/.cogwork" : (workspace?.checkoutPath ?? "")}
              </span>
            </div>
            <Separator />
            <div className="flex flex-col gap-0.5 pt-1">
              {shown.map((place) => {
                const key = scopeKey(place);
                return (
                  <PlaceRow
                    key={key}
                    place={place}
                    facet={facet}
                    checked={places.includes(key)}
                    onToggle={() => onChange(toggle(places, key))}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
