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
import { bindEdits } from "../features/workflow-draft";
import {
  actionsAt,
  agentInstructions,
  type Choice,
  type Condition,
  canRemoveChoice,
  combinedRoutes,
  conditionKey,
  conditionParts,
  namesQuestions,
  type Operation,
  operationEdits,
  type Question,
  routeAt,
  uncovered,
} from "../features/workflow-model";
import { CatalogMenu, catalogIconFor } from "./workflow-catalog-menu";

type Update = (change: (operation: Operation) => Operation) => void;

const operationActions = (update: Update) => {
  const bind = bindEdits(update);
  return {
    addAction: bind(operationEdits.addAction),
    removeAction: bind(operationEdits.removeAction),
    addRoute: bind(operationEdits.addRoute),
    removeRoute: bind(operationEdits.removeRoute),
    setHint: bind(operationEdits.setHint),
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
  readonly actions: ReturnType<typeof operationActions> & {
    readonly pickAction: (when: Condition, action: CatalogChoice) => void;
  };
  readonly meta: { readonly catalog: Catalog };
}

const OperationOutcomesContext = createContext<OperationOutcomesContextValue | null>(null);

const useOperationOutcomes = () => {
  const value = use(OperationOutcomesContext);
  if (!value) throw new Error("OperationOutcomes parts need an OperationOutcomes.Provider");
  return value;
};

const pickKey = (operation: Operation, when: Condition, action: CatalogChoice) =>
  `${conditionKey(operation, when)}|${choiceKey(action)}`;

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
  const actions = operationActions(update);
  const pickAction = (when: Condition, action: CatalogChoice) => {
    actions.addAction(when, action);
    setJustPicked(pickKey(operation, when, action));
  };
  return (
    <OperationOutcomesContext
      value={{ state: { operation, justPicked }, actions: { ...actions, pickAction }, meta: { catalog } }}
    >
      {children}
    </OperationOutcomesContext>
  );
}

interface OutcomeContextValue {
  readonly state: { readonly when: Condition; readonly actions: readonly CatalogChoice[] };
  readonly actions: {
    readonly pick: (action: CatalogChoice) => void;
    readonly remove: (action: CatalogChoice) => void;
  };
  readonly meta: { readonly justPicked: (action: CatalogChoice) => boolean };
}

const OutcomeContext = createContext<OutcomeContextValue | null>(null);

const useOutcome = () => {
  const value = use(OutcomeContext);
  if (!value) throw new Error("Outcome parts need an Outcome");
  return value;
};

function Outcome({ when, children }: { readonly when: Condition; readonly children: ReactNode }) {
  const {
    state: { operation, justPicked },
    actions,
  } = useOperationOutcomes();
  return (
    <OutcomeContext
      value={{
        state: { when, actions: actionsAt(operation, when) },
        actions: {
          pick: (action) => actions.pickAction(when, action),
          remove: (action) => actions.removeAction(when, action),
        },
        meta: { justPicked: (action) => justPicked === pickKey(operation, when, action) },
      }}
    >
      <div className="group/row flex flex-col gap-0.5 px-3 py-2">{children}</div>
    </OutcomeContext>
  );
}

function AddActionMenu({ children }: { readonly children: ReactNode }) {
  const {
    meta: { catalog },
  } = useOperationOutcomes();
  const { actions } = useOutcome();
  return (
    <CatalogMenu.Root catalog={catalog} onChoose={actions.pick}>
      {children}
      <CatalogMenu.Content placeholder="Search" />
    </CatalogMenu.Root>
  );
}

