import {
  adviseReadiness,
  applyWorkflowEdits,
  type MachineReadiness,
  type NeedIdentity,
  selectedHarnessCatalogModel,
  validateWorkflow,
  type WorkflowCatalog,
  type WorkflowEdit,
  type WorkflowModelSelection,
  type WorkflowOperation,
  type WorkflowRecord,
  type WorkflowTrigger,
  WorkflowWorkspaceSelection,
  type WorkspaceId,
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
  DropdownMenuItem,
  DropdownMenuList,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cogwork/ui/components/select";
import { Separator } from "@cogwork/ui/components/separator";
import { Switch } from "@cogwork/ui/components/switch";
import {
  RiAddLine,
  RiArrowLeftLine,
  RiArrowRightLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiMore2Line,
  RiPlugLine,
  RiRobot2Line,
  RiToolsLine,
} from "@remixicon/react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { type ComponentType, createContext, type ReactNode, use, useRef, useState } from "react";
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
import { documentNodeIds, freshNodeId, newWorkflowOperation } from "../features/workflow-defaults";
import {
  type NeedChoice,
  type NeedKind,
  useWorkflowSession,
  type WorkflowClient,
  type WorkflowHarnesses,
} from "../features/workflow-session";
import { BufferedInput, BufferedTextarea } from "./buffered-field";
import { OperationOutcomes } from "./operation-outcomes";
import { ProviderPicker } from "./provider-picker";
import { TraitsMenu } from "./traits-menu";
import { appIconOf, appOf, CatalogMenu, type ListValues, ParameterMenu } from "./workflow-catalog-menu";
import {
  blocksPublish,
  ProblemMark,
  ProblemsButton,
  problemsAt,
  problemsOf,
  problemTargetId,
} from "./workflow-problems";

type Send = (edits: ReadonlyArray<WorkflowEdit>) => Promise<WorkflowRecord | null>;

interface WorkflowEditorValue {
  readonly state: { readonly workflow: WorkflowRecord };
  readonly actions: WorkflowClient & { readonly send: Send };
  readonly meta: {
    readonly catalog: WorkflowCatalog | null;
    readonly machine: MachineReadiness | null;
    readonly workspaceLabels: ReadonlyMap<string, string>;
    readonly harnesses: WorkflowHarnesses;
    readonly needs: ReadonlyArray<NeedChoice>;
    readonly listValues: ListValues;
    readonly saveFailed: boolean;
  };
}

const WorkflowEditorContext = createContext<WorkflowEditorValue | null>(null);

const useWorkflowEditor = () => {
  const value = use(WorkflowEditorContext);
  if (!value) throw new Error("WorkflowEditor parts need a WorkflowEditor");
  return value;
};

const decodeWorkspaceSelection = Schema.decodeUnknownSync(WorkflowWorkspaceSelection);

const workspaceIds = (workflow: WorkflowRecord, machine: MachineReadiness | null) =>
  workflow.workingCopy.workspaces._tag === "Listed"
    ? workflow.workingCopy.workspaces.workspaces
    : (machine?.workspaces.map(({ id }) => id) ?? []);

function WorkspaceSelect() {
  const {
    state: { workflow },
    actions,
    meta: { machine, workspaceLabels },
  } = useWorkflowEditor();
  const labelOf = (workspace: WorkspaceId) => workspaceLabels.get(workspace) ?? workspace;
  const current = workflow.workingCopy.workspaces;
  const currentWorkspace = current._tag === "Listed" ? current.workspaces[0] : undefined;
  const value = current._tag === "Every" ? "every" : (currentWorkspace ?? "none");
  const machineItems = machine?.workspaces.map(({ id }) => ({ value: id, label: labelOf(id) })) ?? [];
  const currentWorkspaceIsMissing =
    currentWorkspace !== undefined && !machineItems.some(({ value: id }) => id === currentWorkspace);
  const items = [
    { value: "none", label: "No workspace" },
    ...(currentWorkspaceIsMissing ? [{ value: currentWorkspace, label: labelOf(currentWorkspace) }] : []),
    ...machineItems,
    { value: "every", label: "Every workspace" },
  ];
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (!next) return;
        const selected =
          next === currentWorkspace
            ? currentWorkspace
            : machine?.workspaces.find(({ id }) => id === next)?.id;
        const workspaces = decodeWorkspaceSelection(
          next === "every" ? { _tag: "Every" } : { _tag: "Listed", workspaces: selected ? [selected] : [] },
        );
        actions.send([{ _tag: "SelectWorkspaces", workspaces }]);
      }}
    >
      <SelectTrigger size="sm" className="w-44" aria-label="Workspaces">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function SaveFailure() {
  const {
    meta: { saveFailed },
  } = useWorkflowEditor();
  if (!saveFailed) return null;
  return <span className="text-xs text-destructive">Not saved</span>;
}

