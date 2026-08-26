// PROTOTYPE — place menu C: the preview fills the space.
//
// The other two answer the empty right pane with layout — a footer, or cards that stretch. This one
// answers it with information: under the place rows sits the list of what actually lives there.
//
// That turns the imbalance into a feature. Choosing a place is a guess until you know what is in it,
// and the count alone does not tell you whether `pr-summary` is the repo's or yours. The pane is
// full because it has something to say, not because something was stretched to fill it.
//
// The cost is a menu that has to scroll on a busy workspace, which the other two never do.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Separator } from "@cogwork/ui/components/separator";
import { RiCheckDoubleLine } from "@remixicon/react";
import { useState } from "react";
import type { Contribution, ScopeRef } from "../features/configuration-model";
import { scopeCopy, scopeKey, type WorkspaceId } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { kindIcons, scopeIcons } from "./configuration-atoms";
import { CustomizePageShell, PlacePickerButton } from "./customize-atoms";
import { CountBadge, MenuNavRow, MenuPlaceRow } from "./customize-menu-atoms";
import {
  allPlaceKeys,
  countAt,
  type Facet,
  machinePlace,
  placeCount,
  placeOf,
  toggle,
  workspaceScopeKinds,
} from "./customize-places";

const { workspaces, contributions } = placeholderConfiguration;
const MachineIcon = scopeIcons["runtime-host"];

type Highlight = { readonly _tag: "user" } | { readonly _tag: "workspace"; readonly id: WorkspaceId };

function livingAt(place: ScopeRef, facet: Facet): readonly Contribution[] {
  const key = scopeKey(place);
  return contributions.filter(
    (contribution) => placeOf(contribution) === key && (facet === "plugins" || contribution.kind === facet),
  );
}

/** What is actually in there. A count says how many; this says which. */
function Preview({ rows }: { rows: readonly Contribution[] }) {
  if (rows.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">Nothing of this kind lives here.</p>;
  }
  return (
    <div className="flex flex-col">
      {rows.map((contribution) => {
        const Icon = kindIcons[contribution.kind];
        return (
          <span key={contribution.id} className="flex items-center gap-2 px-2 py-1">
            <span className="text-muted-foreground">
              <Icon />
            </span>
            <span className="min-w-0 flex-1 truncate text-xs">{contribution.localName}</span>
            {contribution.load._tag === "failed" ? (
              <Badge variant="destructive" className="shrink-0">
                failed
              </Badge>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function PreviewMenu({
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
  const active = highlight._tag === "workspace" ? workspaces.find((w) => w.id === highlight.id) : undefined;
  const everything = places.length === placeCount;

  const shownPlaces: readonly ScopeRef[] =
    highlight._tag === "user"
      ? [machinePlace]
      : active
        ? workspaceScopeKinds.map((kind) => ({ kind, workspaceId: active.id }))
        : [];

  return (
    <div className="flex h-80">
      <div className="flex w-[18rem] shrink-0 flex-col overflow-y-auto p-1.5">
        <MenuNavRow
          icon={MachineIcon}
          title={scopeCopy["runtime-host"].name}
          subtitle="~/.cogwork"
          active={highlight._tag === "user"}
          onHover={() => setHighlight({ _tag: "user" })}
          meta={<CountBadge count={countAt(machinePlace, facet)} muted={!places.includes(machineKey)} />}
        />
        <span className="px-2 pt-3 pb-1 text-xs text-muted-foreground">Workspaces</span>
        {workspaces.map((workspace) => {
          const keys = workspaceScopeKinds.map((kind) => scopeKey({ kind, workspaceId: workspace.id }));
          const checked = keys.filter((key) => places.includes(key)).length;
          return (
            <MenuNavRow
              key={workspace.id}
              title={workspace.name}
              subtitle={workspace.checkoutPath}
              active={highlight._tag === "workspace" && highlight.id === workspace.id}
              onHover={() => setHighlight({ _tag: "workspace", id: workspace.id as WorkspaceId })}
              meta={<CountBadge count={checked} muted={checked === 0} />}
            />
          );
        })}
        <Separator className="my-1.5" />
        <Button
          variant="ghost"
          size="xs"
          className="justify-start"
          onClick={() => onChange(everything ? [] : allPlaceKeys)}
        >
          <RiCheckDoubleLine data-icon="inline-start" />
          {everything ? "Clear everything" : "Select everything"}
        </Button>
      </div>

      <Separator orientation="vertical" />

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-1.5">
        {shownPlaces.map((place, index) => {
          const key = scopeKey(place);
          const rows = livingAt(place, facet);
          return (
            <div key={key} className="flex flex-col">
              {index > 0 ? <Separator className="my-1.5" /> : null}
              <MenuPlaceRow
                name={scopeCopy[place.kind].name}
                hint={scopeCopy[place.kind].hint}
                count={rows.length}
                checked={places.includes(key)}
                onToggle={() => onChange(toggle(places, key))}
              />
              {/* The space the other two had to fill, filled with what is in the place. */}
              <div className="ps-7">
                <Preview rows={rows} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CustomizeVariantC() {
  const [facet, setFacet] = useState<Facet>("skill");
  const [places, setPlaces] = useState<readonly string[]>(allPlaceKeys);
  const [query, setQuery] = useState("");

  return (
    <CustomizePageShell
      facet={facet}
      onFacet={setFacet}
      places={places}
      query={query}
      onQuery={setQuery}
      picker={
        <PlacePickerButton places={places} menuWidth="36rem">
          <PreviewMenu places={places} facet={facet} onChange={setPlaces} />
        </PlacePickerButton>
      }
    />
  );
}
