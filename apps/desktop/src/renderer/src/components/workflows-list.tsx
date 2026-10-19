import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Switch } from "@cogwork/ui/components/switch";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiAddLine,
  RiArrowRightSLine,
  RiNotification3Line,
  RiPauseCircleLine,
  RiRobot2Line,
  RiShareForwardLine,
  RiStopCircleLine,
} from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { choiceKey } from "../features/workflow-catalog";
import { mockWorkflows, mockWorkspaces } from "../features/workflow-mock-data";
import {
  type Condition,
  conditionKey,
  conditionLabel,
  type Operation,
  type Workflow,
} from "../features/workflow-model";
import {
  type ConsequenceKind,
  consequenceOf,
  outcomeCount,
  outcomeRowsOf,
  spineOf,
  workspaceScope,
} from "../features/workflow-overview";
import { catalogIconFor } from "./workflow-catalog-menu";

/**
 * The Workflows index. Each row opens onto the Workflow's shape: its Triggers, the Operations work
 * passes through, and where each outcome leads. Runs on mock data.
 */

const consequenceIcons: Record<Exclude<ConsequenceKind, "nothing">, ComponentType<{ className?: string }>> = {
  operation: RiRobot2Line,
  approval: RiPauseCircleLine,
  notification: RiNotification3Line,
  stop: RiStopCircleLine,
  action: RiShareForwardLine,
};

const isTouchpoint = (kind: ConsequenceKind) => kind === "approval" || kind === "notification";

function Connector() {
  return <span className="ms-4 h-3 w-px bg-border" />;
}

function Triggers({ workflow }: { readonly workflow: Workflow }) {
  return (
    <div className="flex flex-col gap-1.5">
      {workflow.triggers.map((trigger) => {
        const Icon = catalogIconFor(trigger.icon);
        return (
          <div
            key={choiceKey(trigger)}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed bg-muted/40 px-3 py-2"
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">{trigger.itemName}</span>
            {trigger.optionName ? (
              <Badge variant="outline" className="font-normal">
                {trigger.optionName}
              </Badge>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function OutcomeRow({
  operation,
  when,
  nextId,
}: {
  readonly operation: Operation;
  readonly when: Condition;
  readonly nextId: string | null;
}) {
  const consequence = consequenceOf(operation, when);
  const continues = consequence.kind === "operation" && consequence.step?.itemId === nextId;
  const Icon = consequence.kind === "nothing" ? null : consequenceIcons[consequence.kind];
  return (
    <div className="grid grid-cols-[minmax(0,11rem)_1fr] items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5">
      <Badge
        variant={continues ? "secondary" : "outline"}
        className="w-fit max-w-full truncate font-mono text-[10px] font-normal"
      >
        {conditionLabel(operation, when)}
      </Badge>
      <span
        className={cn(
          "flex items-center gap-1.5 text-xs",
          continues && "font-medium text-foreground",
          !continues && "text-muted-foreground",
          consequence.kind === "nothing" && "italic",
        )}
      >
        {Icon ? (
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              isTouchpoint(consequence.kind) && "text-primary",
              !isTouchpoint(consequence.kind) && "opacity-70",
            )}
          />
        ) : null}
        {consequence.name}
        {consequence.more > 0 ? <span className="text-muted-foreground">+{consequence.more}</span> : null}
      </span>
    </div>
  );
}

function OperationCard({
  operation,
  nextId,
}: {
  readonly operation: Operation;
  readonly nextId: string | null;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <RiRobot2Line className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{operation.name}</span>
      </div>
      <div className="flex flex-col gap-1">
        {outcomeRowsOf(operation).map((when) => (
          <OutcomeRow key={conditionKey(operation, when)} operation={operation} when={when} nextId={nextId} />
        ))}
      </div>
    </div>
  );
}

function WorkflowShape({ workflow }: { readonly workflow: Workflow }) {
  const spine = spineOf(workflow);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Triggers</h3>
      <Triggers workflow={workflow} />
      <Connector />
      <h3 className="text-xs font-medium text-muted-foreground">Operations</h3>
      <div className="flex flex-col">
        {spine.map((operation, index) => (
          <div key={operation.id} className="flex flex-col">
            {index > 0 ? <Connector /> : null}
            <OperationCard operation={operation} nextId={spine[index + 1]?.id ?? null} />
          </div>
        ))}
      </div>
    </div>
  );
}

function RowGist({ workflow }: { readonly workflow: Workflow }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="flex shrink-0 items-center gap-1">
        {workflow.triggers.map((trigger) => {
          const Icon = catalogIconFor(trigger.icon);
          return <Icon key={choiceKey(trigger)} className="size-3.5" />;
        })}
      </span>
      <span className="truncate">
        {spineOf(workflow)
          .map((operation) => operation.name)
          .join(" → ")}
      </span>
      <span className="shrink-0 whitespace-nowrap tabular-nums">{outcomeCount(workflow)} outcomes</span>
    </span>
  );
}

const lastRunLabel = (workflow: Workflow) =>
  workflow.activity.lastRun === "never" ? "No runs yet" : `Last run ${workflow.activity.lastRun}`;

function WorkflowRow({ workflow }: { readonly workflow: Workflow }) {
  return (
    <Collapsible className="rounded-lg border bg-card">
      <div className="flex items-center gap-3 px-3 py-2">
        <CollapsibleTrigger
          render={
            <button
              type="button"
              aria-label={`Show ${workflow.name}`}
              className="group/row flex min-w-0 flex-1 items-center gap-3 text-start outline-none"
            />
          }
        >
          <RiArrowRightSLine className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/row:rotate-90" />
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              workflow.enabled && "bg-primary",
              !workflow.enabled && "bg-muted-foreground/30",
            )}
          />
          <span className="flex shrink-0 items-center gap-2">
            <span className="text-sm font-medium">{workflow.name}</span>
            <Badge variant={workflow.origin === "cogwork" ? "outline" : "secondary"}>
              {workflow.origin === "cogwork" ? "Cogwork" : "Yours"}
            </Badge>
          </span>
          <RowGist workflow={workflow} />
        </CollapsibleTrigger>
        {workflow.activity.waiting > 0 ? (
          <Badge variant="secondary" className="shrink-0">
            <RiPauseCircleLine data-icon="inline-start" />
            {workflow.activity.waiting} waiting for you
          </Badge>
        ) : null}
        <Switch size="sm" defaultChecked={workflow.enabled} aria-label={`Turn ${workflow.name} on`} />
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 border-t px-3 py-3">
          <p className="text-sm text-muted-foreground">{workflow.summary}</p>
          <WorkflowShape workflow={workflow} />
          <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span>
              {workspaceScope(workflow, mockWorkspaces.length)} · {workflow.activity.runsLastWeek} runs this
              week · {lastRunLabel(workflow)}
            </span>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link to="/workflows/$workflowId" params={{ workflowId: workflow.id }} />}
            >
              Edit
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function WorkflowsList() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 py-8">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            Run agents when something happens in your tools, or on a schedule.
          </p>
        </div>
        <Button size="sm" nativeButton={false} render={<Link to="/workflows/new" />}>
          <RiAddLine data-icon="inline-start" />
          New Workflow
        </Button>
      </header>
      <div className="flex flex-col gap-1.5">
        {mockWorkflows.map((workflow) => (
          <WorkflowRow key={workflow.id} workflow={workflow} />
        ))}
      </div>
    </div>
  );
}
