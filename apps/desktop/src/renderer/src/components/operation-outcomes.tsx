import {
  type MachineReadiness,
  uncovered,
  type WorkflowAction,
  type WorkflowCatalogEntry,
  type WorkflowDiagnostic,
  type WorkflowDocument,
  type WorkflowEdit,
  type WorkflowOperation,
  type WorkflowQuestion,
  type WorkflowQuestionChoice,
  type WorkflowRecord,
} from "@cogwork/contracts";
import { Alert, AlertDescription } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightLine,
  RiCloseLine,
  RiErrorWarningLine,
} from "@remixicon/react";
import { createContext, Fragment, type ReactNode, use, useState } from "react";
import { freshNodeId, yesOrNoQuestion } from "../features/workflow-defaults";
import { type Answers, answersKey, outcomeEdits, transitionAt } from "../features/workflow-edits";
import { BufferedInput, BufferedTextarea } from "./buffered-field";
import {
  appIconOf,
  appOf,
  type CatalogChoice,
  CatalogMenu,
  type HandOffTarget,
  type ListValues,
  ParameterMenu,
} from "./workflow-catalog-menu";
import { ProblemMark, problemsAt, problemTargetId } from "./workflow-problems";

export interface OperationOutcomesValue {
  readonly state: { readonly operation: WorkflowOperation };
  readonly actions: {
    readonly send: (edits: ReadonlyArray<WorkflowEdit>) => Promise<WorkflowRecord | null>;
  };
  readonly meta: {
    readonly entries: ReadonlyArray<WorkflowCatalogEntry>;
    readonly machine: MachineReadiness | null;
    readonly handOffs: ReadonlyArray<HandOffTarget>;
    readonly listValues: ListValues;
    readonly takenIds: ReadonlyArray<string>;
    readonly problems: ReadonlyArray<WorkflowDiagnostic>;
    readonly workflowDocument: WorkflowDocument;
  };
}

interface OperationOutcomesContextValue extends OperationOutcomesValue {
  readonly state: OperationOutcomesValue["state"] & { readonly justPicked: string | null };
  readonly actions: OperationOutcomesValue["actions"] & {
    readonly pick: (when: Answers, choice: CatalogChoice) => void;
  };
}

const OperationOutcomesContext = createContext<OperationOutcomesContextValue | null>(null);

const useOperationOutcomes = () => {
  const value = use(OperationOutcomesContext);
  if (!value) throw new Error("OperationOutcomes parts need an OperationOutcomes.Provider");
  return value;
};

const pickKey = (when: Answers, entry: WorkflowCatalogEntry["key"]) => `${answersKey(when)}|${entry}`;

const updatedOperation = (record: WorkflowRecord | null, operation: WorkflowOperation) =>
  record?.workingCopy.operations.find(({ id }) => id === operation.id);

const updatedQuestion = (
  record: WorkflowRecord | null,
  operation: WorkflowOperation,
  question: WorkflowQuestion,
) => updatedOperation(record, operation)?.questions.find(({ id }) => id === question.id);

function Provider({
  value,
  children,
}: {
  readonly value: OperationOutcomesValue;
  readonly children: ReactNode;
}) {
  const [justPicked, setJustPicked] = useState<string | null>(null);
  const { operation } = value.state;
  const pick = (when: Answers, choice: CatalogChoice) => {
    if (choice._tag === "HandOff") {
      value.actions.send(outcomeEdits.handOff(operation, when, choice.operation));
      return;
    }
    value.actions.send(
      outcomeEdits.addAction(
        operation,
        when,
        { entry: choice.entry.key, parameters: choice.parameters },
        value.meta.entries,
      ),
    );
    setJustPicked(choice.entry.agentInputs.length > 0 ? pickKey(when, choice.entry.key) : null);
  };
  return (
    <OperationOutcomesContext
      value={{ ...value, state: { ...value.state, justPicked }, actions: { ...value.actions, pick } }}
    >
      {children}
    </OperationOutcomesContext>
  );
}

interface OutcomeContextValue {
  readonly state: {
    readonly when: Answers;
    readonly actions: ReadonlyArray<WorkflowAction>;
    readonly handOff: WorkflowOperation["id"] | null;
  };
  readonly actions: { readonly pick: (choice: CatalogChoice) => void };
}

const OutcomeContext = createContext<OutcomeContextValue | null>(null);

const useOutcome = () => {
  const value = use(OutcomeContext);
  if (!value) throw new Error("Outcome parts need an Outcome");
  return value;
};

