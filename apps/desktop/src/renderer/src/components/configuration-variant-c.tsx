// PROTOTYPE — Variant C: Operation first.
//
// Two surfaces, and Customize is an inspector rather than an editor's index. You start from
// Workflow to Operation and read what the Run Plan resolves to; Scope appears only as provenance.
//
// The bet: the question a person actually arrives with is "why did this Run get that", and every
// other shape makes them assemble the answer themselves. The cost: a contribution nothing binds
// has no home here, so turning something on for the first time is awkward.

import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
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
import {
  RiArrowRightSLine,
  RiCheckLine,
  RiErrorWarningLine,
  RiInformationLine,
  RiShieldKeyholeLine,
} from "@remixicon/react";
import { useState } from "react";
import { withDraft } from "../features/configuration-draft";
import {
  contributionKinds,
  kindLabels,
  kindLabelsPlural,
  type Need,
  type Operation,
  type OperationSettingKey,
  type WorkspaceId,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { resolveEnablement, resolveOperationSetting } from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import { describeScope, kindIcons } from "./configuration-atoms";

const { workspaces, contributions, operations, workflows } = placeholderConfiguration;

const workspaceItems = Object.fromEntries(
  workspaces.map((workspace) => [workspace.id, `${workspace.name} — ${workspace.checkoutPath}`]),
);

const inspectedKeys: readonly OperationSettingKey[] = [
  "enabled",
  "harness",
  "model",
  "effort",
  "permission-profile",
];

function NeedRow({ need }: { need: Need }) {
  const bound = contributions.find((entry) => entry.id === need.boundContributionId);
  const Icon = kindIcons[need.kind];
  return (
    <Item variant="outline" className="items-start">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-1.5">
          {need.label}
          <Badge variant="outline">{kindLabels[need.kind]}</Badge>
          <Badge variant={need.satisfied ? "secondary" : "destructive"}>
            {need.satisfied ? "satisfied" : "unsatisfiable"}
          </Badge>
        </ItemTitle>
        <ItemDescription>
          {bound ? (
            <>
              Bound to <span className="font-mono">{bound.id}</span>
            </>
          ) : (
            "Nothing is bound to this need."
          )}
        </ItemDescription>
        {need.reason ? <p className="mt-1 text-xs text-destructive">{need.reason}</p> : null}
      </ItemContent>
      <ItemActions>
        <Button size="sm" variant="outline">
          {bound ? "Re-bind" : "Bind"}
        </Button>
      </ItemActions>
    </Item>
  );
}

function SettingRow({
  operation,
  settingKey,
  workspaceId,
}: {
  operation: Operation;
  settingKey: OperationSettingKey;
  workspaceId: WorkspaceId;
}) {
  const resolved = resolveOperationSetting(operation, settingKey, { workspaceId });
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium">{settingKey}</span>
        {resolved.locked ? <Badge variant="outline">locked by the Definition</Badge> : null}
        <span className="ms-auto font-mono text-sm">{resolved.value ?? "—"}</span>
      </div>

      {resolved.winner ? (
        <p className="text-xs text-muted-foreground">
          {/* The level first, then the Scope — the order resolution actually uses. */}
          {resolved.winner.level} level, at {describeScope(resolved.winner.scope, workspaces)}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing written. The Definition's default applies.</p>
      )}

      {resolved.refusedBy ? (
        <p className="text-xs text-destructive">
          A value was refused by {resolved.refusedBy}. The refusal names its source, so it can be debugged; a
          silent override could not be.
        </p>
      ) : null}

      {resolved.shadowed.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="xs" className="w-fit" />}>
            {resolved.shadowed.length} shadowed {resolved.shadowed.length === 1 ? "candidate" : "candidates"}
            <RiArrowRightSLine data-icon="inline-end" />
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-1 pt-1">
            {resolved.shadowed.map((row) => (
              <span key={`${row.level}:${row.scope.kind}`} className="text-xs text-muted-foreground">
                {row.value} — {row.level} level at {describeScope(row.scope, workspaces)}
              </span>
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** The `on` set for this workspace, grouped the way a Run Plan carries it. */
function RunPlanMembers({ workspaceId }: { workspaceId: WorkspaceId }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  // Edits made in Variant A or B land here, so the same change can be read three ways.
  const on = contributions.filter((contribution) => {
    if (contribution.load._tag === "failed") return false;
    return resolveEnablement(withDraft(contribution, cells), { workspaceId }).effective === true;
  });

  return (
    <div className="flex flex-col gap-3">
      {contributionKinds.map((kind) => {
        const members = on.filter((contribution) => contribution.kind === kind);
        const Icon = kindIcons[kind];
        return (
          <div key={kind} className="flex items-start gap-3">
            <span className="flex w-36 shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
              <Icon />
              {kindLabelsPlural[kind]}
            </span>
            <span className="flex flex-1 flex-wrap gap-1.5">
              {members.length === 0 ? (
                <span className="text-sm text-muted-foreground">none</span>
              ) : (
                members.map((contribution) => (
                  <Badge key={contribution.id} variant="outline" className="font-mono">
                    {contribution.id}
                  </Badge>
                ))
              )}
            </span>
          </div>
        );
      })}

      {/* Rules is a contribution kind that is *not* a Run Plan member — it resolves into Instructions. */}
      <Alert>
        <RiInformationLine />
        <AlertTitle>Rules do not travel as Rules.</AlertTitle>
        <AlertDescription>
          The Rules above resolve into Instructions, last and lowest against the Operating Instructions. They
          are advisory and can never satisfy a required need.
        </AlertDescription>
      </Alert>
    </div>
  );
}

function OperationInspector({ operation, workspaceId }: { operation: Operation; workspaceId: WorkspaceId }) {
  const unmet = operation.needs.filter((need) => !need.satisfied);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-xl font-semibold tracking-tight">{operation.name}</h2>
        <p className="text-sm text-muted-foreground">{operation.summary}</p>
      </div>

      {unmet.length > 0 ? (
        <Alert variant="destructive">
          <RiErrorWarningLine />
          <AlertTitle>This Operation's Run Plan is rejected before dispatch</AlertTitle>
          <AlertDescription>
            {unmet.length === 1 ? "One declared need" : `${unmet.length} declared needs`} cannot be satisfied.
            Every declared need is required, and a refusal before dispatch costs no tokens.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <RiCheckLine />
          <AlertTitle>Every declared need is satisfied</AlertTitle>
          <AlertDescription>
            The Engine would accept this Run Plan and dispatch it to{" "}
            {resolveOperationSetting(operation, "harness", { workspaceId }).value ?? "the default harness"}.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Required needs</CardTitle>
          <CardDescription>
            The Definition declares what is required. Settings bind. A Plugin only offers, and can never mark
            itself required for an Operation it does not own.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ItemGroup className="gap-2">
            {operation.needs.map((need) => (
              <NeedRow key={need.id} need={need} />
            ))}
          </ItemGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resolved settings</CardTitle>
          <CardDescription>
            The most specific level wins before Scope is consulted. This trace is embedded in the Run Plan,
            not recomputed later — a Run Plan whose provenance cannot be reconstructed is not one.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {inspectedKeys.map((key) => (
            <SettingRow key={key} operation={operation} settingKey={key} workspaceId={workspaceId} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What this Run would carry</CardTitle>
          <CardDescription>
            The contributions resolved on for this workspace. On / off is the entry gate; a binding only
            designates which of them serves a required need.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunPlanMembers workspaceId={workspaceId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <RiShieldKeyholeLine />
            Enforcement
          </CardTitle>
          <CardDescription>
            Three postures are hard. A Harness that cannot provide one fails before launch rather than
            claiming partial enforcement.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {["Non-interactive turn", "Worktree confinement", "Operation read / write posture"].map(
            (posture) => (
              <div key={posture} className="flex items-center justify-between gap-2">
                <span className="text-sm">{posture}</span>
                <Badge variant="outline">Enforced</Badge>
              </div>
            ),
          )}
          <Separator />
          <div className="flex items-start justify-between gap-2">
            <span className="flex flex-col">
              <span className="text-sm">Command globs, built-in tools, file events</span>
              <span className="text-xs text-muted-foreground">
                Coarse, and recorded as coarse. Nothing here reaches a contributed Hook's or MCP server's
                command.
              </span>
            </span>
            <Badge variant="secondary">Coarse</Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function ConfigurationVariantC() {
  const [operationId, setOperationId] = useState(operations[0].id);
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId>(workspaces[0].id);
  const operation = operations.find((entry) => entry.id === operationId) ?? operations[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-xs text-muted-foreground">Workspace</Label>
        <Select
          items={workspaceItems}
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

      <div className="flex min-h-0 gap-6">
        <nav className="flex w-56 shrink-0 flex-col gap-4">
          {workflows.map((workflow) => (
            <div key={workflow.id} className="flex flex-col gap-1">
              <span className="px-2 text-xs font-medium text-muted-foreground">{workflow.name}</span>
              {workflow.operationIds.map((id) => {
                const entry = operations.find((candidate) => candidate.id === id);
                if (!entry) return null;
                const unmet = entry.needs.some((need) => !need.satisfied);
                return (
                  <Button
                    key={id}
                    variant={id === operationId ? "secondary" : "ghost"}
                    size="sm"
                    className="justify-start"
                    onClick={() => setOperationId(id)}
                  >
                    {entry.name}
                    {unmet ? (
                      <RiErrorWarningLine data-icon="inline-end" className="ms-auto text-destructive" />
                    ) : null}
                  </Button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          <OperationInspector operation={operation} workspaceId={workspaceId} />
        </div>
      </div>
    </div>
  );
}
