import { Alert, AlertDescription } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { Input } from "@cogwork/ui/components/input";
import { Textarea } from "@cogwork/ui/components/textarea";
import { cn } from "@cogwork/ui/lib/utils";
import { RiAddLine, RiArrowRightLine, RiCloseLine, RiErrorWarningLine } from "@remixicon/react";
import { createContext, Fragment, type ReactNode, use, useState } from "react";
import { type Catalog, type CatalogChoice, choiceKey, isHandOff } from "../features/workflow-catalog";
import {
  agentInputs,
  type Choice,
  type Condition,
  combinedRoutes,
  conditionKey,
  conditionParts,
  type Operation,
  operationEdits,
  type Question,
  routeAt,
  stepsAt,
  uncovered,
} from "../features/workflow-model";
import { CatalogMenu, catalogIconFor } from "./workflow-catalog-menu";

type Update = (change: (operation: Operation) => Operation) => void;

const bindEdits = (update: Update) => {
  const bind =
    <Args extends readonly unknown[]>(edit: (operation: Operation, ...args: Args) => Operation) =>
    (...args: Args) =>
      update((operation) => edit(operation, ...args));
  return {
    removeStep: bind(operationEdits.removeStep),
    addRoute: bind(operationEdits.addRoute),
    removeRoute: bind(operationEdits.removeRoute),
    setInstruction: (step: CatalogChoice, inputId: string, field: string, hint: string) =>
      update((operation) =>
        operationEdits.setInput(operation, step, inputId, { kind: "agent", field, hint }),
      ),
    setQuestionText: bind(operationEdits.setQuestionText),
    renameChoice: bind(operationEdits.renameChoice),
    addChoice: bind(operationEdits.addChoice),
    removeChoice: bind(operationEdits.removeChoice),
    addQuestion: bind(operationEdits.addQuestion),
    removeQuestion: bind(operationEdits.removeQuestion),
  };
};

interface OperationOutcomesContextValue {
  readonly state: {
    readonly operation: Operation;
    readonly justPicked: string | null;
  };
  readonly actions: ReturnType<typeof bindEdits> & {
    readonly pickStep: (when: Condition, step: CatalogChoice) => void;
  };
  readonly meta: { readonly catalog: Catalog };
}

const OperationOutcomesContext = createContext<OperationOutcomesContextValue | null>(null);

const useOperationOutcomes = () => {
  const value = use(OperationOutcomesContext);
  if (!value) throw new Error("OperationOutcomes parts need an OperationOutcomes.Provider");
  return value;
};

const pickKey = (operation: Operation, when: Condition, step: CatalogChoice) =>
  `${conditionKey(operation, when)}|${choiceKey(step)}`;

function Provider({
  operation,
  update,
  catalog,
  children,
}: {
  readonly operation: Operation;
  readonly update: Update;
  readonly catalog: Catalog;
  readonly children: ReactNode;
}) {
  const [justPicked, setJustPicked] = useState<string | null>(null);
  const pickStep = (when: Condition, step: CatalogChoice) => {
    update((current) => operationEdits.addStep(current, when, step));
    setJustPicked(pickKey(operation, when, step));
  };
  return (
    <OperationOutcomesContext
      value={{
        state: { operation, justPicked },
        actions: { ...bindEdits(update), pickStep },
        meta: { catalog },
      }}
    >
      {children}
    </OperationOutcomesContext>
  );
}

const OutcomeContext = createContext<{ readonly when: Condition } | null>(null);

const useOutcome = () => {
  const value = use(OutcomeContext);
  if (!value) throw new Error("Outcome parts need an Outcome");
  return value;
};

function Outcome({ when, children }: { readonly when: Condition; readonly children: ReactNode }) {
  return (
    <OutcomeContext value={{ when }}>
      <div className="group/row flex flex-col gap-0.5 px-3 py-2">{children}</div>
    </OutcomeContext>
  );
}