function Outcome({ when, children }: { readonly when: Answers; readonly children: ReactNode }) {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  const transition = transitionAt(operation, when);
  return (
    <OutcomeContext
      value={{
        state: { when, actions: transition?.actions ?? [], handOff: transition?.handOff ?? null },
        actions: { pick: (choice) => actions.pick(when, choice) },
      }}
    >
      <div className="group/row flex flex-col gap-0.5 px-3 py-2">{children}</div>
    </OutcomeContext>
  );
}

const outcomeIsEmpty = (state: OutcomeContextValue["state"]) =>
  state.actions.length === 0 && state.handOff === null;

function AddActionMenu({ children }: { readonly children: ReactNode }) {
  const {
    meta: { entries, machine, handOffs, listValues },
  } = useOperationOutcomes();
  const { actions } = useOutcome();
  if (!machine) return null;
  return (
    <CatalogMenu.Provider
      entries={entries}
      machine={machine}
      handOffs={handOffs}
      listValues={listValues}
      onChoose={actions.pick}
    >
      {children}
      <CatalogMenu.Content />
    </CatalogMenu.Provider>
  );
}

function AddActionTrigger({ className }: { readonly className: string }) {
  return (
    <AddActionMenu>
      <CatalogMenu.Trigger
        render={
          <Button size="xs" variant="ghost" className={cn("font-normal text-muted-foreground", className)} />
        }
      >
        <RiAddLine data-icon="inline-start" />
        Add Action
      </CatalogMenu.Trigger>
    </AddActionMenu>
  );
}

function OutcomeHeading({ children }: { readonly children: ReactNode }) {
  const { state } = useOutcome();
  return (
    <div className="flex h-7 items-center gap-2">
      {children}
      {outcomeIsEmpty(state) ? null : (
        <AddActionTrigger className="ms-auto opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" />
      )}
    </div>
  );
}

function RemoveOnHover({
  label,
  className,
  onRemove,
}: {
  readonly label: string;
  readonly className: string;
  readonly onRemove: () => void;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      className={cn("opacity-0 focus-visible:opacity-100", className)}
      onClick={onRemove}
    >
      <RiCloseLine />
    </Button>
  );
}

// Module-level so the ref callback keeps one identity: an inline one would refocus on every keystroke.
const focusOnAttach = (node: HTMLTextAreaElement | null) => {
  node?.focus();
};

const fieldLabel = (field: string) => {
  const words = field.replaceAll("_", " ");
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
};

function Instructions({ entry }: { readonly entry: WorkflowCatalogEntry }) {
  const {
    state: { operation, justPicked },
    actions,
  } = useOperationOutcomes();
  const { state } = useOutcome();
  const several = entry.agentInputs.length > 1;
  const focusFirst = justPicked === pickKey(state.when, entry.key);
  return (
    <div
      className={cn(
        "grid min-w-0 items-start gap-x-1.5",
        several && "grid-cols-[auto_minmax(0,1fr)]",
        !several && "grid-cols-[minmax(0,1fr)]",
      )}
    >
      {entry.agentInputs.map((field, index) => (
        <Fragment key={field}>
          {several ? (
            <span className="flex h-[26px] items-center text-xs text-muted-foreground">
              {fieldLabel(field)}
            </span>
          ) : null}
          <BufferedTextarea
            ref={focusFirst && index === 0 ? focusOnAttach : undefined}
            rows={1}
            label={`What the agent writes for the ${fieldLabel(field).toLowerCase()}`}
            value={operation.hints.find((hint) => hint.field === field)?.text ?? ""}
            placeholder="What to write"
            className="w-auto max-w-full min-w-24 rounded-sm py-[5px] text-xs leading-4"
            save={async (text) => {
              const record = await actions.send([
                { _tag: "SetHint", operation: operation.id, field, text: text.trim() || null },
              ]);
              return (
                updatedOperation(record, operation)?.hints.find((hint) => hint.field === field)?.text ?? ""
              );
            }}
          />
        </Fragment>
      ))}
    </div>
  );
}