function OutcomeHeading({ children }: { readonly children: ReactNode }) {
  const { state } = useOutcome();
  return (
    <div className="flex h-7 items-center gap-2">
      {children}
      {state.actions.length > 0 ? (
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

function ActionLabel({ action }: { readonly action: CatalogChoice }) {
  const Icon = catalogIconFor(action.icon);
  return (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{action.itemName}</span>
      {action.optionName ? (
        <span className="font-mono text-[11px] text-muted-foreground">{action.optionName}</span>
      ) : null}
    </>
  );
}

// Module-level so the ref callback keeps one identity: an inline one would refocus on every keystroke.
const focusOnAttach = (node: HTMLTextAreaElement | null) => {
  node?.focus();
};

function Instructions({ action }: { readonly action: CatalogChoice }) {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  const { meta } = useOutcome();
  const instructions = agentInstructions(operation, action);
  const several = instructions.length > 1;
  return (
    <div
      className={cn(
        "grid min-w-0 items-start gap-x-1.5",
        several && "grid-cols-[auto_minmax(0,1fr)]",
        !several && "grid-cols-[minmax(0,1fr)]",
      )}
    >
      {instructions.map(({ input, hint }, index) => (
        <Fragment key={input.id}>
          {several ? (
            <span className="flex h-[26px] items-center text-xs text-muted-foreground">{input.label}</span>
          ) : null}
          <Textarea
            variant="ghost"
            ref={meta.justPicked(action) && index === 0 ? focusOnAttach : undefined}
            rows={1}
            aria-label={`What the agent writes for the ${input.label.toLowerCase()}`}
            value={hint}
            placeholder="What to write"
            className="w-auto max-w-full min-w-24 rounded-sm py-[5px] text-xs leading-4"
            onChange={(event) => actions.setHint(action, input.id, event.target.value)}
          />
        </Fragment>
      ))}
    </div>
  );
}

function ActionLine({ action }: { readonly action: CatalogChoice }) {
  const { actions } = useOutcome();
  return (
    <div className="group/action grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-1.5 hover:bg-muted/40">
      <span className="flex h-[26px] min-w-0 items-center gap-1.5 text-xs whitespace-nowrap">
        <ActionLabel action={action} />
      </span>
      <Instructions action={action} />
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Remove ${action.itemName}`}
        className="mt-0.5 opacity-0 group-hover/action:opacity-100 focus-visible:opacity-100"
        onClick={() => actions.remove(action)}
      >
        <RiCloseLine />
      </Button>
    </div>
  );
}

function HandOffLine({ action }: { readonly action: CatalogChoice }) {
  const { actions } = useOutcome();
  return (
    <div className="group/action flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-muted/40">
      <RiArrowRightLine className="size-3.5 text-muted-foreground" />
      <span className="font-medium">{action.itemName}</span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Stop handing off to ${action.itemName}`}
        className="ms-auto opacity-0 group-hover/action:opacity-100 focus-visible:opacity-100"
        onClick={() => actions.remove(action)}
      >
        <RiCloseLine />
      </Button>
    </div>
  );
}

function OutcomeActions() {
  const { state } = useOutcome();
  return (
    <div className="ms-2.5 flex flex-col gap-0.5 border-s ps-2">
      {state.actions
        .filter((action) => !isHandOff(action))
        .map((action) => (
          <ActionLine key={choiceKey(action)} action={action} />
        ))}
      {state.actions.filter(isHandOff).map((action) => (
        <HandOffLine key={choiceKey(action)} action={action} />
      ))}
      {state.actions.length === 0 ? (
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
          {namesQuestions(operation) ? (
            <span className="text-muted-foreground">{part.questionId}</span>
          ) : null}
          {part.choice}
        </Badge>
      ))}
    </span>
  );
}

function OutcomeName({ question, choice }: { readonly question: Question; readonly choice: Choice }) {
  const { actions } = useOperationOutcomes();
  return (
    <span className="flex w-56 max-w-full min-w-0 items-center gap-0.5">
      <Input
        variant="ghost"
        value={choice.name}
        aria-label={`Outcome ${question.choices.indexOf(choice) + 1}`}
        className="h-7 flex-1 px-1.5 font-mono text-[13px]"
        onChange={(event) => actions.renameChoice(question.id, choice.id, event.target.value)}
      />
      {canRemoveChoice(question) ? (
        <RemoveOnHover
          label={`Remove ${choice.name}`}
          onRemove={() => actions.removeChoice(question.id, choice.id)}
        />
      ) : null}
    </span>
  );
}

function QuestionLine({ question }: { readonly question: Question }) {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  const label = `Question ${operation.questions.indexOf(question) + 1}`;
  return (
    <div className="group/question flex items-center gap-2 px-3 pt-3 pb-1">
      <Input
        variant="ghost"
        value={question.text}
        placeholder="Question"
        aria-label={label}
        className="h-7 flex-1 text-sm font-medium"
        onChange={(event) => actions.setQuestionText(question.id, event.target.value)}
      />
      {namesQuestions(operation) ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove ${label.toLowerCase()}`}
          className="opacity-0 group-hover/question:opacity-100 focus-visible:opacity-100"
          onClick={() => actions.removeQuestion(question.id)}
        >
          <RiCloseLine />
        </Button>
      ) : null}
    </div>
  );
}

function QuestionBlock({ question }: { readonly question: Question }) {
  const { actions } = useOperationOutcomes();
  return (
    <div className="flex flex-col border-b pb-2 last:border-b-0">
      <QuestionLine question={question} />
      <div className="flex flex-col divide-y divide-border/60">
        {question.choices.map((choice) => (
          <Outcome key={choice.id} when={{ [question.id]: choice.id }}>
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
          <OutcomeActions />
        </Outcome>
      ))}
    </div>
  );
}

function CombinationLevel({ prefix, after }: { readonly prefix: Condition; readonly after: number }) {
  const {
    state: { operation },
    actions,
  } = useOperationOutcomes();
  const last = operation.questions.length - 1;
  const atTop = Object.keys(prefix).length === 0;
  const canJoin = (index: number) => index > after && !(atTop && index === last);
  const candidates = operation.questions
    .map((question, index) => ({ question, index }))
    .filter(({ index }) => canJoin(index));
  return candidates.map(({ question, index }, at) => (
    <DropdownMenuGroup key={question.id}>
      {at > 0 ? <DropdownMenuSeparator /> : null}
      <DropdownMenuLabel className="font-mono">{question.id}</DropdownMenuLabel>
      {question.choices.map((choice) => {
        const when = { ...prefix, [question.id]: choice.id };
        if (index === last) {
          return (
            <DropdownMenuItem
              key={choice.id}
              label={choice.name}
              className="font-mono text-xs"
              onClick={() => actions.addRoute(when)}
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
                    <DropdownMenuItem onClick={() => actions.addRoute(when)}>
                      This combination
                    </DropdownMenuItem>
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
        <CombinationLevel prefix={{}} after={-1} />
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
          onClick={() => actions.addQuestion()}
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

function List() {
  const {
    state: { operation },
  } = useOperationOutcomes();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col overflow-hidden rounded-lg border bg-background">
        {routeAt(operation, {}) ? <EveryTime /> : null}
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
