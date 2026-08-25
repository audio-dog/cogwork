// PROTOTYPE — Variant B: Scope on the spine.
//
// Two surfaces. Customize puts Scope on the spine, so you are always editing exactly one Scope and
// the write target is never ambiguous. The cells a Scope may not hold are rendered as decisions
// with their reason, not as blanks — ADR 0013's empty cells are empty by decision.
//
// What this shape has to survive: an Operation setting also carries a *level* (default, Workflow,
// Operation), and the level is consulted before Scope. A Scope spine cannot show that on its own.

import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@cogwork/ui/components/select";
import { Separator } from "@cogwork/ui/components/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@cogwork/ui/components/tabs";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { RiErrorWarningLine, RiInformationLine } from "@remixicon/react";
import { useState } from "react";
import {
  type Contribution,
  type ContributionKind,
  contributionKinds,
  enablementScopes,
  kindLabelsPlural,
  type OperationSettingKey,
  operationSettingScopes,
  type ScopeKind,
  type ScopeRef,
  scopeIdentity,
  scopeLabels,
  scopeOrder,
  type WorkspaceId,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { resolveEnablement, rowAt } from "../features/configuration-resolve";
import {
  AuthorityBadge,
  DiagnosticBadge,
  describeScope,
  kindIcons,
  ReadinessBadge,
} from "./configuration-atoms";

const { workspaces, contributions, operations } = placeholderConfiguration;

const workspaceScopes: readonly ScopeKind[] = ["workspace-input", "private-overlay"];

function needsWorkspace(kind: ScopeKind): boolean {
  return workspaceScopes.includes(kind);
}

/** Why a Scope may not hold a kind. The reason is the decision, so it is stated rather than hidden. */
const exclusionReasons: Partial<Record<ScopeKind, string>> = {
  "workspace-input":
    "A repository you cloned must not start a process on your machine. It may still ship the file — an offer is data; an enablement is not.",
  "runtime-host":
    "The Runtime host holds machine facts: checkout paths, installed harnesses, where credentials live. It holds no contributions.",
};

function ContributionRowAtScope({ contribution, scope }: { contribution: Contribution; scope: ScopeRef }) {
  const here = rowAt(contribution, scope);
  const cell = here === undefined ? "unset" : here.value ? "on" : "off";
  const resolved = resolveEnablement(contribution, { workspaceId: scope.workspaceId });
  const Icon = kindIcons[contribution.kind];
  const failed = contribution.load._tag === "failed";
  const winsHere = resolved.winner !== undefined && resolved.winner === here;

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
          {here?.diagnostic ? <DiagnosticBadge diagnostic={here.diagnostic} /> : null}
          {failed ? <Badge variant="destructive">Failed to load</Badge> : null}
        </ItemTitle>
        <ItemDescription>{contribution.summary}</ItemDescription>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{contribution.file}</p>

        {failed && contribution.load._tag === "failed" ? (
          <p className="mt-1 text-xs text-destructive">{contribution.load.reason}</p>
        ) : null}

        {/* Inheritance, stated from where you are standing rather than as a merged value. */}
        {cell === "unset" ? (
          resolved.winner ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing written here. Inherits {resolved.effective ? "on" : "off"} from{" "}
              {describeScope(resolved.winner.scope, workspaces)}.
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing written here, and nothing at any other Scope. Not off — not there.
            </p>
          )
        ) : winsHere ? (
          <p className="mt-1 text-xs text-muted-foreground">
            This is the value a Run gets.
            {resolved.shadowed.length > 0
              ? ` It outranks ${resolved.shadowed.length} lower ${resolved.shadowed.length === 1 ? "Scope" : "Scopes"}.`
              : ""}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            Written here, but{" "}
            {resolved.winner
              ? `${describeScope(resolved.winner.scope, workspaces)} is higher and wins whole.`
              : "dropped before resolution."}
          </p>
        )}
      </ItemContent>
      <ItemActions>
        <ToggleGroup value={[cell]} disabled={failed} onValueChange={() => undefined} size="sm">
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
      </ItemActions>
    </Item>
  );
}

