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
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowDownSLine, RiArrowRightSLine, RiCheckDoubleLine } from "@remixicon/react";
import { type ComponentProps, type ReactNode, useState } from "react";

import { scopeIcons } from "../features/configuration-icons";
import {
  type ContributionKind,
  type ScopeRef,
  scopeCopy,
  scopeKey,
  type Workspace,
} from "../features/configuration-model";
import { profilePlace, workspaceScopeKinds } from "../features/customize-places";
import { useConfiguration } from "./configuration-provider";
import { useCustomizeFilter } from "./customize-filter";

const ProfileIcon = scopeIcons["settings-profile"];

type Highlight = { readonly _tag: "user" } | { readonly _tag: "workspace"; readonly id: Workspace["id"] };

/** How much of a place is picked. Distinct from `count`, which is how much lives there. */
type Selection = "none" | "some" | "all";

const selectionOf = (picked: number, total: number): Selection => {
  if (picked === 0) return "none";
  return picked === total ? "all" : "some";
};

/**
 * `PopoverTrigger` hosts this through `render`, which injects the ref, the click handler and the
 * ARIA wiring as props. They have to reach the native button or the menu never opens, so this
 * spreads everything it is given.
 */
function PlaceTrigger({ label, className, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Button variant="outline" size="sm" {...props} className={cn("rounded-full", className)}>
      <ProfileIcon data-icon="inline-start" />
      <span className="w-32 truncate text-start">{label}</span>
      <RiArrowDownSLine data-icon="inline-end" />
    </Button>
  );
}

function CountBadge({ count, selection }: { count: number; selection: Selection }) {
  return (
    <Badge
      variant={selection === "none" || count === 0 ? "ghost" : "outline"}
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
  selection,
  active,
  onHighlight,
}: {
  icon?: typeof ProfileIcon;
  title: string;
  count: number;
  selection: Selection;
  active: boolean;
  onHighlight: () => void;
}) {
  return (
    <Item
      size="xs"
      variant={active ? "muted" : "default"}
      render={
        <button
          type="button"
          aria-label={title}
          onClick={onHighlight}
          onMouseEnter={onHighlight}
          onFocus={onHighlight}
        />
      }
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
        <CountBadge count={count} selection={selection} />
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
        <CountBadge count={count} selection={checked ? "all" : "none"} />
      </ItemActions>
    </Item>
  );
}

/**
 * The Place filter for a Facet whose rows live somewhere. `kind` is what the counts count.
 */
export function CustomizePlaceMenu({ kind }: { kind: ContributionKind }) {
  const {
    state: { picture },
    meta: { places: placeAxis },
  } = useConfiguration();
  const {
    state: { places },
    actions: { setPlaces, togglePlace },
  } = useCustomizeFilter();
  const [highlight, setHighlight] = useState<Highlight>({ _tag: "user" });

  const { workspaces } = picture;
  const profileKey = scopeKey(profilePlace);
  const everything = places.length === placeAxis.placeCount;
  const workspace =
    highlight._tag === "workspace" ? workspaces.find((entry) => entry.id === highlight.id) : undefined;
  const user = highlight._tag === "user";
  const shown: readonly ScopeRef[] = user
    ? [profilePlace]
    : workspace
      ? workspaceScopeKinds.map((scopeKind) => ({ kind: scopeKind, workspaceId: workspace.id }))
      : [];

  return (
    <Popover>
      <PopoverTrigger render={<PlaceTrigger label={placeAxis.summarize(places)} />} />
      <PopoverContent align="start" className="w-136 gap-0 p-0">
        <div className="flex h-64">
          <div className="flex w-68 shrink-0 flex-col gap-0.5 overflow-y-auto p-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={() => setPlaces(everything ? [] : placeAxis.allPlaceKeys)}
            >
              <RiCheckDoubleLine data-icon="inline-start" />
              {everything ? "Clear All" : "Select All"}
              <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                {places.length}/{placeAxis.placeCount}
              </span>
            </Button>
            <Separator className="my-1" />

            <NavRow
              icon={ProfileIcon}
              title={scopeCopy["settings-profile"].name}
              count={placeAxis.countAt(profilePlace, kind)}
              selection={places.includes(profileKey) ? "all" : "none"}
              active={user}
              onHighlight={() => setHighlight({ _tag: "user" })}
            />

            <span className="px-2 pt-3 pb-1 text-xs text-muted-foreground">Workspaces</span>
            {workspaces.map((entry) => {
              const keys = workspaceScopeKinds.map((scopeKind) =>
                scopeKey({ kind: scopeKind, workspaceId: entry.id }),
              );
              const picked = keys.filter((key) => places.includes(key)).length;
              return (
                <NavRow
                  key={entry.id}
                  title={entry.name}
                  // How many contributions live here, matching the User row above. Selection is the
                  // badge's tone, never its number.
                  count={placeAxis.countInWorkspace(entry.id, kind)}
                  selection={selectionOf(picked, keys.length)}
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
                {user ? scopeCopy["settings-profile"].name : (workspace?.name ?? "")}
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
                    count={placeAxis.countAt(place, kind)}
                    checked={places.includes(key)}
                    onToggle={() => togglePlace(key)}
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

/**
 * The same control, for a Facet the Place axis does not apply to. A separate component rather than
 * a flag: it renders a tooltip over a disabled trigger, which shares nothing with the menu above.
 */
export function PlaceFilterNotApplicable({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <PlaceTrigger label={scopeCopy["settings-profile"].name} disabled />
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{children}</TooltipContent>
    </Tooltip>
  );
}
