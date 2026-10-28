import type { WorkflowDocument } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@cogwork/ui/components/empty";
import { Switch } from "@cogwork/ui/components/switch";
import { RiAddLine, RiNodeTree } from "@remixicon/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { newWorkflowOperation } from "../features/workflow-defaults";
import { useWorkflowSession } from "../features/workflow-session";

const blankWorkflowDocument = (): WorkflowDocument => ({
  name: "Untitled Workflow",
  workspaces: { _tag: "Every" },
  triggers: [],
  operations: [newWorkflowOperation()],
});

function WorkflowRow({ id }: { readonly id: string }) {
  const { state, actions } = useWorkflowSession();
  const workflow = state.workflows.find((candidate) => candidate.id === id);
  if (!workflow) return null;
  const incomplete = workflow.diagnostics.filter(
    ({ class: diagnosticClass }) => diagnosticClass === "incomplete",
  );
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle>
            <Link
              to="/workflows/$workflowId"
              params={{ workflowId: workflow.id }}
              className="hover:underline"
            >
              {workflow.workingCopy.name}
            </Link>
          </CardTitle>
          <CardDescription>
            {workflow.workingCopy.triggers.length} Triggers · {workflow.workingCopy.operations.length}{" "}
            Operations
          </CardDescription>
        </div>
        {incomplete.length > 0 ? <Badge variant="secondary">Incomplete</Badge> : null}
        <Switch
          checked={workflow.enabled}
          onCheckedChange={(enabled) => actions.switchEnabled(workflow.id, enabled)}
          aria-label={`Turn ${workflow.workingCopy.name} on`}
        />
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {workflow.workingCopy.operations.map((operation) => (
          <Badge key={operation.id} variant="outline">
            {operation.name}
          </Badge>
        ))}
      </CardContent>
    </Card>
  );
}

function TemplateCards() {
  const { state, actions } = useWorkflowSession();
  const navigate = useNavigate();
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {state.templates.map((template) => (
        <Card key={template.id}>
          <CardHeader>
            <CardTitle>{template.name}</CardTitle>
            <CardDescription>{template.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              size="sm"
              onClick={async () => {
                const workflow = await actions.create(template.document);
                await navigate({ to: "/workflows/$workflowId", params: { workflowId: workflow.id } });
              }}
            >
              Use template
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function WorkflowCreation() {
  const { state, actions } = useWorkflowSession();
  const navigate = useNavigate();
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 py-8">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">New Workflow</h1>
        <p className="text-sm text-muted-foreground">Start empty or use a template.</p>
      </div>
      <Button
        className="self-start"
        onClick={async () => {
          const workflow = await actions.create(blankWorkflowDocument());
          await navigate({ to: "/workflows/$workflowId", params: { workflowId: workflow.id } });
        }}
      >
        <RiAddLine data-icon="inline-start" /> Start empty
      </Button>
      {state.templates.length > 0 ? <TemplateCards /> : null}
    </div>
  );
}

export function WorkflowsList() {
  const { state, meta } = useWorkflowSession();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-8">
      <div className="flex items-center gap-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Workflows</h1>
        <Button className="ms-auto" nativeButton={false} render={<Link to="/workflows/new" />}>
          <RiAddLine data-icon="inline-start" /> New Workflow
        </Button>
      </div>
      {meta.unreadable.map((failure) => (
        <Card key={failure.id}>
          <CardHeader>
            <CardTitle>{failure.id}</CardTitle>
            <CardDescription>{failure.message}</CardDescription>
          </CardHeader>
        </Card>
      ))}
      {state.workflows.length > 0 ? (
        <div className="flex flex-col gap-3">
          {state.workflows.map((workflow) => (
            <WorkflowRow key={workflow.id} id={workflow.id} />
          ))}
        </div>
      ) : state.loading ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiNodeTree />
            </EmptyMedia>
            <EmptyTitle>Loading Workflows</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RiNodeTree />
              </EmptyMedia>
              <EmptyTitle>No Workflows yet</EmptyTitle>
              <EmptyDescription>Start with a template or build one from scratch.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent />
          </Empty>
          <TemplateCards />
        </div>
      )}
    </div>
  );
}