function KindBlock({ kind, scope }: { kind: ContributionKind; scope: ScopeRef }) {
  const permitted = enablementScopes[kind].includes(scope.kind);
  const rows = contributions.filter((contribution) => contribution.kind === kind);

  if (!permitted) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{kindLabelsPlural[kind]}</h3>
        {/* Empty by decision, so the decision is what gets rendered. */}
        <Alert>
          <RiInformationLine />
          <AlertTitle>Cannot be turned on at this Scope</AlertTitle>
          <AlertDescription>{exclusionReasons[scope.kind]}</AlertDescription>
        </Alert>
        {/* Inadmissible entries someone wrote anyway. Dropped, never silently. */}
        {rows
          .flatMap((contribution) =>
            contribution.rows
              .filter((row) => row.scope.kind === scope.kind && row.diagnostic !== undefined)
              .map((row) => ({ contribution, row })),
          )
          .map(({ contribution, row }) => (
            <div key={`${contribution.id}:${row.source}`} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-xs">{contribution.id}</span>
                {row.diagnostic ? <DiagnosticBadge diagnostic={row.diagnostic} /> : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{row.diagnostic?.detail}</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{row.source}</p>
            </div>
          ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{kindLabelsPlural[kind]}</h3>
      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No {kindLabelsPlural[kind]}</EmptyTitle>
            <EmptyDescription>Nothing contributes this kind yet.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {rows.map((contribution) => (
            <ContributionRowAtScope key={contribution.id} contribution={contribution} scope={scope} />
          ))}
        </ItemGroup>
      )}
    </div>
  );
}

const operationSettingKeys: readonly OperationSettingKey[] = [
  "enabled",
  "harness",
  "model",
  "effort",
  "permission-profile",
  "binding",
];

/**
 * The rows this Scope holds for Operation settings. Each carries a level, and the level is
 * consulted *before* Scope — which a Scope spine can report but cannot organize around.
 */
function OperationSettingsAtScope({ scope }: { scope: ScopeRef }) {
  const permittedKeys = operationSettingKeys.filter((key) =>
    operationSettingScopes[key].includes(scope.kind),
  );
  const rows = operations.flatMap((operation) =>
    operation.rows
      .filter((row) => row.scope.kind === scope.kind && row.scope.workspaceId === scope.workspaceId)
      .map((row) => ({ operation, row })),
  );

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Operation settings</h3>
      <p className="text-xs text-muted-foreground">
        This Scope may hold {permittedKeys.length === 0 ? "none of them" : permittedKeys.join(", ")}.
        {scope.kind === "runtime-host"
          ? " The Runtime host takes harness and nothing else: a machine chooses which harness is installed, not which model you pay for."
          : ""}
      </p>
      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing written here</EmptyTitle>
            <EmptyDescription>No Operation setting is written at this Scope.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {rows.map(({ operation, row }) => (
            <Item key={`${operation.id}:${row.key}:${row.level}`} variant="outline" className="items-start">
              <ItemContent>
                <ItemTitle className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{row.key}</span>
                  <Badge variant="outline">{row.level}</Badge>
                  <span className="text-muted-foreground">{operation.name}</span>
                </ItemTitle>
                <ItemDescription>{row.value}</ItemDescription>
                {row.refusedBy ? (
                  <p className="mt-1 text-xs text-destructive">
                    Refused by {row.refusedBy}. A ceiling constrains and names its source; it never
                    overwrites.
                  </p>
                ) : null}
              </ItemContent>
              <ItemActions>
                <Badge variant={row.refusedBy ? "destructive" : "secondary"}>
                  {row.refusedBy ? "refused" : "in effect at this Scope"}
                </Badge>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </div>
  );
}

export function ConfigurationVariantB() {
  const [scopeKindValue, setScopeKind] = useState<ScopeKind>("settings-profile");
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId>(workspaces[0].id);

  const scope: ScopeRef = needsWorkspace(scopeKindValue)
    ? { kind: scopeKindValue, workspaceId }
    : { kind: scopeKindValue };

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <RiInformationLine />
        <AlertTitle>You are editing exactly one Scope.</AlertTitle>
        <AlertDescription>
          Every switch below writes to {describeScope(scope, workspaces)} and nowhere else. Values from other
          Scopes appear as inheritance, never as something you can edit from here.
        </AlertDescription>
      </Alert>

      <Tabs value={scopeKindValue} onValueChange={(value) => setScopeKind(value as ScopeKind)}>
        <TabsList className="w-full">
          {scopeOrder.map((kind) => (
            <TabsTrigger key={kind} value={kind}>
              {scopeLabels[kind]}
            </TabsTrigger>
          ))}
        </TabsList>

        {scopeOrder.map((kind) => (
          <TabsContent key={kind} value={kind} className="flex flex-col gap-5 pt-4">
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                Identity: {scopeIdentity[kind]}. Position in the ladder: {scopeOrder.indexOf(kind) + 1} of{" "}
                {scopeOrder.length}, low to high.
              </p>
              {needsWorkspace(kind) ? (
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Workspace</Label>
                  <Select
                    value={workspaceId}
                    onValueChange={(value) => setWorkspaceId(String(value) as WorkspaceId)}
                  >
                    <SelectTrigger size="sm" className="w-72">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {workspaces.map((workspace) => (
                        <SelectItem key={workspace.id} value={workspace.id}>
                          {workspace.name} — {workspace.checkoutPath}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>

            <Separator />

            {contributionKinds.map((contributionKind) => (
              <KindBlock key={contributionKind} kind={contributionKind} scope={scope} />
            ))}

            <Separator />

            <OperationSettingsAtScope scope={scope} />

            {/*
              The finding this shape produces: Scope is one axis of three. Resolution is a triple of
              (scope set, operator, direction), and an Operation setting also carries a level that
              is consulted first. A spine can only ever be one of those axes.
            */}
            <Alert>
              <RiErrorWarningLine />
              <AlertTitle>Scope is one axis of three.</AlertTitle>
              <AlertDescription>
                An Operation setting's level — default, Workflow, or Operation — is consulted before Scope.
                Putting Scope on the spine reports the level but cannot organize around it.
              </AlertDescription>
            </Alert>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
