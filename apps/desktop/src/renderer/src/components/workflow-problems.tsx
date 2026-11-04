import type {
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

const problemText = (problem: WorkflowDiagnostic, workflowDocument: WorkflowDocument) => {
  if (problem.code === "hand-off-and-trigger") {
    return `${operationName(workflowDocument, problem.message.split(" ").at(-1) ?? "")} will run two times`;
  }
  return workflowDocument.operations.reduce(
    (text, operation) => text.replaceAll(`Operation ${operation.id}`, operation.name),
    problem.message,
  );
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

function BlockingProblemIcon() {
  return <RiErrorWarningLine data-icon="inline-start" className="text-destructive" />;
}

function AdvisoryProblemIcon() {
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
        {blocking ? <BlockingProblemIcon /> : <AdvisoryProblemIcon />}
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
}: {
  readonly problems: ReadonlyArray<WorkflowDiagnostic>;
  readonly workflowDocument: WorkflowDocument;
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
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="font-normal"
            aria-label={problems.length === 1 ? "1 problem" : `${problems.length} problems`}
          />
        }
      >
        {blocking ? <BlockingProblemIcon /> : <AdvisoryProblemIcon />}
        {problems.length}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 gap-0.5 p-1">
        {problems.map((problem, index) => (
          <Button
            key={problemKey(problem, index)}
            variant="ghost"
            className="h-auto items-start justify-start gap-2 px-2 py-1.5 text-start font-normal whitespace-normal"
            onClick={() => show(problem)}
          >
            {blocksPublish(problem) ? <BlockingProblemIcon /> : <AdvisoryProblemIcon />}
            {problemText(problem, workflowDocument)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
