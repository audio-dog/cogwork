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
  inheritedAt,
  isComplete,
  type Operation,
  type OperationDraftActions,
  type Question,
  routeAt,
  stepsAt,
  uncovered,
  useOperationDraft,
} from "../features/workflow-model";
import { catalogIconFor, PickFromCatalog } from "./workflow-catalog-menu";

/**
 * An Operation's outcomes and what Cogwork does with each one.
 *
 * Each outcome is a heading; what Cogwork does is a list under it — the Action's name in one column
 * and, when the agent writes part of it, the instruction the agent reads in the next. A hand-off to
 * another Operation closes the list, because it is where the work goes next. The provider owns the
 * Operation's working copy, and every part reads it from context.
 */

interface OperationOutcomesContextValue {
  readonly state: {
    readonly operation: Operation;
    /** The step picked last, keyed by row and step, so its instruction can take the cursor. */
    readonly justPicked: string | null;
  };
  readonly actions: OperationDraftActions & {
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
  seed,
  catalog,
  children,
}: {
  readonly seed: Operation;
  readonly catalog: Catalog;
  readonly children: ReactNode;
}) {
  const { operation, actions } = useOperationDraft(seed);
  const [justPicked, setJustPicked] = useState<string | null>(null);
  const pickStep = (when: Condition, step: CatalogChoice) => {
    actions.addStep(when, step);
    setJustPicked(pickKey(operation, when, step));
  };
  return (
    <OperationOutcomesContext
      value={{ state: { operation, justPicked }, actions: { ...actions, pickStep }, meta: { catalog } }}
    >
      {children}
    </OperationOutcomesContext>
  );
}

/* ---------- atoms ---------- */

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

/** Module-level so its identity never changes: React calls it once on attach, not on every keystroke. */
const focusOnAttach = (node: HTMLTextAreaElement | null) => {
  node?.focus();
};

/** The instructions the agent reads for one step. Each one hugs its text and wraps at the row's edge. */
function InstructionFields({ when, step }: { readonly when: Condition; readonly step: CatalogChoice }) {
  const {
    state: { operation, justPicked },
    actions,
  } = useOperationOutcomes();
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
            placeholder={`What should the agent write for the ${entry.label.toLowerCase()}?`}
            className="min-h-0 w-auto max-w-full min-w-24 resize-none rounded-sm border-0 bg-transparent px-1 py-[5px] text-xs leading-4 shadow-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-0 md:text-xs dark:bg-transparent"
            onChange={(event) => actions.setInput(step, entry.id, { ...source, hint: event.target.value })}
          />
        </Fragment>
      ))}
    </div>
  );
}

/* ---------- one outcome ---------- */

function ActionLine({ when, step }: { readonly when: Condition; readonly step: CatalogChoice }) {
  const { actions } = useOperationOutcomes();
  return (
    <div className="group/action grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-1.5 hover:bg-muted/40">
      <span className="flex h-[26px] min-w-0 items-center gap-1.5 text-xs whitespace-nowrap">
        <StepLabel step={step} />
      </span>
      <InstructionFields when={when} step={step} />
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

function HandOffLine({ when, step }: { readonly when: Condition; readonly step: CatalogChoice }) {
  const { actions } = useOperationOutcomes();
  return (
    <div className="group/action flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-muted/40">
      <RiArrowRightLine className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">then run</span>
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

/**
 * One outcome: its heading, then what Cogwork does. "Add an Action" sits on the heading line, so
 * showing it on hover never moves the list; an outcome with no steps shows it in the list instead.
 */
function OutcomeBlock({ heading, when }: { readonly heading: ReactNode; readonly when: Condition }) {
  const {
    state: { operation },
    actions,
    meta: { catalog },
  } = useOperationOutcomes();
  const steps = stepsAt(operation, when);
  const doing = steps.filter((step) => !isHandOff(step));
  const next = steps.filter(isHandOff);
  const empty = steps.length === 0;
  const nothing = empty && isComplete(operation, when) && inheritedAt(operation, when).length === 0;
  const pick = (step: CatalogChoice) => actions.pickStep(when, step);
  return (
    <div className="group/row flex flex-col gap-0.5 px-3 py-2">
      <div className="flex h-7 items-center gap-2">
        {heading}
        {empty ? null : (
          <PickFromCatalog
            catalog={catalog}
            label="Add an Action"
            placeholder="Search Actions…"
            onChoose={pick}
            className="ms-auto opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
          />
        )}
      </div>
      <div className="ms-2.5 flex flex-col gap-0.5 border-s ps-2">
        {doing.map((step) => (
          <ActionLine key={choiceKey(step)} when={when} step={step} />
        ))}
        {next.map((step) => (
          <HandOffLine key={choiceKey(step)} when={when} step={step} />
        ))}
        {nothing ? (
          <span className="px-1.5 py-1 text-xs text-muted-foreground italic">Does nothing</span>
        ) : null}
        {empty ? (
          <PickFromCatalog
            catalog={catalog}
            label="Add an Action"
            placeholder="Search Actions…"
            onChoose={pick}
            className="w-fit"
          />
        ) : null}
      </div>
    </div>
  );
}

/** An outcome name that reads as text and edits in place; its remove button shows on hover. */
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
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Remove ${choice.name}`}
        className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
        onClick={() => actions.removeChoice(question.id, choice.id)}
      >
        <RiCloseLine />
      </Button>
    </span>
  );
}

/* ---------- the list ---------- */

/** The question in prose, as an editable heading rather than a boxed field. */
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
        placeholder="What should the agent decide?"
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
          <OutcomeBlock
            key={choice.id}
            when={{ [question.id]: choice.id }}
            heading={<OutcomeName question={question} choice={choice} index={at} />}
          />
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

function RemovableHeading({
  label,
  children,
  onRemove,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly onRemove: () => void;
}) {
  return (
    <span className="flex h-7 items-center gap-1 ps-1.5">
      {children}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={label}
        className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
        onClick={onRemove}
      >
        <RiCloseLine />
      </Button>
    </span>
  );
}

function EveryTimeBlock() {
  const { actions } = useOperationOutcomes();
  return (
    <div className="border-b bg-muted/30 last:border-b-0">
      <OutcomeBlock
        when={{}}
        heading={
          <RemovableHeading label="Stop running anything every time" onRemove={() => actions.removeRoute({})}>
            <span className="text-sm text-muted-foreground">Every time</span>
          </RemovableHeading>
        }
      />
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
        <OutcomeBlock
          key={conditionKey(operation, route.when)}
          when={route.when}
          heading={
            <RemovableHeading
              label="Remove this combination"
              onRemove={() => actions.removeRoute(route.when)}
            >
              <ConditionBadges when={route.when} />
            </RemovableHeading>
          }
        />
      ))}
    </div>
  );
}

/** Picks a combination of two answers: a question's choice, then a later question's choice. */
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

/** Names the answers no route reaches, so a gap in the routing is visible before it runs. */
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
        Nothing happens when the agent answers
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
            Run something every time
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
        {routeAt(operation, {}) ? <EveryTimeBlock /> : null}
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
