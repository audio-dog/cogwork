import type {
  WorkflowCatalog,
  WorkflowDiagnostic,
  WorkflowDiagnosticLocation,
  WorkflowDocument,
  WorkflowRecord,
} from "@cogwork/contracts";
import { Button } from "@cogwork/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@cogwork/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiErrorWarningLine, RiInformationLine } from "@remixicon/react";
import { useState } from "react";

export const problemsOf = (workflow: WorkflowRecord) => [...workflow.diagnostics, ...workflow.readiness];

export const blocksPublish = (problem: WorkflowDiagnostic) => problem.class !== "advisory";

type ProblemPlace = Partial<Omit<WorkflowDiagnosticLocation, "field">> & { readonly field?: string };

export const problemsAt = (problems: ReadonlyArray<WorkflowDiagnostic>, place: ProblemPlace) =>
  problems.filter((problem) =>
    (["trigger", "operation", "question", "choice", "field"] as const).every(
      (part) => place[part] === undefined || place[part] === problem.location[part],
    ),
  );

const domTargets = [
  {
    matches: (location: WorkflowDiagnosticLocation) => location.question !== null,
    id: (location: WorkflowDiagnosticLocation) =>
      `workflow-question-${location.operation}-${location.question}`,
  },
  {
    matches: (location: WorkflowDiagnosticLocation) => location.operation !== null,
    id: (location: WorkflowDiagnosticLocation) => `workflow-operation-${location.operation}`,
  },
  {
    matches: (location: WorkflowDiagnosticLocation) => location.trigger !== null,
    id: (location: WorkflowDiagnosticLocation) => `workflow-trigger-${location.trigger}`,
  },
];

export const problemTargetId = (location: Partial<WorkflowDiagnosticLocation>) => {
  const full = { trigger: null, operation: null, question: null, choice: null, field: "", ...location };
  return domTargets.find(({ matches }) => matches(full))?.id(full) ?? "workflow-header";
};

const operationName = (workflowDocument: WorkflowDocument, id: string) =>
  workflowDocument.operations.find((operation) => operation.id === id)?.name ?? id;

const capitalized = (text: string) => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

const problemText = (problem: WorkflowDiagnostic, workflowDocument: WorkflowDocument) => {
  if (problem.code === "hand-off-and-trigger") {
    return `${operationName(workflowDocument, problem.message.split(" ").at(-1) ?? "")} will run two times`;
  }
  const subject = workflowDocument.operations.find(({ id }) =>
    problem.message.startsWith(`Operation ${id} `),
  );
  const message = subject
    ? capitalized(problem.message.slice(`Operation ${subject.id} `.length))
    : problem.message;
  return workflowDocument.operations.reduce(
    (text, operation) => text.replaceAll(`Operation ${operation.id}`, operation.name),
    message,
  );
};

const problemPlace = (
  problem: WorkflowDiagnostic,
  workflowDocument: WorkflowDocument,
  catalog: WorkflowCatalog | null,
) => {
  const { operation, trigger } = problem.location;
  if (operation !== null) return operationName(workflowDocument, operation);
  const entry = workflowDocument.triggers.find(({ id }) => id === trigger)?.entry;
  if (entry === undefined) return "Workflow";
  return catalog?.entries.find(({ key }) => key === entry)?.name ?? entry;
};

const problemKey = (problem: WorkflowDiagnostic, index: number) =>
  [
    problem.code,
    problem.class,
    problem.location.trigger,
    problem.location.operation,
    problem.location.question,
    problem.location.choice,
    problem.location.field,
    index,
  ].join(":");

function ProblemIcon({ blocking }: { readonly blocking: boolean }) {
  if (blocking) return <RiErrorWarningLine data-icon="inline-start" className="text-destructive" />;
  return <RiInformationLine data-icon="inline-start" className="text-muted-foreground" />;
}

export function ProblemMark({
  problems,
  workflowDocument,
}: {
  readonly problems: ReadonlyArray<WorkflowDiagnostic>;
  readonly workflowDocument: WorkflowDocument;
}) {
  if (problems.length === 0) return null;
  const blocking = problems.some(blocksPublish);
  const label = problems.map((problem) => problemText(problem, workflowDocument)).join(". ");
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="icon-xs" variant="ghost" aria-label={label} />}>
        <ProblemIcon blocking={blocking} />
      </TooltipTrigger>
      <TooltipContent side="top" className="flex flex-col items-start gap-0.5">
        {problems.map((problem, index) => (
          <span key={problemKey(problem, index)}>{problemText(problem, workflowDocument)}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

export function ProblemsButton({
  problems,
  workflowDocument,
  catalog,
}: {
  readonly problems: ReadonlyArray<WorkflowDiagnostic>;
  readonly workflowDocument: WorkflowDocument;
  readonly catalog: WorkflowCatalog | null;
}) {
  const [open, setOpen] = useState(false);
  if (problems.length === 0) return null;
  const blocking = problems.some(blocksPublish);
  const show = (problem: WorkflowDiagnostic) => {
    setOpen(false);
    document
      .getElementById(problemTargetId(problem.location))
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="sm" variant="ghost" className="font-normal" />}>
        <ProblemIcon blocking={blocking} />
        {problems.length === 1 ? "1 problem" : `${problems.length} problems`}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 gap-0.5 p-1">
        {problems.map((problem, index) => (
          <Button
            key={problemKey(problem, index)}
            variant="ghost"
            className="h-auto items-start justify-start gap-2 px-2 py-1.5 text-start font-normal whitespace-normal"
            onClick={() => show(problem)}
          >
            <ProblemIcon blocking={blocksPublish(problem)} />
            <span className="flex min-w-0 flex-col">
              <span className="text-xs text-muted-foreground">
                {problemPlace(problem, workflowDocument, catalog)}
              </span>
              <span className="text-sm">{problemText(problem, workflowDocument)}</span>
            </span>
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
