// PROTOTYPE — the settled parts of the place menu.
//
// Four decisions are fixed now and live here, so the variants can only differ in the right pane's
// body:
//
//   · Select All / Clear All is one toggle at the top of the left pane.
//   · The left pane groups the workspaces under a "Workspaces" label.
//   · Two panes, no footer.
//   · The checkout path appears in the right pane only. It was in both, and the same fact twice is
//     one fact too many — the left pane needs to identify a workspace, not describe it.
//
// A compound component with context rather than a render prop: the right pane needs the highlight,
// and passing it back out through a callback would put the menu's state in three places.

import { Button } from "@cogwork/ui/components/button";
import { Separator } from "@cogwork/ui/components/separator";
import { RiCheckDoubleLine } from "@remixicon/react";
import { createContext, type ReactNode, use, useState } from "react";
import { scopeCopy, scopeKey, type Workspace, type WorkspaceId } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { scopeIcons } from "./configuration-atoms";
import { CountBadge, MenuNavRow } from "./customize-menu-atoms";
import {
  allPlaceKeys,
  countAt,
  type Facet,
  machinePlace,
  placeCount,
  workspaceScopeKinds,
} from "./customize-places";

const { workspaces } = placeholderConfiguration;
const MachineIcon = scopeIcons["runtime-host"];

export type Highlight = { readonly _tag: "user" } | { readonly _tag: "workspace"; readonly id: WorkspaceId };

interface PlaceMenuValue {
  readonly highlight: Highlight;
  readonly workspace?: Workspace;
  readonly places: readonly string[];
  readonly facet: Facet;
  readonly onChange: (next: readonly string[]) => void;
}

const PlaceMenuContext = createContext<PlaceMenuValue>({
  highlight: { _tag: "user" },
  places: [],
  facet: "skill",
  onChange: () => undefined,
});

export function usePlaceMenu(): PlaceMenuValue {
  return use(PlaceMenuContext);
}

/** The right pane's header. The one place the checkout path is stated. */
export function PlaceMenuHeader() {
  const { highlight, workspace } = usePlaceMenu();
  const user = highlight._tag === "user";
  return (
    <>
      <div className="flex flex-col px-2 pt-1.5 pb-2">
        <span className="truncate text-sm font-medium">
          {user ? scopeCopy["runtime-host"].name : (workspace?.name ?? "")}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {user ? "~/.cogwork" : (workspace?.checkoutPath ?? "")}
        </span>
      </div>
      <Separator />
    </>
  );
}

export function PlaceMenu({
  places,
  facet,
  onChange,
  height = "h-64",
  children,
}: {
  places: readonly string[];
  facet: Facet;
  onChange: (next: readonly string[]) => void;
  height?: string;
  children: ReactNode;
}) {
  const [highlight, setHighlight] = useState<Highlight>({ _tag: "user" });
  const machineKey = scopeKey(machinePlace);
  const everything = places.length === placeCount;
  const workspace =
    highlight._tag === "workspace" ? workspaces.find((entry) => entry.id === highlight.id) : undefined;

  return (
    <PlaceMenuContext value={{ highlight, workspace, places, facet, onChange }}>
      <div className={`flex ${height}`}>
        <div className="flex w-[17rem] shrink-0 flex-col overflow-y-auto p-1.5">
          {/* One toggle, at the top, where a list action belongs. */}
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
          <Separator className="my-1.5" />

          <MenuNavRow
            icon={MachineIcon}
            title={scopeCopy["runtime-host"].name}
            active={highlight._tag === "user"}
            onHover={() => setHighlight({ _tag: "user" })}
            meta={<CountBadge count={countAt(machinePlace, facet)} muted={!places.includes(machineKey)} />}
          />

          <span className="px-2 pt-3 pb-1 text-xs text-muted-foreground">Workspaces</span>
          {workspaces.map((entry) => {
            const keys = workspaceScopeKinds.map((kind) => scopeKey({ kind, workspaceId: entry.id }));
            const checked = keys.filter((key) => places.includes(key)).length;
            return (
              <MenuNavRow
                key={entry.id}
                // No path here: the right pane states it, and stating it twice says nothing twice.
                title={entry.name}
                active={highlight._tag === "workspace" && highlight.id === entry.id}
                onHover={() => setHighlight({ _tag: "workspace", id: entry.id as WorkspaceId })}
                meta={<CountBadge count={checked} muted={checked === 0} />}
              />
            );
          })}
        </div>

        <Separator orientation="vertical" />

        <div className="flex min-w-0 flex-1 flex-col p-1.5">{children}</div>
      </div>
    </PlaceMenuContext>
  );
}

/** The places belonging to whatever the pointer is on, ready for a variant to render. */
export function useHighlightedPlaces() {
  const { highlight, workspace } = usePlaceMenu();
  if (highlight._tag === "user") return [machinePlace];
  if (!workspace) return [];
  return workspaceScopeKinds.map((kind) => ({ kind, workspaceId: workspace.id }));
}
