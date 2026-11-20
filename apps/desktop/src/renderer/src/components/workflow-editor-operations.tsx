import {
  type NeedIdentity,
  selectedHarnessCatalogModel,
  type WorkflowModelSelection,
  type WorkflowOperation,
  type WorkflowRecord,
} from "@cogwork/contracts";
import { Button } from "@cogwork/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuEmpty,
  DropdownMenuFilter,
  DropdownMenuGroup,
  DropdownMenuInput,
  DropdownMenuList,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Separator } from "@cogwork/ui/components/separator";
import { RiAddLine, RiCloseLine, RiPlugLine, RiRobot2Line, RiToolsLine } from "@remixicon/react";
import { type ComponentType, createContext, type ReactNode, use, useState } from "react";
import { kindIcons } from "../features/configuration-icons";
import { kindLabelsPlural } from "../features/configuration-model";
import {
  availableHarnessCatalogs,
  catalogFor,
  harnessIsDisabled,
  modelOptionStates,
  providerPickerCatalogs,
  selectableHarnessCatalogs,
} from "../features/operation-settings";
import { documentNodeIds, newWorkflowOperation } from "../features/workflow-defaults";
import { importReviewMark } from "../features/workflow-import-review";
import { type NeedChoice, type NeedKind, useWorkflowSession } from "../features/workflow-session";
import { useWorkingCopy } from "../features/working-copy-provider";
import { BufferedInput, BufferedTextarea } from "./buffered-field";
import { ImportReview, useDismissImportReview } from "./import-review";
import { OperationOutcomes, operationIn } from "./operation-outcomes";
import { ProviderPicker } from "./provider-picker";
import { TraitsMenu } from "./traits-menu";
import { ProblemMark, problemsAt, problemsOf, problemTargetId } from "./workflow-problems";

const operationPath = (
  id: WorkflowOperation["id"],
  operations: ReadonlyArray<WorkflowOperation>,
  seen: Set<WorkflowOperation["id"]>,
): ReadonlyArray<WorkflowOperation> => {
  if (seen.has(id)) return [];
  const operation = operations.find((candidate) => candidate.id === id);
  if (!operation) return [];
  seen.add(id);
  return [
    operation,
    ...operation.transitions.flatMap(({ handOff }) =>
      handOff ? operationPath(handOff, operations, seen) : [],
    ),
  ];
};

export const orderedOperations = (workflow: WorkflowRecord) => {
  const seen = new Set<WorkflowOperation["id"]>();
  const reached = workflow.workingCopy.triggers.flatMap(({ start }) =>
    operationPath(start, workflow.workingCopy.operations, seen),
  );
  return [...reached, ...workflow.workingCopy.operations.filter(({ id }) => !seen.has(id))];
};

const modelSelections = (model: WorkflowModelSelection) =>
  model.options.length === 0 ? null : Object.fromEntries(model.options.map(({ id, value }) => [id, value]));

function OperationModelPicker({ operation }: { readonly operation: WorkflowOperation }) {
  const { actions } = useWorkingCopy();
  const {
    state: { harnesses },
  } = useWorkflowSession();
  const dismissImportReview = useDismissImportReview();
  const catalogs = availableHarnessCatalogs(harnesses.catalogs);
  const providers = providerPickerCatalogs(catalogs, harnesses.readiness);
  const catalog = catalogFor(catalogs, operation.model.harness);
  const model = catalog ? selectedHarnessCatalogModel(catalog.models, operation.model.model) : undefined;
  const own = modelSelections(operation.model);
  const options = model ? modelOptionStates(model, { own, inherited: null, effective: own ?? {} }) : [];
  const setModel = (selection: WorkflowModelSelection) => {
    dismissImportReview(importReviewMark.model(operation.id));
    actions.edit([{ _tag: "SetModel", operation: operation.id, model: selection }]);
  };
  return (
    <>
      <ProviderPicker.Provider
        value={{
          state: {
            allProviders: providers,
            selectableProviders: selectableHarnessCatalogs(harnesses.controlStore, providers),
            selectedHarness: operation.model.harness,
            model: operation.model.model,
            options,
            own: operation.model.model !== null,
            stale: false,
            disabledHarness: harnessIsDisabled(harnesses.controlStore, operation.model.harness),
          },
          actions: { pick: (harness, picked) => setModel({ harness, model: picked, options: [] }) },
          meta: { disabled: false },
        }}
      >
        <ProviderPicker.Root>
          <ImportReview mark={importReviewMark.model(operation.id)}>
            <ProviderPicker.Trigger />
          </ImportReview>
          <ProviderPicker.Content>
            <ProviderPicker.Rail />
            <Separator orientation="vertical" />
            <ProviderPicker.Models />
          </ProviderPicker.Content>
        </ProviderPicker.Root>
      </ProviderPicker.Provider>
      {catalog && model ? (
        <TraitsMenu
          state={{ catalog, model, options }}
          actions={{
            select: (selections) =>
              setModel({
                ...operation.model,
                options: Object.entries(selections).map(([id, value]) => ({ id, value })),
              }),
          }}
          meta={{ disabled: false }}
        />
      ) : null}
    </>
  );
}

