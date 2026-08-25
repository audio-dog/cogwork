// PROTOTYPE — Customize, Variant A: the location rail.
//
// The rail from the last round, rebuilt on the corrected model. Two things changed and both matter
// more than they look:
//
//   1. **No indent, no ladder.** The three are equal-weight places a file can live, not rungs. The
//      earlier version drew a staircase and taught precedence, which was the wrong idea.
//   2. **Multi-select, not a mode.** Because a contribution is turned on where it lives, the rail
//      never has to answer "where am I writing". It only narrows what is on screen, so checking two
//      boxes is meaningful and checking none is just an empty list.
//
// What survives from the mode version is the part that earned its keep: a rail has room to say what
// each place *means* and how much lives there, which a segmented control never did.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Checkbox } from "@cogwork/ui/components/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { ItemGroup } from "@cogwork/ui/components/item";
import { Label } from "@cogwork/ui/components/label";
import { Separator } from "@cogwork/ui/components/separator";
import { cn } from "@cogwork/ui/lib/utils";
import { RiSearchLine } from "@remixicon/react";
import { useState } from "react";
import { type ScopeKind, scopeDescriptions, scopeLabels, scopeOrder } from "../features/configuration-model";
import { scopeIcons } from "./configuration-atoms";
import { PluginsPanel } from "./configuration-plugins-panel";
import { WorkspacePicker } from "./customize-atoms";
import { definedAtCount, type Facet, visibleContributions } from "./customize-filter";
import { KindPills } from "./customize-kind-pills";
import { CustomizeRow } from "./customize-row";

const workspaceBound: readonly ScopeKind[] = ["workspace-input", "private-overlay"];

function LocationCard({
  kind,
  checked,
  count,
  onToggle,
}: {
  kind: ScopeKind;
  checked: boolean;
  count: number;
  onToggle: () => void;
}) {
  const Icon = scopeIcons[kind];
  return (
    <Label
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-lg border p-3 transition-colors",
        checked ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
      )}
    >
      <span className="flex items-center gap-2">
        <Icon />
        <span className="text-sm font-medium">{scopeLabels[kind]}</span>
        <Checkbox checked={checked} onCheckedChange={onToggle} className="ms-auto" />
      </span>
      <span className="text-xs font-normal text-muted-foreground">{scopeDescriptions[kind]}</span>
      <Badge variant={count > 0 ? "outline" : "ghost"} className="mt-1 w-fit">
        {count} here
      </Badge>
    </Label>
  );
}

export function CustomizeVariantA() {
  const [facet, setFacet] = useState<Facet>("skill");
  const [places, setPlaces] = useState<readonly ScopeKind[]>(scopeOrder);
  const [query, setQuery] = useState("");

  const toggle = (kind: ScopeKind) =>
    setPlaces((current) =>
      current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind],
    );

  const visible = visibleContributions(facet, places, query);
  const showWorkspace = places.some((kind) => workspaceBound.includes(kind));

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

      <KindPills facet={facet} places={places} onSelect={setFacet} />

      {facet === "plugins" ? (
        <PluginsPanel />
      ) : (
        <div className="flex min-h-0 gap-6">
          <div className="flex w-72 shrink-0 flex-col gap-2 self-start">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Where it lives</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setPlaces(places.length === scopeOrder.length ? [] : scopeOrder)}
              >
                {places.length === scopeOrder.length ? "None" : "All"}
              </Button>
            </div>
            <div className="flex flex-col gap-1.5">
              {scopeOrder.map((kind) => (
                <LocationCard
                  key={kind}
                  kind={kind}
                  checked={places.includes(kind)}
                  count={definedAtCount(kind, facet)}
                  onToggle={() => toggle(kind)}
                />
              ))}
            </div>
            {showWorkspace ? (
              <>
                <Separator className="my-1" />
                <WorkspacePicker label="in" />
              </>
            ) : null}
          </div>

          <div className="min-w-0 flex-1">
            {visible.length === 0 ? (
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
        </div>
      )}
    </div>
  );
}
