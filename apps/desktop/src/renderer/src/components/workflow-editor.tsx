import {
  filterAppliesTo,
  type NeedIdentity,
  selectedHarnessCatalogModel,
  type WorkflowCatalog,
  type WorkflowCatalogEntry,
  type WorkflowCatalogKey,
  type WorkflowModelSelection,
  type WorkflowOperation,
  type WorkflowRecord,
  type WorkflowTrigger,
  WorkflowWorkspaceSelection,
  type WorkspaceId,
} from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
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
  RiFilter3Line,
  RiMore2Line,
  RiPlugLine,
  RiRobot2Line,
  RiToolsLine,
} from "@remixicon/react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
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
import { documentNodeIds, freshNodeId, newWorkflowOperation } from "../features/workflow-defaults";
import { importReviewMark } from "../features/workflow-import-review";
import { type NeedChoice, type NeedKind, useWorkflowSession } from "../features/workflow-session";
import { useWorkingCopy, WorkingCopyProvider } from "../features/working-copy-provider";
import { BufferedInput, BufferedTextarea } from "./buffered-field";
import {
  ImportReview,
  ImportReviewBanner,
  ImportReviewProvider,
  useDismissImportReview,
} from "./import-review";
import { OperationOutcomes, operationIn } from "./operation-outcomes";
import { ProviderPicker } from "./provider-picker";
import { TraitsMenu } from "./traits-menu";
import { appIconOf, appOf, CatalogMenu, ParameterMenu } from "./workflow-catalog-menu";
import {
  blocksPublish,
  ProblemMark,
  ProblemsButton,
  problemsAt,
  problemsOf,
  problemTargetId,
} from "./workflow-problems";

const decodeWorkspaceSelection = Schema.decodeUnknownSync(WorkflowWorkspaceSelection);

function WorkspaceSelect() {
  const {
    state: { workflow },
    actions,
  } = useWorkingCopy();
  const {
    state: { machine, workspaceLabels },
  } = useWorkflowSession();
  const dismissImportReview = useDismissImportReview();
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
        dismissImportReview(importReviewMark.workspaces);
        const selected =
          next === currentWorkspace
            ? currentWorkspace
            : machine?.workspaces.find(({ id }) => id === next)?.id;
        const workspaces = decodeWorkspaceSelection(
          next === "every" ? { _tag: "Every" } : { _tag: "Listed", workspaces: selected ? [selected] : [] },
        );
        actions.edit([{ _tag: "SelectWorkspaces", workspaces }]);
      }}
    >
      <ImportReview mark={importReviewMark.workspaces}>
        <SelectTrigger size="sm" className="w-44" aria-label="Workspaces">
          <SelectValue />
        </SelectTrigger>
      </ImportReview>
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
    state: { saveStatus },
  } = useWorkingCopy();
  if (saveStatus === "saved") return null;
  return <span className="text-xs text-destructive">Not saved</span>;
}

function EnabledSwitch() {
  const {
    state: { workflow },
    actions,
  } = useWorkingCopy();
  const neverSaved = workflow.publishedRevision === null;
  return (
    <Switch
      checked={workflow.enabled}
      disabled={neverSaved && problemsOf(workflow).some(blocksPublish)}
      aria-label="Turn this Workflow on"
      onCheckedChange={(enabled) => actions.switchEnabled(enabled)}
    />
  );
}

function SaveButton() {
  const {
    state: { workflow },
    actions,
  } = useWorkingCopy();
  return (
    <Button
      size="sm"
      disabled={
        workflow.publishedRevision === workflow.workingRevision || problemsOf(workflow).some(blocksPublish)
      }
      onClick={() => actions.publish()}
    >
      Save
    </Button>
  );
}

function MoreMenu() {
  const {
    state: { workflow },
  } = useWorkingCopy();
  const { actions } = useWorkflowSession();
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
  } = useWorkingCopy();
  const name = actions.field(
    (current) => current.workingCopy.name,
    (text) => [{ _tag: "Rename", name: text }],
  );
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
          value={name.value}
          label="Workflow name"
          className="h-auto flex-1 font-heading text-2xl font-semibold tracking-tight"
          save={name.save}
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
  } = useWorkingCopy();
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
                actions.edit([{ _tag: "SetTriggerStart", trigger: trigger.id, start: operation.id }]);
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

const catalogEntryOf = (catalog: WorkflowCatalog | null, key: WorkflowCatalogKey) =>
  catalog?.entries.find((candidate) => candidate.key === key);