function ActionLine({ action, index }: { readonly action: WorkflowAction; readonly index: number }) {
  const {
    state: { operation },
    actions,
    meta: { entries, listValues },
  } = useOperationOutcomes();
  const { state } = useOutcome();
  const entry = entries.find(({ key }) => key === action.entry);
  const Icon = appIconOf(entry ? appOf(entry) : "cogwork");
  const name = entry?.name ?? action.entry;
  return (
    <div className="group/action grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-1.5 hover:bg-muted/40">
      <span className="flex min-h-[26px] min-w-0 flex-wrap items-center gap-1.5 text-xs">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
        {entry?.parameters.map((parameter) => (
          <ParameterMenu
            key={parameter.id}
            entry={entry}
            parameter={parameter}
            value={action.parameters.find(({ id }) => id === parameter.id)?.value ?? ""}
            listValues={listValues}
            onChange={(value) =>
              actions.send(
                outcomeEdits.setActionParameter(operation, state.when, index, parameter.id, value, entries),
              )
            }
          />
        ))}
      </span>
      {entry ? <Instructions entry={entry} /> : <span />}
      <RemoveOnHover
        label={`Remove ${name}`}
        className="mt-0.5 group-hover/action:opacity-100"
        onRemove={() => actions.send(outcomeEdits.removeAction(operation, state.when, index, entries))}
      />
    </div>
  );
}

function HandOffLine({ target }: { readonly target: WorkflowOperation["id"] }) {
  const {
    state: { operation },
    actions,
    meta: { workflowDocument },
  } = useOperationOutcomes();
  const { state } = useOutcome();
  const name = workflowDocument.operations.find(({ id }) => id === target)?.name ?? target;
  return (
    <div className="group/action flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-muted/40">
      <RiArrowRightLine className="size-3.5 text-muted-foreground" />
      <span className="font-medium">{name}</span>
      <RemoveOnHover
        label={`Stop handing off to ${name}`}
        className="ms-auto group-hover/action:opacity-100"
        onRemove={() => actions.send(outcomeEdits.handOff(operation, state.when, null))}
      />
    </div>
  );
}

function OutcomeActions() {
  const { state } = useOutcome();
  return (
    <div className="ms-2.5 flex flex-col gap-0.5 border-s ps-2">
      {state.actions.map((action, index) => (
        <ActionLine
          key={`${action.entry}:${JSON.stringify(action.parameters)}`}
          action={action}
          index={index}
        />
      ))}
      {state.handOff ? <HandOffLine target={state.handOff} /> : null}
      {outcomeIsEmpty(state) ? <AddActionTrigger className="w-fit" /> : null}
    </div>
  );
}

const namesQuestions = (operation: WorkflowOperation) => operation.questions.length > 1;

