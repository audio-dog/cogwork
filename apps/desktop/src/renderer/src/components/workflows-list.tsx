import type { WorkflowDocument } from "@cogwork/contracts";
import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cogwork/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@cogwork/ui/components/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiAddLine, RiDownloadLine, RiErrorWarningLine, RiNodeTree, RiUploadLine } from "@remixicon/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Effect, Result } from "effect";
import { type ChangeEvent, useRef, useState } from "react";

import { newWorkflowOperation } from "../features/workflow-defaults";
import { useWorkflowSession } from "../features/workflow-session";
import { exportWorkflow, importWorkflow, workflowExportFileName } from "../features/workflow-transfer";

const blankWorkflowDocument = (): WorkflowDocument => ({
  name: "Untitled Workflow",
  workspaces: { _tag: "Every" },
  triggers: [],
  operations: [newWorkflowOperation([])],
});

const stopCardActivation = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
  event.preventDefault();
  event.stopPropagation();
};

const fileDrag = (event: { readonly dataTransfer: DataTransfer | null }) => {
  const transfer = event.dataTransfer;
  if (!transfer) return null;
  // The file list stays empty until drop. "Files" is how the drag announces itself before then.
  for (const type of transfer.types) {
    if (type === "Files") return transfer;
  }
  return transfer.files.length > 0 ? transfer : null;
};

const downloadWorkflow = (workflow: WorkflowDocument) => {
  const url = URL.createObjectURL(new Blob([exportWorkflow(workflow)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = workflowExportFileName(workflow.name);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

function WorkflowRow({ id }: { readonly id: string }) {
  const { state, actions } = useWorkflowSession();
  const workflow = state.workflows.find((candidate) => candidate.id === id);
  if (!workflow) return null;
  const incomplete = workflow.diagnostics.filter(
    ({ class: diagnosticClass }) => diagnosticClass === "incomplete",
  );
  const enabledLabel = workflow.enabled ? "On" : "Off";
  const enabledAction = workflow.enabled ? "Turn off workflow" : "Turn on workflow";
  return (
    <Card className="relative">
      {/* The open target is a sibling of the buttons. An anchor around the card would nest those buttons. */}
      <Link
        to="/workflows/$workflowId"
        params={{ workflowId: workflow.id }}
        aria-label={workflow.workingCopy.name}
        className="absolute inset-0 cursor-pointer rounded-xl focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
        onKeyDown={(event) => {
          if (event.key !== " ") return;
          event.preventDefault();
          event.currentTarget.click();
        }}
      />
      <CardHeader className="pointer-events-none relative z-10">
        <CardTitle>{workflow.workingCopy.name}</CardTitle>
        <CardDescription>
          {workflow.workingCopy.triggers.length} Triggers · {workflow.workingCopy.operations.length}{" "}
          Operations
        </CardDescription>
        <CardAction className="pointer-events-auto flex items-center gap-2">
          {incomplete.length > 0 ? <Badge variant="secondary">Incomplete</Badge> : null}
          {/* Disabled buttons drop pointer events, so the tooltip listens on the wrapper. */}
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={workflow.publishedRevision === null}
                aria-pressed={workflow.enabled}
                className={cn(
                  workflow.enabled &&
                    "border-success/40 bg-success/10 text-success hover:bg-success/15 hover:text-success dark:border-success/40 dark:bg-success/15 dark:hover:bg-success/20",
                )}
                onClick={async (event) => {
                  stopCardActivation(event);
                  await actions.switchEnabled(workflow.id, !workflow.enabled);
                }}
              >
                {enabledLabel}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{enabledAction}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Export ${workflow.workingCopy.name}`}
                  onClick={(event) => {
                    stopCardActivation(event);
                    downloadWorkflow(workflow.workingCopy);
                  }}
                />
              }
            >
              <RiDownloadLine data-icon="inline-start" />
            </TooltipTrigger>
            <TooltipContent side="top">Export workflow to share</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent className="pointer-events-none relative z-10 flex flex-wrap gap-2">
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
  const { state, actions, meta } = useWorkflowSession();
  const navigate = useNavigate();
  const importInput = useRef<HTMLInputElement>(null);
  const [importFailure, setImportFailure] = useState<string | null>(null);
  const [fileOver, setFileOver] = useState(false);
  const importFile = async (file: File) => {
    const imported = await Effect.runPromise(importWorkflow(await file.text()).pipe(Effect.result));
    if (Result.isFailure(imported)) {
      setImportFailure(imported.failure.message);
      return;
    }
    setImportFailure(null);
    const workflow = await actions.create(imported.success);
    await navigate({ to: "/workflows/$workflowId/review", params: { workflowId: workflow.id } });
  };
  const onImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    await importFile(file);
  };
  // Listeners stay off the JSX. A drop target role would announce the whole list as a control.
  const watchImportDrop = (node: HTMLDivElement | null) => {
    if (!node) return;
    const onDragEnter = (event: DragEvent) => {
      if (!fileDrag(event)) return;
      event.preventDefault();
      setFileOver(true);
    };
    const onDragOver = (event: DragEvent) => {
      const transfer = fileDrag(event);
      if (!transfer) return;
      event.preventDefault();
      transfer.dropEffect = "copy";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!fileDrag(event)) return;
      const next = event.relatedTarget;
      if (next instanceof Node && node.contains(next)) return;
      setFileOver(false);
    };
    const onDrop = async (event: DragEvent) => {
      const transfer = fileDrag(event);
      if (!transfer) return;
      event.preventDefault();
      setFileOver(false);
      const file = transfer.files[0];
      if (!file) return;
      await importFile(file);
    };
    node.addEventListener("dragenter", onDragEnter);
    node.addEventListener("dragover", onDragOver);
    node.addEventListener("dragleave", onDragLeave);
    node.addEventListener("drop", onDrop);
    return () => {
      node.removeEventListener("dragenter", onDragEnter);
      node.removeEventListener("dragover", onDragOver);
      node.removeEventListener("dragleave", onDragLeave);
      node.removeEventListener("drop", onDrop);
    };
  };
  return (
    <div ref={watchImportDrop} className={cn("relative min-h-full", fileOver && "bg-muted/40")}>
      {fileOver ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <p className="text-sm font-medium">Drop to import</p>
        </div>
      ) : null}
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-8">
        <div className="flex items-center gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Workflows</h1>
          <div className="ms-auto flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => importInput.current?.click()}>
              <RiUploadLine data-icon="inline-start" /> Import
            </Button>
            <Button nativeButton={false} render={<Link to="/workflows/new" />}>
              <RiAddLine data-icon="inline-start" /> New Workflow
            </Button>
            <input
              ref={importInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={onImportFile}
            />
          </div>
        </div>
        {importFailure ? (
          <Alert variant="error">
            <RiErrorWarningLine />
            <AlertTitle>Could not import this file</AlertTitle>
            <AlertDescription>{importFailure}</AlertDescription>
          </Alert>
        ) : null}
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
    </div>
  );
}
