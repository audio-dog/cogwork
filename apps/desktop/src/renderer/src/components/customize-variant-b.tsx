// PROTOTYPE — place menu B: peer list, cards that fill.
//
// Two different fixes from menu A.
//
// The left pane stops special-casing User. It was a header-shaped thing sitting above a list of
// row-shaped things, which is what made the two panes look like two designs. Here User is simply
// the first entry, same anatomy as every workspace, and an "Everything" row above it carries
// select-all — a list action in the list, rather than a button bolted to the trigger.
//
// The right pane answers the negative space with content rather than a footer: each place is a card
// that grows to fill the height, so one place or two, the pane is full either way.

import { Button } from "@cogwork/ui/components/button";
import { Checkbox } from "@cogwork/ui/components/checkbox";
import { Label } from "@cogwork/ui/components/label";
import { Separator } from "@cogwork/ui/components/separator";
import { cn } from "@cogwork/ui/lib/utils";
import { RiCheckDoubleLine } from "@remixicon/react";
import { useState } from "react";
import { type ScopeKind, scopeCopy, scopeKey, type WorkspaceId } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { scopeIcons } from "./configuration-atoms";
import { CustomizePageShell, PlacePickerButton } from "./customize-atoms";
import { CountBadge, MenuNavRow } from "./customize-menu-atoms";
import {
  allPlaceKeys,
  countAt,
  type Facet,
  machinePlace,
  placeCount,
  toggle,
  workspaceScopeKinds,
} from "./customize-places";

const { workspaces } = placeholderConfiguration;
const MachineIcon = scopeIcons["runtime-host"];

type Highlight = { readonly _tag: "user" } | { readonly _tag: "workspace"; readonly id: WorkspaceId };

/** Grows to fill, so a pane holding one place looks as deliberate as a pane holding two. */
function PlaceCard({
  kind,
  where,
  count,
  checked,
  onToggle,
}: {
  kind: ScopeKind;
  where: string;
  count: number;
  checked: boolean;
  onToggle: () => void;
}) {
  const Icon = scopeIcons[kind];
  return (
    <Label
      className={cn(
        "flex flex-1 cursor-pointer flex-col gap-1.5 rounded-lg border p-3 transition-colors",
        checked ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="text-muted-foreground">
          <Icon />
        </span>
        <span className="flex-1 text-sm font-medium">{scopeCopy[kind].name}</span>
        <CountBadge count={count} />
        <Checkbox checked={checked} onCheckedChange={onToggle} />
      </span>
      <span className="text-xs font-normal text-muted-foreground">{scopeCopy[kind].hint}</span>
      <span className="mt-auto truncate font-mono text-[11px] font-normal text-muted-foreground/80">
        {where}
      </span>
    </Label>
  );
}

function PeerMenu({
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

  return (
    <div className="flex h-72">
      <div className="flex w-[19rem] shrink-0 flex-col overflow-y-auto p-1.5">
        {/* A list action, in the list. */}
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={() => onChange(everything ? [] : allPlaceKeys)}
        >
          <RiCheckDoubleLine data-icon="inline-start" />
          {everything ? "Clear everything" : "Select everything"}
          <span className="ms-auto text-xs text-muted-foreground tabular-nums">
            {places.length}/{placeCount}
          </span>
        </Button>
        <Separator className="my-1.5" />

        {/* User is a peer of the workspaces, not a header above them. */}
        <MenuNavRow
          icon={MachineIcon}
          title={scopeCopy["runtime-host"].name}
          subtitle="~/.cogwork"
          active={highlight._tag === "user"}
          onHover={() => setHighlight({ _tag: "user" })}
          meta={<CountBadge count={countAt(machinePlace, facet)} muted={!places.includes(machineKey)} />}
        />
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
      </div>

      <Separator orientation="vertical" />

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-2">
        {highlight._tag === "user" ? (
          <PlaceCard
            kind="runtime-host"
            where="~/.cogwork"
            count={countAt(machinePlace, facet)}
            checked={places.includes(machineKey)}
            onToggle={() => onChange(toggle(places, machineKey))}
          />
        ) : active ? (
          workspaceScopeKinds.map((kind) => {
            const place = { kind, workspaceId: active.id };
            const key = scopeKey(place);
            return (
              <PlaceCard
                key={kind}
                kind={kind}
                where={kind === "workspace-input" ? `${active.checkoutPath}/.cogwork` : "~/.cogwork/overlays"}
                count={countAt(place, facet)}
                checked={places.includes(key)}
                onToggle={() => onChange(toggle(places, key))}
              />
            );
          })
        ) : null}
      </div>
    </div>
  );
}

export function CustomizeVariantB() {
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
          <PeerMenu places={places} facet={facet} onChange={setPlaces} />
        </PlacePickerButton>
      }
    />
  );
}