function AddActionMenu({ children }: { readonly children: ReactNode }) {
  const {
    actions,
    meta: { catalog },
  } = useOperationOutcomes();
  const { when } = useOutcome();
  return (
    <CatalogMenu.Root catalog={catalog} onChoose={(step) => actions.pickStep(when, step)}>
      {children}
      <CatalogMenu.Content placeholder="Search" />
    </CatalogMenu.Root>
  );
}

function OutcomeHeading({ children }: { readonly children: ReactNode }) {
  const {
    state: { operation },
  } = useOperationOutcomes();
  const { when } = useOutcome();
  return (
    <div className="flex h-7 items-center gap-2">
      {children}
      {stepsAt(operation, when).length > 0 ? (
        <AddActionMenu>
          <CatalogMenu.Trigger
            render={
              <Button
                size="xs"
                variant="ghost"
                className="ms-auto font-normal text-muted-foreground opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
              />
            }
          >
            <RiAddLine data-icon="inline-start" />
            Add Action
          </CatalogMenu.Trigger>
        </AddActionMenu>
      ) : null}
    </div>
  );
}

function RemoveOnHover({ label, onRemove }: { readonly label: string; readonly onRemove: () => void }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
      onClick={onRemove}
    >
      <RiCloseLine />
    </Button>
  );
}

function StepLabel({ step }: { readonly step: CatalogChoice }) {
  const Icon = catalogIconFor(step.icon);
  return (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{step.itemName}</span>
      {step.optionName ? (
        <span className="font-mono text-[11px] text-muted-foreground">{step.optionName}</span>
      ) : null}
    </>
  );
}

/** Module-level so its identity never changes: React calls it once on attach, not on every keystroke. */
const focusOnAttach = (node: HTMLTextAreaElement | null) => {
  node?.focus();
};

function Instructions({ step }: { readonly step: CatalogChoice }) {
  const {
    state: { operation, justPicked },
    actions,
  } = useOperationOutcomes();
  const { when } = useOutcome();
  const instructed = agentInputs(operation, step);
  const fresh = justPicked === pickKey(operation, when, step);
  const several = instructed.length > 1;
  return (
    <div
      className={cn(
        "grid min-w-0 items-start gap-x-1.5",
        several && "grid-cols-[auto_minmax(0,1fr)]",
        !several && "grid-cols-[minmax(0,1fr)]",
      )}
    >
      {instructed.map(({ entry, source }, index) => (
        <Fragment key={entry.id}>
          {several ? (
            <span className="flex h-[26px] items-center text-xs text-muted-foreground">{entry.label}</span>
          ) : null}
          <Textarea
            ref={fresh && index === 0 ? focusOnAttach : undefined}
            rows={1}
            aria-label={`What the agent writes for the ${entry.label.toLowerCase()}`}
            value={source.hint}
            placeholder="What to write"
            className="min-h-0 w-auto max-w-full min-w-24 resize-none rounded-sm border-0 bg-transparent px-1 py-[5px] text-xs leading-4 shadow-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-0 md:text-xs dark:bg-transparent"
            onChange={(event) => actions.setInstruction(step, entry.id, source.field, event.target.value)}
          />
        </Fragment>
      ))}
    </div>
  );
}

function ActionLine({ step }: { readonly step: CatalogChoice }) {
  const { actions } = useOperationOutcomes();
  const { when } = useOutcome();
  return (
    <div className="group/action grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-1.5 hover:bg-muted/40">
      <span className="flex h-[26px] min-w-0 items-center gap-1.5 text-xs whitespace-nowrap">
        <StepLabel step={step} />
      </span>
      <Instructions step={step} />
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Remove ${step.itemName}`}
        className="mt-0.5 opacity-0 group-hover/action:opacity-100 focus-visible:opacity-100"
        onClick={() => actions.removeStep(when, step)}
      >
        <RiCloseLine />
      </Button>
    </div>
  );
}

function HandOffLine({ step }: { readonly step: CatalogChoice }) {
  const { actions } = useOperationOutcomes();
  const { when } = useOutcome();
  return (
    <div className="group/action flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-muted/40">
      <RiArrowRightLine className="size-3.5 text-muted-foreground" />
      <span className="font-medium">{step.itemName}</span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Stop handing off to ${step.itemName}`}
        className="ms-auto opacity-0 group-hover/action:opacity-100 focus-visible:opacity-100"
        onClick={() => actions.removeStep(when, step)}
      >
        <RiCloseLine />
      </Button>
    </div>
  );
}