function ConditionBadges({ when }: { readonly when: Answers }) {
  const {
    state: { operation },
  } = useOperationOutcomes();
  const parts = operation.questions.flatMap((question) => {
    const answer = when.find((candidate) => candidate.question === question.id);
    if (!answer) return [];
    const choice = question.choices.find(({ id }) => id === answer.choice);
    return [{ questionId: question.id, choice: choice?.name ?? answer.choice }];
  });
  if (parts.length === 0) {
    return (
      <Badge variant="outline" className="font-normal">
        Every time
      </Badge>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {parts.map((part) => (
        <Badge key={part.questionId} variant="secondary" className="font-mono text-[11px] font-normal">
          {namesQuestions(operation) ? (
            <span className="text-muted-foreground">{part.questionId}</span>
          ) : null}
          {part.choice}
        </Badge>
      ))}
    </span>
  );
}

function OutcomeName({
  question,
  choice,
}: {
  readonly question: WorkflowQuestion;
  readonly choice: WorkflowQuestionChoice;
}) {
  const {
    state: { operation },
    actions,
    meta: { problems, workflowDocument },
  } = useOperationOutcomes();
  return (
    <span className="flex w-56 max-w-full min-w-0 items-center gap-0.5">
      <BufferedInput
        value={choice.name}
        label={`Outcome ${question.choices.indexOf(choice) + 1}`}
        className="h-7 flex-1 px-1.5 font-mono text-[13px]"
        save={async (name) => {
          if (!name.trim()) return choice.name;
          const record = await actions.send([
            { _tag: "RenameChoice", operation: operation.id, question: question.id, choice: choice.id, name },
          ]);
          return (
            updatedQuestion(record, operation, question)?.choices.find(({ id }) => id === choice.id)?.name ??
            name
          );
        }}
      />
      <ProblemMark
        problems={problemsAt(problems, { operation: operation.id, question: question.id, choice: choice.id })}
        workflowDocument={workflowDocument}
      />
      {question.choices.length > 1 ? (
        <RemoveOnHover
          label={`Remove ${choice.name}`}
          className="group-hover/row:opacity-100"
          onRemove={() =>
            actions.send([
              { _tag: "RemoveChoice", operation: operation.id, question: question.id, choice: choice.id },
            ])
          }
        />
      ) : null}
    </span>
  );
}

function QuestionLine({ question }: { readonly question: WorkflowQuestion }) {
  const {
    state: { operation },
    actions,
    meta: { problems, workflowDocument },
  } = useOperationOutcomes();
  const label = `Question ${operation.questions.indexOf(question) + 1}`;
  return (
    <div className="group/question flex items-center gap-2 px-3 pt-3 pb-1">
      <BufferedInput
        value={question.text}
        placeholder="Question"
        label={label}
        className="h-7 flex-1 text-sm font-medium"
        save={async (text) => {
          if (!text.trim()) return question.text;
          const record = await actions.send([
            { _tag: "SetQuestionText", operation: operation.id, question: question.id, text },
          ]);
          return updatedQuestion(record, operation, question)?.text ?? text;
        }}
      />
      <ProblemMark
        problems={problemsAt(problems, { operation: operation.id, question: question.id, choice: null })}
        workflowDocument={workflowDocument}
      />
      {namesQuestions(operation) ? (
        <RemoveOnHover
          label={`Remove ${label.toLowerCase()}`}
          className="group-hover/question:opacity-100"
          onRemove={() =>
            actions.send([{ _tag: "RemoveQuestion", operation: operation.id, question: question.id }])
          }
        />
      ) : null}
    </div>
  );
}

function QuestionBlock({ question }: { readonly question: WorkflowQuestion }) {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  return (
    <div
      id={problemTargetId({ operation: operation.id, question: question.id })}
      className="flex flex-col border-b pb-2 last:border-b-0"
    >
      <QuestionLine question={question} />
      <div className="flex flex-col divide-y divide-border/60">
        {question.choices.map((choice) => (
          <Outcome key={choice.id} when={[{ question: question.id, choice: choice.id }]}>
            <OutcomeHeading>
              <OutcomeName question={question} choice={choice} />
            </OutcomeHeading>
            <OutcomeActions />
          </Outcome>
        ))}
      </div>
      <Button
        size="xs"
        variant="ghost"
        className="ms-3 w-fit font-normal text-muted-foreground"
        onClick={() => {
          const id = freshNodeId(
            "outcome",
            question.choices.map((choice) => choice.id),
          );
          actions.send([
            { _tag: "AddChoice", operation: operation.id, question: question.id, choice: { id, name: id } },
          ]);
        }}
      >
        <RiAddLine data-icon="inline-start" />
        Add outcome
      </Button>
    </div>
  );
}

function EveryTime() {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  return (
    <div className="border-b bg-muted/30 last:border-b-0">
      <Outcome when={[]}>
        <OutcomeHeading>
          <span className="ps-1.5 text-sm text-muted-foreground">Every time</span>
          <RemoveOnHover
            label="Stop running anything every time"
            className="group-hover/row:opacity-100"
            onRemove={() => actions.send([{ _tag: "RemoveTransition", operation: operation.id, when: [] }])}
          />
        </OutcomeHeading>
        <OutcomeActions />
      </Outcome>
    </div>
  );
}

function Combinations() {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  const combined = operation.transitions.filter(({ when }) => when.length > 1);
  if (combined.length === 0) return null;
  return (
    <div className="flex flex-col divide-y divide-border/60 border-b last:border-b-0">
      {combined.map((transition) => (
        <Outcome key={answersKey(transition.when)} when={transition.when}>
          <OutcomeHeading>
            <span className="ps-1.5">
              <ConditionBadges when={transition.when} />
            </span>
            <RemoveOnHover
              label="Remove this combination"
              className="group-hover/row:opacity-100"
              onRemove={() =>
                actions.send([{ _tag: "RemoveTransition", operation: operation.id, when: transition.when }])
              }
            />
          </OutcomeHeading>
          <OutcomeActions />
        </Outcome>
      ))}
    </div>
  );
}

function CombinationLevel({ prefix, after }: { readonly prefix: Answers; readonly after: number }) {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  const last = operation.questions.length - 1;
  const atTop = prefix.length === 0;
  const canJoin = (index: number) => index > after && !(atTop && index === last);
  const addRoute = (when: Answers) => {
    if (transitionAt(operation, when)) return;
    actions.send([{ _tag: "AddTransition", operation: operation.id, when }]);
  };
  const candidates = operation.questions
    .map((question, index) => ({ question, index }))
    .filter(({ index }) => canJoin(index));
  return candidates.map(({ question, index }, at) => (
    <DropdownMenuGroup key={question.id}>
      {at > 0 ? <DropdownMenuSeparator /> : null}
      <DropdownMenuLabel className="font-mono">{question.id}</DropdownMenuLabel>
      {question.choices.map((choice) => {
        const when = [...prefix, { question: question.id, choice: choice.id }];
        if (index === last) {
          return (
            <DropdownMenuItem
              key={choice.id}
              label={choice.name}
              className="font-mono text-xs"
              onClick={() => addRoute(when)}
            >
              {choice.name}
            </DropdownMenuItem>
          );
        }
        return (
          <DropdownMenuSub key={choice.id}>
            <DropdownMenuSubTrigger label={choice.name} className="font-mono text-xs">
              {choice.name}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-48">
              {atTop ? null : (
                <>
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => addRoute(when)}>This combination</DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                </>
              )}
              <CombinationLevel prefix={when} after={index} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
    </DropdownMenuGroup>
  ));
}

function CombinationMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="xs" variant="ghost" className="font-normal text-muted-foreground">
            <RiAddLine data-icon="inline-start" />
            Add combination
          </Button>
        }
      />
      <DropdownMenuContent className="w-56">
        <CombinationLevel prefix={[]} after={-1} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UncoveredNotice() {
  const {
    state: { operation },
  } = useOperationOutcomes();
  const gaps = uncovered(operation);
  if (gaps.length === 0) return null;
  return (
    <Alert>
      <RiErrorWarningLine />
      <AlertDescription className="flex flex-wrap items-center gap-1.5">
        Unhandled:
        {gaps.map((when) => (
          <ConditionBadges key={answersKey(when)} when={when} />
        ))}
      </AlertDescription>
    </Alert>
  );
}

function Footer() {
  const {
    state: { operation },
    actions,
    meta: { takenIds },
  } = useOperationOutcomes();
  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {transitionAt(operation, []) ? null : (
          <Button
            size="xs"
            variant="ghost"
            className="font-normal text-muted-foreground"
            onClick={() => actions.send([{ _tag: "AddTransition", operation: operation.id, when: [] }])}
          >
            <RiAddLine data-icon="inline-start" />
            Every time
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          className="font-normal text-muted-foreground"
          onClick={() =>
            actions.send([
              {
                _tag: "AddQuestion",
                operation: operation.id,
                question: yesOrNoQuestion(freshNodeId("question", takenIds)),
              },
            ])
          }
        >
          <RiAddLine data-icon="inline-start" />
          Add question
        </Button>
        {namesQuestions(operation) ? <CombinationMenu /> : null}
      </div>
      <UncoveredNotice />
    </>
  );
}

const cardinalityChoices = [
  { value: "once", label: "Once" },
  { value: "each", label: "For each…" },
] as const;

function Cardinality() {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  const forEach = operation.forEach;
  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="xs" variant="ghost" className="font-normal text-muted-foreground" />}
        >
          {forEach === null ? "Once" : "For each"}
          <RiArrowDownSLine data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-40">
          <DropdownMenuGroup>
            <DropdownMenuRadioGroup
              value={forEach === null ? "once" : "each"}
              onValueChange={(value) => {
                if (value === "once" && forEach !== null) {
                  actions.send([{ _tag: "SetForEach", operation: operation.id, forEach: null }]);
                }
                if (value === "each" && forEach === null) {
                  actions.send([{ _tag: "SetForEach", operation: operation.id, forEach: "finding" }]);
                }
              }}
            >
              {cardinalityChoices.map((choice) => (
                <DropdownMenuRadioItem key={choice.value} value={choice.value} closeOnClick>
                  {choice.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {forEach === null ? null : (
        <BufferedInput
          value={forEach}
          label="What the Operation finds"
          className="h-7 w-40 px-1.5 font-mono text-[13px]"
          save={async (noun) => {
            if (!noun.trim()) return forEach;
            const record = await actions.send([
              { _tag: "SetForEach", operation: operation.id, forEach: noun },
            ]);
            return updatedOperation(record, operation)?.forEach ?? noun;
          }}
        />
      )}
    </div>
  );
}

function List() {
  const {
    state: { operation },
  } = useOperationOutcomes();
  return (
    <div className="flex flex-col gap-2">
      <Cardinality />
      <div className="flex flex-col overflow-hidden rounded-lg border bg-background">
        {transitionAt(operation, []) ? <EveryTime /> : null}
        {operation.questions.map((question) => (
          <QuestionBlock key={question.id} question={question} />
        ))}
        <Combinations />
      </div>
      <Footer />
    </div>
  );
}

export const OperationOutcomes = { Provider, List };
