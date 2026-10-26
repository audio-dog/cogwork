import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Separator } from "@cogwork/ui/components/separator";
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
import { mockWorkflows } from "../features/workflow-mock-data";
import { conditionKey, conditionLabel, type Operation, type Workflow } from "../features/workflow-model";
import {
  type ConsequenceKind,
  consequenceOf,
  operationsInOrder,
  outcomeRowsOf,
} from "../features/workflow-overview";
import { catalogIconFor } from "./workflow-catalog-menu";

const consequenceIcons: Record<Exclude<ConsequenceKind, "nothing">, ComponentType<{ className?: string }>> = {
  operation: RiRobot2Line,
  approval: RiPauseCircleLine,
  notification: RiNotification3Line,
  stop: RiStopCircleLine,
  action: RiShareForwardLine,
};

const isTouchpoint = (kind: ConsequenceKind) => kind === "approval" || kind === "notification";

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
        {outcomeRowsOf(operation).map((when) => {
          const consequence = consequenceOf(operation, when);
          const continues = consequence.kind === "operation" && consequence.action?.itemId === nextId;
          const Icon = consequence.kind === "nothing" ? null : consequenceIcons[consequence.kind];
          return (
            <div
              key={conditionKey(operation, when)}
              className="grid grid-cols-[minmax(0,11rem)_1fr] items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5"
            >
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
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkflowShape({ workflow }: { readonly workflow: Workflow }) {
  const operations = operationsInOrder(workflow);
  return (
    <div className="flex flex-col">
      <Triggers workflow={workflow} />
      {operations.map((operation, index) => (
        <div key={operation.id} className="flex flex-col">
          <Separator orientation="vertical" className="ms-4 h-3" />
          <OperationCard operation={operation} nextId={operations[index + 1]?.id ?? null} />
        </div>
      ))}
    </div>
  );
}

function WorkflowRow({ workflow }: { readonly workflow: Workflow }) {
  return (
    <Collapsible className="rounded-lg border bg-card">
      <div className="flex items-center gap-3 px-3 py-2">
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              aria-label={`Show ${workflow.name}`}
              className="group/row min-w-0 flex-1 justify-start gap-3"
            />
          }
        >
          <RiArrowRightSLine className="text-muted-foreground transition-transform group-data-[panel-open]/row:rotate-90" />
          <span className="truncate text-sm font-medium">{workflow.name}</span>
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
            {workflow.triggers.map((trigger) => {
              const Icon = catalogIconFor(trigger.icon);
              return <Icon key={choiceKey(trigger)} className="size-3.5" />;
            })}
          </span>
        </CollapsibleTrigger>
        <Switch size="sm" defaultChecked={workflow.enabled} aria-label={`Turn ${workflow.name} on`} />
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 border-t px-3 py-3">
          <WorkflowShape workflow={workflow} />
          <Button
            size="sm"
            variant="outline"
            className="self-end"
            nativeButton={false}
            render={<Link to="/workflows/$workflowId" params={{ workflowId: workflow.id }} />}
          >
            Edit
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function WorkflowsList() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 py-8">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Workflows</h1>
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