function OutcomeSteps() {
  const {
    state: { operation },
  } = useOperationOutcomes();
  const { when } = useOutcome();
  const steps = stepsAt(operation, when);
  return (
    <div className="ms-2.5 flex flex-col gap-0.5 border-s ps-2">
      {steps
        .filter((step) => !isHandOff(step))
        .map((step) => (
          <ActionLine key={choiceKey(step)} step={step} />
        ))}
      {steps.filter(isHandOff).map((step) => (
        <HandOffLine key={choiceKey(step)} step={step} />
      ))}
      {steps.length === 0 ? (
        <AddActionMenu>
          <CatalogMenu.Trigger
            render={<Button size="xs" variant="ghost" className="w-fit font-normal text-muted-foreground" />}
          >
            <RiAddLine data-icon="inline-start" />
            Add Action
          </CatalogMenu.Trigger>
        </AddActionMenu>
      ) : null}
    </div>
  );
}

function ConditionBadges({ when }: { readonly when: Condition }) {
  const {
    state: { operation },
  } = useOperationOutcomes();
  const parts = conditionParts(operation, when);
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
          {operation.questions.length > 1 ? <span className="text-muted-foreground">{part.key}</span> : null}
          {part.choice}
        </Badge>
      ))}
    </span>
  );
}

function OutcomeName({
  question,
  choice,
  index,
}: {
  readonly question: Question;
  readonly choice: Choice;
  readonly index: number;
}) {
  const { actions } = useOperationOutcomes();
  return (
    <span className="flex w-56 max-w-full min-w-0 items-center gap-0.5">
      <Input
        value={choice.name}
        aria-label={`Outcome ${index + 1}`}
        className="h-7 min-w-0 flex-1 border-0 bg-transparent px-1.5 font-mono text-[13px] shadow-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-0 dark:bg-transparent"
        onChange={(event) => actions.renameChoice(question.id, choice.id, event.target.value)}
      />
      <RemoveOnHover
        label={`Remove ${choice.name}`}
        onRemove={() => actions.removeChoice(question.id, choice.id)}
      />
    </span>
  );
}