function TriggerFilters({
  trigger,
  entry,
}: {
  readonly trigger: WorkflowTrigger;
  readonly entry: WorkflowCatalogEntry;
}) {
  const { actions } = useWorkingCopy();
  const {
    state: { catalog },
  } = useWorkflowSession();
  const nameOf = (key: WorkflowCatalogKey) => catalogEntryOf(catalog, key)?.name ?? key;
  const addable =
    catalog?.entries.filter(
      (candidate) =>
        filterAppliesTo(candidate, entry) && !trigger.filters.some((added) => added.entry === candidate.key),
    ) ?? [];
  return (
    <>
      {trigger.filters.map((added) => (
        <span key={added.entry} className="flex items-center gap-1 text-xs text-muted-foreground">
          and
          <Badge variant="secondary">{nameOf(added.entry)}</Badge>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove filter ${nameOf(added.entry)}`}
            onClick={() =>
              actions.edit([{ _tag: "RemoveTriggerFilter", trigger: trigger.id, entry: added.entry }])
            }
          >
            <RiCloseLine />
          </Button>
        </span>
      ))}
      {addable.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="xs" variant="ghost" className="font-normal text-muted-foreground" />}
          >
            <RiFilter3Line data-icon="inline-start" />
            Add filter
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            <DropdownMenuGroup>
              {addable.map((candidate) => (
                <DropdownMenuItem
                  key={candidate.key}
                  label={candidate.name}
                  onClick={() =>
                    actions.edit([
                      { _tag: "AddTriggerFilter", trigger: trigger.id, filter: { entry: candidate.key } },
                    ])
                  }
                >
                  {candidate.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  );
}

function TriggerRow({ trigger }: { readonly trigger: WorkflowTrigger }) {
  const {
    state: { workflow },
    actions,
    meta: { listValues },
  } = useWorkingCopy();
  const {
    state: { catalog },
  } = useWorkflowSession();
  const dismissImportReview = useDismissImportReview();
  const entry = catalogEntryOf(catalog, trigger.entry);
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
        <ImportReview key={parameter.id} mark={importReviewMark.triggerParameter(trigger.id, parameter.id)}>
          <ParameterMenu
            entry={entry}
            parameter={parameter}
            value={trigger.parameters.find(({ id }) => id === parameter.id)?.value ?? ""}
            listValues={listValues}
            onChange={(value) => {
              dismissImportReview(importReviewMark.triggerParameter(trigger.id, parameter.id));
              actions.edit([
                {
                  _tag: "SetTriggerParameter",
                  trigger: trigger.id,
                  parameter: parameter.id,
                  values: [value],
                },
              ]);
            }}
          />
        </ImportReview>
      ))}
      {entry ? <TriggerFilters trigger={trigger} entry={entry} /> : null}
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
          onClick={() => actions.edit([{ _tag: "RemoveTrigger", trigger: trigger.id }])}
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
    meta: { listValues },
  } = useWorkingCopy();
  const {
    state: { catalog, machine },
  } = useWorkflowSession();
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
            actions.edit([
              {
                _tag: "AddTrigger",
                trigger: {
                  id: freshNodeId("trigger", documentNodeIds(workflow.workingCopy)),
                  entry: choice.entry.key,
                  parameters: choice.parameters,
                  filters: [],
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
        <BufferedTextarea
          rows={3}
          value={instruction.value}
          label={`Instructions for ${operation.name}`}
          placeholder="Instructions"
          className="min-h-16 py-2 text-sm"
          save={instruction.save}
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

function Operations() {
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

export function WorkflowEditor({
  workflow,
  importReview = [],
  onPublished,
}: {
  readonly workflow: WorkflowRecord;
  readonly importReview?: readonly string[];
  readonly onPublished?: () => void;
}) {
  const [reviewMarks, setReviewMarks] = useState(importReview);
  const dismissImportReview = (mark: string) =>
    setReviewMarks((current) => current.filter((item) => item !== mark));
  return (
    <WorkingCopyProvider workflow={workflow} onPublished={onPublished}>
      <ImportReviewProvider marks={reviewMarks} dismiss={dismissImportReview}>
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 py-8">
          <ImportReviewBanner />
          <EditorHeader />
          <Triggers />
          <Operations />
        </div>
      </ImportReviewProvider>
    </WorkingCopyProvider>
  );
}