const needGroups: ReadonlyArray<{
  readonly kind: NeedKind;
  readonly label: string;
  readonly Icon: ComponentType<{ className?: string }>;
}> = [
  ...(["mcp-server", "skill", "subagent", "hook"] as const).map((kind) => ({
    kind,
    label: kindLabelsPlural[kind],
    Icon: kindIcons[kind],
  })),
  { kind: "connection", label: "Connections", Icon: RiPlugLine },
];

interface OperationToolsValue {
  readonly state: { readonly operation: WorkflowOperation; readonly query: string };
  readonly actions: { readonly toggle: (need: NeedChoice, checked: boolean) => void };
}

const OperationToolsContext = createContext<OperationToolsValue | null>(null);

const useOperationTools = () => {
  const value = use(OperationToolsContext);
  if (!value) throw new Error("Tools menu parts need OperationTools");
  return value;
};

function ToolItem({ need, children }: { readonly need: NeedChoice; readonly children?: ReactNode }) {
  const {
    state: { needs },
  } = useWorkflowSession();
  const {
    state: { operation },
    actions: { toggle },
  } = useOperationTools();
  const ambiguous = needs.some(
    (other) => other.identity !== need.identity && other.kind === need.kind && other.name === need.name,
  );
  return (
    <DropdownMenuCheckboxItem
      label={need.name}
      checked={operation.requires.includes(need.identity)}
      onCheckedChange={(checked) => toggle(need, checked)}
    >
      {children}
      <span className="truncate">{need.name}</span>
      {ambiguous ? (
        <span className="ms-auto truncate text-xs text-muted-foreground">{need.source}</span>
      ) : null}
    </DropdownMenuCheckboxItem>
  );
}