function QuestionLine({ question, index }: { readonly question: Question; readonly index: number }) {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  const alone = operation.questions.length === 1;
  return (
    <div className="group/question flex items-center gap-2 px-3 pt-3 pb-1">
      <Input
        value={question.text}
        placeholder="Question"
        aria-label={alone ? "Question" : `Question ${index + 1}`}
        className="h-7 flex-1 border-0 bg-transparent px-1 text-sm font-medium shadow-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-0 dark:bg-transparent"
        onChange={(event) => actions.setQuestionText(question.id, event.target.value)}
      />
      {alone ? null : (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove question ${index + 1}`}
          className="opacity-0 group-hover/question:opacity-100 focus-visible:opacity-100"
          onClick={() => actions.removeQuestion(question.id)}
        >
          <RiCloseLine />
        </Button>
      )}
    </div>
  );
}

function QuestionBlock({ question, index }: { readonly question: Question; readonly index: number }) {
  const { actions } = useOperationOutcomes();
  return (
    <div className="flex flex-col border-b pb-2 last:border-b-0">
      <QuestionLine question={question} index={index} />
      <div className="flex flex-col divide-y divide-border/60">
        {question.choices.map((choice, at) => (
          <Outcome key={choice.id} when={{ [question.id]: choice.id }}>
            <OutcomeHeading>
              <OutcomeName question={question} choice={choice} index={at} />
            </OutcomeHeading>
            <OutcomeSteps />
          </Outcome>
        ))}
      </div>
      <Button
        size="xs"
        variant="ghost"
        className="ms-3 w-fit font-normal text-muted-foreground"
        onClick={() => actions.addChoice(question.id)}
      >
        <RiAddLine data-icon="inline-start" />
        Add outcome
      </Button>
    </div>
  );
}

function EveryTime() {
  const { actions } = useOperationOutcomes();
  return (
    <div className="border-b bg-muted/30 last:border-b-0">
      <Outcome when={{}}>
        <OutcomeHeading>
          <span className="ps-1.5 text-sm text-muted-foreground">Every time</span>
          <RemoveOnHover label="Stop running anything every time" onRemove={() => actions.removeRoute({})} />
        </OutcomeHeading>
        <OutcomeSteps />
      </Outcome>
    </div>
  );
}

function Combinations() {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  const combined = combinedRoutes(operation);
  if (combined.length === 0) return null;
  return (
    <div className="flex flex-col divide-y divide-border/60 border-b last:border-b-0">
      {combined.map((route) => (
        <Outcome key={conditionKey(operation, route.when)} when={route.when}>
          <OutcomeHeading>
            <span className="ps-1.5">
              <ConditionBadges when={route.when} />
            </span>
            <RemoveOnHover label="Remove this combination" onRemove={() => actions.removeRoute(route.when)} />
          </OutcomeHeading>
          <OutcomeSteps />
        </Outcome>
      ))}
    </div>
  );
}

function CombinationMenu() {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
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
        <DropdownMenuGroup>
          {operation.questions.slice(0, -1).map((question, index) => (
            <DropdownMenuSub key={question.id}>
              <DropdownMenuSubTrigger label={question.key}>
                <span className="font-mono text-xs">{question.key}</span>
                <span className="text-muted-foreground">is…</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-44">
                {question.choices.map((choice) => (
                  <DropdownMenuSub key={choice.id}>
                    <DropdownMenuSubTrigger label={choice.name} className="font-mono text-xs">
                      {choice.name}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-48">
                      {operation.questions.slice(index + 1).map((later, at) => (
                        <DropdownMenuGroup key={later.id}>
                          {at > 0 ? <DropdownMenuSeparator /> : null}
                          <DropdownMenuLabel className="font-mono">and {later.key} is</DropdownMenuLabel>
                          {later.choices.map((laterChoice) => (
                            <DropdownMenuItem
                              key={laterChoice.id}
                              label={laterChoice.name}
                              className="font-mono text-xs"
                              onClick={() =>
                                actions.addRoute({ [question.id]: choice.id, [later.id]: laterChoice.id })
                              }
                            >
                              {laterChoice.name}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        </DropdownMenuGroup>
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
          <ConditionBadges key={conditionKey(operation, when)} when={when} />
        ))}
      </AlertDescription>
    </Alert>
  );
}

function Footer() {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {routeAt(operation, {}) ? null : (
          <Button
            size="xs"
            variant="ghost"
            className="font-normal text-muted-foreground"
            onClick={() => actions.addRoute({})}
          >
            <RiAddLine data-icon="inline-start" />
            Every time
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          className="font-normal text-muted-foreground"
          onClick={actions.addQuestion}
        >
          <RiAddLine data-icon="inline-start" />
          Add question
        </Button>
        {operation.questions.length > 1 ? <CombinationMenu /> : null}
      </div>
      <UncoveredNotice />
    </>
  );
}

function List() {
  const {
    state: { operation },
  } = useOperationOutcomes();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col overflow-hidden rounded-lg border bg-background">
        {routeAt(operation, {}) ? <EveryTime /> : null}
        {operation.questions.map((question, index) => (
          <QuestionBlock key={question.id} question={question} index={index} />
        ))}
        <Combinations />
      </div>
      <Footer />
    </div>
  );
}

export const OperationOutcomes = { Provider, List };
