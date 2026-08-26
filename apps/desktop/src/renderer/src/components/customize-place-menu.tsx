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
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiArrowDownSLine, RiArrowRightSLine, RiCheckDoubleLine } from "@remixicon/react";
import { useState } from "react";
import {
  type ContributionKind,
  type ScopeRef,
  scopeCopy,
  scopeKey,
  type Workspace,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import {
  allPlaceKeys,
  countAt,
  machinePlace,
  placeCount,
  summarize,
  toggle,
  workspaceScopeKinds,
} from "../features/customize-places";
import { scopeIcons } from "./configuration-atoms";

const { workspaces } = placeholderConfiguration;
const MachineIcon = scopeIcons["runtime-host"];

type Highlight = { readonly _tag: "user" } | { readonly _tag: "workspace"; readonly id: Workspace["id"] };

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
      render={<button type="button" onClick={onHighlight} onMouseEnter={onHighlight} onFocus={onHighlight} />}
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

function PlaceRow({
  place,
  count,
  checked,
  onToggle,
}: {
  place: ScopeRef;
  count: number;
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
        <CountBadge count={count} muted={!checked} />
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
  kind,
  onChange,
  unavailable,
}: {
  places: readonly string[];
  kind?: ContributionKind;
  onChange: (next: readonly string[]) => void;
  unavailable?: string;
}) {
  const countFor = (place: ScopeRef) => (kind ? countAt(place, kind) : 0);
  const [highlight, setHighlight] = useState<Highlight>({ _tag: "user" });

  const machineKey = scopeKey(machinePlace);
  const everything = places.length === placeCount;
  const workspace =
    highlight._tag === "workspace" ? workspaces.find((entry) => entry.id === highlight.id) : undefined;
  const shown = placesOf(highlight, workspace);
  const user = highlight._tag === "user";

  const trigger = (
    <Button variant="outline" size="sm" className="rounded-full" disabled={unavailable !== undefined}>
      <MachineIcon data-icon="inline-start" />
      <span className="w-32 truncate text-start">
        {unavailable === undefined ? summarize(places) : scopeCopy["runtime-host"].name}
      </span>
      <RiArrowDownSLine data-icon="inline-end" />
    </Button>
  );

  if (unavailable !== undefined) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>{trigger}</TooltipTrigger>
        <TooltipContent className="max-w-72">{unavailable}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover>
      <PopoverTrigger render={trigger} />
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
              count={countFor(machinePlace)}
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
                  onHighlight={() => setHighlight({ _tag: "workspace", id: entry.id })}
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
                    count={countFor(place)}
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