function ToolsCascade() {
  const {
    state: { needs },
  } = useWorkflowSession();
  return (
    <DropdownMenuGroup>
      {needGroups.map(({ kind, label, Icon }) => {
        const inGroup = needs.filter((need) => need.kind === kind);
        if (inGroup.length === 0) return null;
        return (
          <DropdownMenuSub key={kind}>
            <DropdownMenuSubTrigger label={label}>
              <Icon className="text-muted-foreground" />
              <span className="flex-1 truncate">{label}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 min-w-56">
              <DropdownMenuGroup>
                {inGroup.map((need) => (
                  <ToolItem key={need.identity} need={need} />
                ))}
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
    </DropdownMenuGroup>
  );
}

function ToolsSearch() {
  const {
    state: { needs },
  } = useWorkflowSession();
  const {
    state: { query },
  } = useOperationTools();
  const needle = query.trim().toLowerCase();
  return (
    <DropdownMenuGroup>
      {needGroups.flatMap(({ kind, Icon }) =>
        needs
          .filter((need) => need.kind === kind && need.name.toLowerCase().includes(needle))
          .map((need) => (
            <ToolItem key={need.identity} need={need}>
              <Icon className="text-muted-foreground" />
            </ToolItem>
          )),
      )}
    </DropdownMenuGroup>
  );
}

function OperationTools({ operation }: { readonly operation: WorkflowOperation }) {
  const { actions } = useWorkingCopy();
  const {
    state: { needs },
  } = useWorkflowSession();
  const dismissImportReview = useDismissImportReview();
  const [query, setQuery] = useState("");
  const nameOf = (identity: NeedIdentity) =>
    needs.find((need) => need.identity === identity)?.name ?? identity;
  const setRequires = (requires: ReadonlyArray<NeedIdentity>) => {
    dismissImportReview(importReviewMark.requires(operation.id));
    actions.edit([{ _tag: "SetRequires", operation: operation.id, requires }]);
  };
  const toggle = (need: NeedChoice, checked: boolean) =>
    setRequires(
      checked
        ? [...operation.requires, need.identity]
        : operation.requires.filter((identity) => identity !== need.identity),
    );
  return (
    <OperationToolsContext value={{ state: { operation, query }, actions: { toggle } }}>
      <ImportReview mark={importReviewMark.requires(operation.id)}>
        <DropdownMenuFilter filter={null} value={query} onValueChange={setQuery} autoHighlight>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="sm" variant="ghost" className="font-normal text-muted-foreground" />}
            >
              <RiToolsLine data-icon="inline-start" />
              Tools
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64">
              <DropdownMenuInput placeholder="Search" aria-label="Search tools" />
              <DropdownMenuEmpty>No tools</DropdownMenuEmpty>
              <DropdownMenuList>
                {query.trim().length > 0 ? <ToolsSearch /> : <ToolsCascade />}
              </DropdownMenuList>
            </DropdownMenuContent>
          </DropdownMenu>
        </DropdownMenuFilter>
        {operation.requires.map((identity) => (
          <Button
            key={identity}
            size="xs"
            variant="secondary"
            className="font-normal"
            aria-label={`Stop requiring ${nameOf(identity)}`}
            onClick={() => setRequires(operation.requires.filter((required) => required !== identity))}
          >
            {nameOf(identity)}
            <RiCloseLine data-icon="inline-end" />
          </Button>
        ))}
      </ImportReview>
    </OperationToolsContext>
  );
}

function OperationCard({ operation }: { readonly operation: WorkflowOperation }) {
  const {
    state: { workflow },
    actions,
  } = useWorkingCopy();
  const {
    state: { catalog, machine },
  } = useWorkflowSession();
  const name = actions.field(
    (current) => operationIn(current, operation)?.name ?? "",
    (text) => [{ _tag: "RenameOperation", operation: operation.id, name: text }],
  );
  const instruction = actions.field(
    (current) => operationIn(current, operation)?.instruction ?? "",
    (text) => [{ _tag: "SetInstruction", operation: operation.id, instruction: text }],
  );
  const problems = problemsOf(workflow);
  const operationProblems = problemsAt(problems, { operation: operation.id, question: null }).filter(
    ({ code }) => code !== "uncovered-outcome",
  );
  return (
    <div
      id={problemTargetId({ operation: operation.id })}
      className="flex flex-col gap-2 rounded-xl bg-muted/50 p-2.5"
    >
      <div className="flex items-center gap-2 px-1">
        <RiRobot2Line className="size-4 shrink-0 text-muted-foreground" />
        <BufferedInput
          value={name.value}
          label="Operation name"
          className="h-7 flex-1 text-sm font-medium"
          save={name.save}
        />
        <ProblemMark problems={operationProblems} workflowDocument={workflow.workingCopy} />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${operation.name}`}
          onClick={() => actions.edit([{ _tag: "RemoveOperation", operation: operation.id }])}
        >
          <RiCloseLine />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg bg-background p-1.5">
        <ScrollArea className="max-h-64">
          <BufferedTextarea
            rows={3}
            value={instruction.value}
            label={`Instructions for ${operation.name}`}
            placeholder="Instructions"
            className="min-h-16 py-2 pe-3 text-sm"
            save={instruction.save}
          />
        </ScrollArea>
        <div className="flex flex-wrap items-center gap-1">
          <OperationModelPicker operation={operation} />
          <OperationTools operation={operation} />
        </div>
      </div>

      <div className="px-1">
        <OperationOutcomes.Provider
          value={{
            state: { operation },
            meta: {
              entries: catalog?.entries.filter(({ kind }) => kind === "action") ?? [],
              machine,
              handOffs: workflow.workingCopy.operations
                .filter(({ id }) => id !== operation.id)
                .map(({ id, name }) => ({ id, name })),
              takenIds: documentNodeIds(workflow.workingCopy),
              problems,
              workflowDocument: workflow.workingCopy,
            },
          }}
        >
          <OperationOutcomes.List />
        </OperationOutcomes.Provider>
      </div>
    </div>
  );
}

export function Operations() {
  const {
    state: { workflow },
    actions,
  } = useWorkingCopy();
  return (
    <section aria-label="Operations" className="flex flex-col gap-1.5">
      {orderedOperations(workflow).map((operation) => (
        <OperationCard key={operation.id} operation={operation} />
      ))}
      <Button
        variant="ghost"
        className="w-full justify-start rounded-xl bg-muted/50 py-3 font-normal text-muted-foreground hover:bg-muted"
        onClick={() =>
          actions.edit([
            { _tag: "AddOperation", operation: newWorkflowOperation(documentNodeIds(workflow.workingCopy)) },
          ])
        }
      >
        <RiAddLine data-icon="inline-start" />
        Add Operation
      </Button>
    </section>
  );
}
