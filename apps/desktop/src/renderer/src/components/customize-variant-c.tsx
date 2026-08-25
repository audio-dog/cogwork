// PROTOTYPE — Customize, Variant C: the split dropdown.
//
// The Cursor thread. One pill sits inline with the kind pills, divided from them, exactly as in the
// screenshot: a summary segment and a caret segment. The menu is split the same way the screenshot
// splits it — the machine on top, a divider, then a Workspaces section.
//
// The advantage over a rail is not compactness, though it is compact. It is that **one control can
// name a workspace and a place at the same time**. The rail has to hand the workspace question to a
// second control below it, because "Repository" is not a complete answer until you say which one.
// Here "cogwork › Repository" is a single row and a single click.
//
// The cost is that the current selection is a summary string until you open it, so a person who has
// forgotten what is checked has to go and look.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Checkbox } from "@cogwork/ui/components/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { ItemGroup } from "@cogwork/ui/components/item";
import { Label } from "@cogwork/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@cogwork/ui/components/popover";
import { Separator } from "@cogwork/ui/components/separator";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowDownSLine, RiSearchLine } from "@remixicon/react";
import { useState } from "react";
import {
  type ScopeKind,
  scopeDescriptions,
  scopeLabels,
  scopeOrder,
  scopeShortLabels,
  type WorkspaceId,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { useCustomizeViewStore } from "../store/customize-view";
import { scopeIcons } from "./configuration-atoms";
import { PluginsPanel } from "./configuration-plugins-panel";
import { definedAtCount, type Facet, visibleContributions } from "./customize-filter";
import { KindPills } from "./customize-kind-pills";
import { CustomizeRow } from "./customize-row";

const { workspaces } = placeholderConfiguration;

const workspaceBound: readonly ScopeKind[] = ["workspace-input", "private-overlay"];

const MachineIcon = scopeIcons["runtime-host"];

function summarize(places: readonly ScopeKind[], workspaceName: string): string {
  if (places.length === 0) return "Nowhere";
  if (places.length === scopeOrder.length) return "Everywhere";
  const [first, ...rest] = places;
  const head = workspaceBound.includes(first)
    ? `${workspaceName} · ${scopeShortLabels[first]}`
    : scopeShortLabels[first];
  return rest.length === 0 ? head : `${head} +${rest.length}`;
}

function PlaceRow({
  kind,
  checked,
  count,
  onToggle,
  indented,
}: {
  kind: ScopeKind;
  checked: boolean;
  count: number;
  onToggle: () => void;
  indented?: boolean;
}) {
  const Icon = scopeIcons[kind];
  return (
    <Label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent",
        indented && "ps-6",
      )}
    >
      {indented ? null : <Icon />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-normal">
          {indented ? scopeShortLabels[kind] : scopeLabels[kind]}
        </span>
        <span className="truncate text-xs text-muted-foreground">{scopeDescriptions[kind]}</span>
      </span>
      <Badge variant="ghost" className="px-1">
        {count}
      </Badge>
      <Checkbox checked={checked} onCheckedChange={onToggle} />
    </Label>
  );
}

function SplitPlacePicker({
  places,
  facet,
  onToggle,
  onSetAll,
}: {
  places: readonly ScopeKind[];
  facet: Facet;
  onToggle: (kind: ScopeKind) => void;
  onSetAll: (next: readonly ScopeKind[]) => void;
}) {
  const workspaceId = useCustomizeViewStore((state) => state.workspaceId);
  const setWorkspaceId = useCustomizeViewStore((state) => state.setWorkspaceId);
  const active = workspaces.find((workspace) => workspace.id === workspaceId) ?? workspaces[0];
  const everywhere = places.length === scopeOrder.length;

  return (
    <div className="flex items-stretch rounded-full border border-input">
      {/* Left half of the split: the summary, and a one-click way back to everything. */}
      <Button
        variant="ghost"
        size="sm"
        className="rounded-s-full rounded-e-none border-0 pe-2"
        onClick={() => onSetAll(everywhere ? [] : scopeOrder)}
      >
        <MachineIcon />
        <span className="max-w-48 truncate">{summarize(places, active.name)}</span>
      </Button>
      <Separator orientation="vertical" />
      {/* Right half: the menu, split the way the screenshot splits it. */}
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
        <PopoverContent align="start" className="w-[26rem] p-0">
          <div className="flex flex-col gap-0.5 p-2">
            <PlaceRow
              kind="runtime-host"
              checked={places.includes("runtime-host")}
              count={definedAtCount("runtime-host", facet)}
              onToggle={() => onToggle("runtime-host")}
            />
          </div>
          <Separator />
          <div className="flex flex-col gap-0.5 p-2">
            <span className="px-2 py-1 text-xs text-muted-foreground">Workspaces</span>
            {workspaces.map((workspace) => (
              <div key={workspace.id} className="flex flex-col">
                <button
                  type="button"
                  onClick={() => setWorkspaceId(workspace.id as WorkspaceId)}
                  className={cn(
                    "flex flex-col rounded-md px-2 py-1 text-start hover:bg-accent",
                    workspace.id === active.id && "bg-accent/60",
                  )}
                >
                  <span className="text-sm font-medium">{workspace.name}</span>
                  {/* The path, not the remote: two of these share one remote. */}
                  <span className="font-mono text-xs text-muted-foreground">{workspace.checkoutPath}</span>
                </button>
                {workspace.id === active.id
                  ? workspaceBound.map((kind) => (
                      <PlaceRow
                        key={kind}
                        kind={kind}
                        indented
                        checked={places.includes(kind)}
                        count={definedAtCount(kind, facet)}
                        onToggle={() => onToggle(kind)}
                      />
                    ))
                  : null}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function CustomizeVariantC() {
  const [facet, setFacet] = useState<Facet>("skill");
  const [places, setPlaces] = useState<readonly ScopeKind[]>(scopeOrder);
  const [query, setQuery] = useState("");

  const toggle = (kind: ScopeKind) =>
    setPlaces((current) =>
      current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind],
    );

  const visible = visibleContributions(facet, places, query);

  return (
    <div className="flex flex-col gap-4">
      <InputGroup>
        <InputGroupInput
          placeholder="Search contributions…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <InputGroupAddon>
          <RiSearchLine />
        </InputGroupAddon>
      </InputGroup>

      <KindPills facet={facet} places={places} onSelect={setFacet}>
        <SplitPlacePicker places={places} facet={facet} onToggle={toggle} onSetAll={setPlaces} />
      </KindPills>

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