function EnabledSwitch() {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  const neverSaved = workflow.publishedRevision === null;
  return (
    <Switch
      checked={workflow.enabled}
      disabled={neverSaved && problemsOf(workflow).some(blocksPublish)}
      aria-label="Turn this Workflow on"
      onCheckedChange={async (enabled) => {
        if (enabled && neverSaved) await actions.publish(workflow.id, workflow.workingRevision);
        await actions.switchEnabled(workflow.id, enabled);
      }}
    />
  );
}

function SaveButton() {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  return (
    <Button
      size="sm"
      disabled={
        workflow.publishedRevision === workflow.workingRevision || problemsOf(workflow).some(blocksPublish)
      }
      onClick={() => actions.publish(workflow.id, workflow.workingRevision)}
    >
      Save
    </Button>
  );
}

function MoreMenu() {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More actions" />}>
        <RiMore2Line />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem
            variant="destructive"
            onClick={async () => {
              await actions.delete(workflow.id);
              await navigate({ to: "/workflows" });
            }}
          >
            <RiDeleteBinLine />
            Delete Workflow
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EditorHeader() {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  const problems = problemsOf(workflow);
  const workspaceProblems = problemsAt(problems, { trigger: null, operation: null, field: "workspaces" });
  return (
    <header id={problemTargetId({})} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back to Workflows"
          nativeButton={false}
          render={<Link to="/workflows" />}
        >
          <RiArrowLeftLine />
        </Button>
        <BufferedInput
          value={workflow.workingCopy.name}
          label="Workflow name"
          className="h-auto flex-1 font-heading text-2xl font-semibold tracking-tight"
          save={async (name) => {
            if (!name.trim()) return workflow.workingCopy.name;
            return (await actions.send([{ _tag: "Rename", name }]))?.workingCopy.name ?? name;
          }}
        />
        <SaveFailure />
        <ProblemsButton problems={problems} workflowDocument={workflow.workingCopy} />
        <EnabledSwitch />
        <SaveButton />
        <MoreMenu />
      </div>
      <div className="flex items-center gap-1 ps-9">
        <WorkspaceSelect />
        <ProblemMark problems={workspaceProblems} workflowDocument={workflow.workingCopy} />
      </div>
    </header>
  );
}

function TriggerStart({ trigger, label }: { readonly trigger: WorkflowTrigger; readonly label: string }) {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  const operations = workflow.workingCopy.operations;
  const start = operations.find(({ id }) => id === trigger.start);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className="font-normal text-muted-foreground"
            aria-label={`${label} starts ${start?.name ?? trigger.start}`}
          />
        }
      >
        <RiArrowRightLine data-icon="inline-start" />
        {start?.name ?? trigger.start}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuRadioGroup
            value={trigger.start}
            onValueChange={(next) => {
              const operation = operations.find(({ id }) => id === next);
              if (operation)
                actions.send([{ _tag: "SetTriggerStart", trigger: trigger.id, start: operation.id }]);
            }}
          >
            {operations.map((operation) => (
              <DropdownMenuRadioItem key={operation.id} value={operation.id} closeOnClick>
                {operation.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TriggerRow({ trigger }: { readonly trigger: WorkflowTrigger }) {
  const {
    state: { workflow },
    actions,
    meta: { catalog, listValues },
  } = useWorkflowEditor();
  const entry = catalog?.entries.find(({ key }) => key === trigger.entry);
  const Icon = appIconOf(entry ? appOf(entry) : (trigger.entry.split(".")[0] ?? "cogwork"));
  const name = entry?.name ?? trigger.entry;
  return (
    <div
      id={problemTargetId({ trigger: trigger.id })}
      className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-sm">{name}</span>
      {entry?.parameters.map((parameter) => (
        <ParameterMenu
          key={parameter.id}
          entry={entry}
          parameter={parameter}
          value={trigger.parameters.find(({ id }) => id === parameter.id)?.value ?? ""}
          listValues={listValues}
          onChange={(value) =>
            actions.send([
              { _tag: "SetTriggerParameter", trigger: trigger.id, parameter: parameter.id, values: [value] },
            ])
          }
        />
      ))}
      {workflow.workingCopy.operations.length > 1 ? <TriggerStart trigger={trigger} label={name} /> : null}
      <span className="ms-auto flex items-center gap-0.5">
        <ProblemMark
          problems={problemsAt(problemsOf(workflow), { trigger: trigger.id })}
          workflowDocument={workflow.workingCopy}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${name}`}
          onClick={() => actions.send([{ _tag: "RemoveTrigger", trigger: trigger.id }])}
        >
          <RiCloseLine />
        </Button>
      </span>
    </div>
  );
}

function Triggers() {
  const {
    state: { workflow },
    actions,
    meta: { catalog, machine, listValues },
  } = useWorkflowEditor();
  const entries = catalog?.entries.filter(({ kind }) => kind === "trigger") ?? [];
  const start = orderedOperations(workflow)[0]?.id;
  return (
    <section aria-label="Triggers" className="flex flex-col gap-1.5">
      {workflow.workingCopy.triggers.map((trigger) => (
        <TriggerRow key={trigger.id} trigger={trigger} />
      ))}
      {machine && start ? (
        <CatalogMenu.Provider
          entries={entries}
          machine={machine}
          listValues={listValues}
          onChoose={(choice) => {
            if (choice._tag !== "Entry") return;
            actions.send([
              {
                _tag: "AddTrigger",
                trigger: {
                  id: freshNodeId("trigger", documentNodeIds(workflow.workingCopy)),
                  entry: choice.entry.key,
                  parameters: choice.parameters,
                  start,
                },
              },
            ]);
          }}
        >
          <CatalogMenu.Trigger
            render={
              <Button
                variant="ghost"
                className="w-full justify-start rounded-xl bg-muted/50 py-3 font-normal text-muted-foreground hover:bg-muted"
              />
            }
          >
            <RiAddLine data-icon="inline-start" />
            Add Trigger
          </CatalogMenu.Trigger>
          <CatalogMenu.Content />
        </CatalogMenu.Provider>
      ) : null}
    </section>
  );
}

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

const orderedOperations = (workflow: WorkflowRecord) => {
  const seen = new Set<WorkflowOperation["id"]>();
  const reached = workflow.workingCopy.triggers.flatMap(({ start }) =>
    operationPath(start, workflow.workingCopy.operations, seen),
  );
  return [...reached, ...workflow.workingCopy.operations.filter(({ id }) => !seen.has(id))];
};

const modelSelections = (model: WorkflowModelSelection) =>
  model.options.length === 0 ? null : Object.fromEntries(model.options.map(({ id, value }) => [id, value]));

function OperationModelPicker({ operation }: { readonly operation: WorkflowOperation }) {
  const {
    actions,
    meta: { harnesses },
  } = useWorkflowEditor();
  const catalogs = availableHarnessCatalogs(harnesses.catalogs);
  const providers = providerPickerCatalogs(catalogs, harnesses.readiness);
  const catalog = catalogFor(catalogs, operation.model.harness);
  const model = catalog ? selectedHarnessCatalogModel(catalog.models, operation.model.model) : undefined;
  const own = modelSelections(operation.model);
  const options = model ? modelOptionStates(model, { own, inherited: null, effective: own ?? {} }) : [];
  const setModel = (selection: WorkflowModelSelection) =>
    actions.send([{ _tag: "SetModel", operation: operation.id, model: selection }]);
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
          <ProviderPicker.Trigger />
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
  ...(["mcp-server", "skill", "subagent", "command", "hook"] as const).map((kind) => ({
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
    meta: { needs },
  } = useWorkflowEditor();
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
    meta: { needs },
  } = useWorkflowEditor();
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
    meta: { needs },
  } = useWorkflowEditor();
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
  const {
    actions,
    meta: { needs },
  } = useWorkflowEditor();
  const [query, setQuery] = useState("");
  const nameOf = (identity: NeedIdentity) =>
    needs.find((need) => need.identity === identity)?.name ?? identity;
  const setRequires = (requires: ReadonlyArray<NeedIdentity>) =>
    actions.send([{ _tag: "SetRequires", operation: operation.id, requires }]);
  const toggle = (need: NeedChoice, checked: boolean) =>
    setRequires(
      checked
        ? [...operation.requires, need.identity]
        : operation.requires.filter((identity) => identity !== need.identity),
    );
  return (
    <OperationToolsContext value={{ state: { operation, query }, actions: { toggle } }}>
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
    </OperationToolsContext>
  );
}

function OperationCard({ operation }: { readonly operation: WorkflowOperation }) {
  const {
    state: { workflow },
    actions,
    meta: { catalog, machine, listValues },
  } = useWorkflowEditor();
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
          value={operation.name}
          label="Operation name"
          className="h-7 flex-1 text-sm font-medium"
          save={async (name) => {
            if (!name.trim()) return operation.name;
            const updated = await actions.send([{ _tag: "RenameOperation", operation: operation.id, name }]);
            return updated?.workingCopy.operations.find(({ id }) => id === operation.id)?.name ?? name;
          }}
        />
        <ProblemMark problems={operationProblems} workflowDocument={workflow.workingCopy} />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${operation.name}`}
          onClick={() => actions.send([{ _tag: "RemoveOperation", operation: operation.id }])}
        >
          <RiCloseLine />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg bg-background p-1.5">
        <BufferedTextarea
          rows={3}
          value={operation.instruction}
          label={`Instructions for ${operation.name}`}
          placeholder="Instructions"
          className="min-h-16 py-2 text-sm"
          save={async (instruction) => {
            const updated = await actions.send([
              { _tag: "SetInstruction", operation: operation.id, instruction },
            ]);
            return (
              updated?.workingCopy.operations.find(({ id }) => id === operation.id)?.instruction ??
              instruction
            );
          }}
        />
        <div className="flex flex-wrap items-center gap-1">
          <OperationModelPicker operation={operation} />
          <OperationTools operation={operation} />
        </div>
      </div>

      <div className="px-1">
        <OperationOutcomes.Provider
          value={{
            state: { operation },
            actions: { send: actions.send },
            meta: {
              entries: catalog?.entries.filter(({ kind }) => kind === "action") ?? [],
              machine,
              handOffs: workflow.workingCopy.operations
                .filter(({ id }) => id !== operation.id)
                .map(({ id, name }) => ({ id, name })),
              listValues,
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

function Operations() {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  return (
    <section aria-label="Operations" className="flex flex-col gap-1.5">
      {orderedOperations(workflow).map((operation) => (
        <OperationCard key={operation.id} operation={operation} />
      ))}
      <Button
        variant="ghost"
        className="w-full justify-start rounded-xl bg-muted/50 py-3 font-normal text-muted-foreground hover:bg-muted"
        onClick={() =>
          actions.send([
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

export function WorkflowEditor({ workflow: initial }: { readonly workflow: WorkflowRecord }) {
  const { state, actions } = useWorkflowSession();
  const remote = state.workflows.find(({ id }) => id === initial.id) ?? initial;
  const [preview, setPreview] = useState<WorkflowRecord | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const accepted = useRef(remote);
  const pending = useRef<
    ReadonlyArray<{
      readonly key: symbol;
      readonly edits: Parameters<WorkflowClient["edit"]>[1];
    }>
  >([]);
  const latestAccepted = () =>
    remote.workingRevision > accepted.current.workingRevision ? remote : accepted.current;
  const hasPreview = preview !== null && preview.workingRevision > remote.workingRevision;
  const workflow = hasPreview
    ? {
        ...remote,
        workingCopy: preview.workingCopy,
        workingRevision: preview.workingRevision,
        diagnostics: preview.diagnostics,
        readiness: preview.readiness,
      }
    : remote;
  const editQueue = useRef(Promise.resolve(workflow));
  const refreshPreview = () => {
    const base = latestAccepted();
    const [first, ...rest] = pending.current;
    if (!first) {
      setPreview(base);
      return;
    }
    const edits: Parameters<WorkflowClient["edit"]>[1] = [
      first.edits[0],
      ...first.edits.slice(1),
      ...rest.flatMap((entry) => entry.edits),
    ];
    const applied = applyWorkflowEdits(base.workingCopy, edits);
    if (applied._tag !== "Ok") {
      setPreview(base);
      return;
    }
    const catalog = state.catalog;
    const machine = state.machine;
    const diagnostics = catalog ? validateWorkflow(applied.value, catalog) : base.diagnostics;
    const canAdvise = catalog !== null && machine !== null;
    const readiness = canAdvise ? adviseReadiness(applied.value, catalog, machine) : base.readiness;
    setPreview({
      ...base,
      workingCopy: applied.value,
      workingRevision: base.workingRevision + pending.current.length,
      diagnostics,
      readiness,
    });
  };
  const edit: WorkflowClient["edit"] = async (id, edits) => {
    const key = Symbol();
    pending.current = [...pending.current, { key, edits }];
    refreshPreview();
    const request = editQueue.current.then(() => actions.edit(id, edits));
    const settled = request.then(
      (next) => {
        accepted.current = next;
        pending.current = pending.current.filter((entry) => entry.key !== key);
        setSaveFailed(false);
        refreshPreview();
        return next;
      },
      (error) => {
        pending.current = pending.current.filter((entry) => entry.key !== key);
        setSaveFailed(true);
        refreshPreview();
        throw error;
      },
    );
    editQueue.current = settled.catch(() => accepted.current);
    return settled;
  };
  const editorActions: WorkflowEditorValue["actions"] = {
    ...actions,
    edit,
    send: async (edits) => {
      const [first, ...rest] = edits;
      if (!first) return null;
      return edit(remote.id, [first, ...rest]);
    },
    publish: async (id) => {
      const queued = await editQueue.current;
      const latestRevision = Math.max(
        remote.workingRevision,
        queued.workingRevision,
        accepted.current.workingRevision,
      );
      return actions.publish(id, latestRevision);
    },
  };
  const listValues: ListValues = async (entry, parameter) =>
    (await actions.listOptions(entry.key, parameter.id, workspaceIds(workflow, state.machine))).map(
      (option) => ({
        value: option.value,
        label: option.name,
      }),
    );
  return (
    <WorkflowEditorContext
      value={{
        state: { workflow },
        actions: editorActions,
        meta: {
          catalog: state.catalog,
          machine: state.machine,
          workspaceLabels: state.workspaceLabels,
          harnesses: state.harnesses,
          needs: state.needs,
          listValues,
          saveFailed,
        },
      }}
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 py-8">
        <EditorHeader />
        <Triggers />
        <Operations />
      </div>
    </WorkflowEditorContext>
  );
}
