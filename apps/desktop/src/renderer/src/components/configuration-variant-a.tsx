// PROTOTYPE — Variant A: the facet bar.
//
// One surface. Plugins is a seventh pill beside the six contribution kinds, and Scope is a
// multi-select filter that unions what is in view. This is the shape Claude Code arrived at,
// ported honestly onto cogwork's four Scopes rather than its three tiers — which is the point:
// the port is where the shape either holds or breaks.

import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Checkbox } from "@cogwork/ui/components/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { Label } from "@cogwork/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@cogwork/ui/components/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@cogwork/ui/components/select";
import { Separator } from "@cogwork/ui/components/separator";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { cn } from "@cogwork/ui/lib/utils";
import { RiBox3Line, RiErrorWarningLine, RiFilter3Line, RiSearchLine, RiStore2Line } from "@remixicon/react";
import { useState } from "react";
import {
  type Contribution,
  type ContributionKind,
  contributionKinds,
  kindLabelsPlural,
  type ScopeRef,
  sameScope,
  scopeKey,
  scopeLabels,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import {
  cellPermitted,
  isOfferedNotEnabled,
  resolveEnablement,
  rowAt,
} from "../features/configuration-resolve";
import {
  AuthorityBadge,
  DiagnosticBadge,
  describeScope,
  kindIcons,
  ReadinessBadge,
  scopeIcons,
} from "./configuration-atoms";
import { PluginsPanel } from "./configuration-plugins-panel";

type Facet = "plugins" | ContributionKind;

const { workspaces, contributions } = placeholderConfiguration;

/** Every Scope instance a person could check or write to on this machine. */
const scopeInstances: readonly ScopeRef[] = [
  { kind: "settings-profile" },
  { kind: "runtime-host" },
  ...workspaces.flatMap((workspace) => [
    { kind: "workspace-input" as const, workspaceId: workspace.id },
    { kind: "private-overlay" as const, workspaceId: workspace.id },
  ]),
];

const defaultChecked = [
  scopeKey({ kind: "settings-profile" }),
  scopeKey({ kind: "workspace-input", workspaceId: workspaces[0].id }),
  scopeKey({ kind: "private-overlay", workspaceId: workspaces[0].id }),
];

function ScopeFilter({ checked, onToggle }: { checked: readonly string[]; onToggle: (key: string) => void }) {
  const machineScopes = scopeInstances.filter((scope) => scope.workspaceId === undefined);
  const label =
    checked.length === 0
      ? "No Scope"
      : `${describeScope(scopeInstances.find((s) => scopeKey(s) === checked[0]) ?? machineScopes[0], workspaces)}${
          checked.length > 1 ? ` +${checked.length - 1}` : ""
        }`;

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="rounded-full" />}>
        <RiFilter3Line data-icon="inline-start" />
        <span className="max-w-52 truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-0">
        <div className="flex flex-col gap-1 p-2">
          {machineScopes.map((scope) => {
            const key = scopeKey(scope);
            const Icon = scopeIcons[scope.kind];
            return (
              <Label
                key={key}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
              >
                <Icon />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{scopeLabels[scope.kind]}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {scope.kind === "settings-profile"
                      ? placeholderConfiguration.principal
                      : `this machine · ${placeholderConfiguration.hostId}`}
                  </span>
                </span>
                <Checkbox checked={checked.includes(key)} onCheckedChange={() => onToggle(key)} />
              </Label>
            );
          })}
        </div>
        <Separator />
        <div className="flex flex-col gap-1 p-2">
          <span className="px-2 py-1 text-xs text-muted-foreground">Workspaces</span>
          {workspaces.map((workspace) => (
            <div key={workspace.id} className="flex flex-col">
              <span className="px-2 pt-1 text-sm font-medium">{workspace.name}</span>
              {/* The checkout path, not the remote: two of these workspaces share one remote. */}
              <span className="px-2 pb-1 font-mono text-xs text-muted-foreground">
                {workspace.checkoutPath}
              </span>
              {/* One checkbox per workspace cannot say which of the two workspace Scopes is meant. */}
              {(["workspace-input", "private-overlay"] as const).map((kind) => {
                const scope: ScopeRef = { kind, workspaceId: workspace.id };
                const key = scopeKey(scope);
                return (
                  <Label
                    key={key}
                    className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 ps-4 hover:bg-accent"
                  >
                    <span className="flex-1 truncate text-sm text-muted-foreground">
                      {scopeLabels[kind]}
                      {kind === "workspace-input" ? " (committed)" : " (yours, uncommitted)"}
                    </span>
                    <Checkbox checked={checked.includes(key)} onCheckedChange={() => onToggle(key)} />
                  </Label>
                );
              })}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ContributionRow({
  contribution,
  viewScopes,
  writeScope,
}: {
  contribution: Contribution;
  viewScopes: readonly ScopeRef[];
  writeScope: ScopeRef;
}) {
  // Resolution over the checked Scopes only — which is not what a Run resolves over.
  const scoped: Contribution = {
    ...contribution,
    rows: contribution.rows.filter((row) => viewScopes.some((scope) => sameScope(scope, row.scope))),
  };
  const resolved = resolveEnablement(scoped, { workspaceId: writeScope.workspaceId });
  const Icon = kindIcons[contribution.kind];
  const permitted = cellPermitted(contribution.kind, writeScope.kind);
  const written = rowAt(contribution, writeScope);
  const cell = written === undefined ? "unset" : written.value ? "on" : "off";
  const failed = contribution.load._tag === "failed";

  return (
    <Item variant="outline" className="items-start">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{contribution.localName}</span>
          <AuthorityBadge authority={contribution.authority} />
          {contribution.readiness ? <ReadinessBadge readiness={contribution.readiness} /> : null}
          {resolved.dropped.map((entry) => (
            <DiagnosticBadge key={entry.diagnostic._tag} diagnostic={entry.diagnostic} />
          ))}
          {failed ? <Badge variant="destructive">Failed to load</Badge> : null}
        </ItemTitle>
        <ItemDescription>{contribution.summary}</ItemDescription>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{contribution.file}</p>

        {failed && contribution.load._tag === "failed" ? (
          <p className="mt-1 text-xs text-destructive">{contribution.load.reason}</p>
        ) : null}

        {resolved.winner ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {resolved.effective ? "On" : "Off"} — set at {describeScope(resolved.winner.scope, workspaces)}
            {resolved.shadowed.length > 0
              ? `, over ${resolved.shadowed.length} lower ${resolved.shadowed.length === 1 ? "Scope" : "Scopes"}`
              : ""}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            Nothing written at any checked Scope. Not off — not there.
          </p>
        )}

        {isOfferedNotEnabled(contribution, resolved) && contribution.authority._tag === "local" ? (
          <p className="mt-1 text-xs text-muted-foreground">
            This repository offers this {contribution.kind === "hook" ? "Hook" : "MCP server"}. It is off. You
            can turn it on.
          </p>
        ) : null}
      </ItemContent>
      <ItemActions className="flex-col items-end gap-1">
        <ToggleGroup value={[cell]} disabled={!permitted || failed} onValueChange={() => undefined} size="sm">
          <ToggleGroupItem value="on" aria-label="On">
            On
          </ToggleGroupItem>
          <ToggleGroupItem value="off" aria-label="Off">
            Off
          </ToggleGroupItem>
          <ToggleGroupItem value="unset" aria-label="Not set">
            Not set
          </ToggleGroupItem>
        </ToggleGroup>
        {permitted ? null : (
          <span className="max-w-52 text-end text-xs text-muted-foreground">
            A {contribution.kind} may not be written at {scopeLabels[writeScope.kind]}.
          </span>
        )}
      </ItemActions>
    </Item>
  );
}

export function ConfigurationVariantA() {
  const [facet, setFacet] = useState<Facet>("plugins");
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<readonly string[]>(defaultChecked);
  const [writeKey, setWriteKey] = useState(defaultChecked[0]);

  const viewScopes = scopeInstances.filter((scope) => checked.includes(scopeKey(scope)));
  const writeScope = scopeInstances.find((scope) => scopeKey(scope) === writeKey) ?? scopeInstances[0];

  const toggle = (key: string) =>
    setChecked((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );

  const needle = query.trim().toLowerCase();
  const visible = contributions
    .filter((contribution) => facet !== "plugins" && contribution.kind === facet)
    .filter((contribution) =>
      needle === ""
        ? true
        : `${contribution.localName} ${contribution.summary}`.toLowerCase().includes(needle),
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <InputGroup className="flex-1">
          <InputGroupInput
            placeholder="Search Plugins, Skills, MCP servers…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <InputGroupAddon>
            <RiSearchLine />
          </InputGroupAddon>
        </InputGroup>
        <Button className="rounded-full">
          <RiStore2Line data-icon="inline-start" />
          Browse catalog
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ScopeFilter checked={checked} onToggle={toggle} />
        <Separator orientation="vertical" className="h-6" />
        <Button
          variant={facet === "plugins" ? "secondary" : "outline"}
          size="sm"
          className="rounded-full"
          onClick={() => setFacet("plugins")}
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
            onClick={() => setFacet(kind)}
          >
            {kindLabelsPlural[kind]}
          </Button>
        ))}
      </div>

      {facet === "plugins" ? (
        <PluginsPanel />
      ) : (
        <div className="flex flex-col gap-3">
          {/*
            The honest cost of a union filter: it says what is *visible*, and ADR 0013 fixed a
            direction that says what *won*. Those are different questions, and a Run only ever
            asks the second one.
          */}
          <Alert>
            <RiErrorWarningLine />
            <AlertTitle>This filter narrows resolution, not just the view.</AlertTitle>
            <AlertDescription>
              The value on each row is resolved over the {viewScopes.length} checked{" "}
              {viewScopes.length === 1 ? "Scope" : "Scopes"}. A Run resolves over all four, so what you read
              here can differ from what a Run gets.
            </AlertDescription>
          </Alert>

          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">
              {visible.length} {visible.length === 1 ? "row" : "rows"}
            </span>
            <div className="flex items-center gap-2">
              {/* A merged list has no inherent write target, so the target has to be named. */}
              <Label className="text-xs text-muted-foreground">Write to</Label>
              <Select value={writeKey} onValueChange={(value) => setWriteKey(String(value))}>
                <SelectTrigger size="sm" className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {viewScopes.map((scope) => (
                    <SelectItem key={scopeKey(scope)} value={scopeKey(scope)}>
                      {describeScope(scope, workspaces)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {visible.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No {kindLabelsPlural[facet as ContributionKind]}</EmptyTitle>
                <EmptyDescription>Nothing matches this search in the checked Scopes.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className={cn("gap-2")}>
              {visible.map((contribution) => (
                <ContributionRow
                  key={contribution.id}
                  contribution={contribution}
                  viewScopes={viewScopes}
                  writeScope={writeScope}
                />
              ))}
            </ItemGroup>
          )}
        </div>
      )}
    </div>
  );
}
