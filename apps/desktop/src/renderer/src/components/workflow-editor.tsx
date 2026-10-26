import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Input } from "@cogwork/ui/components/input";
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
import { Textarea } from "@cogwork/ui/components/textarea";
import { useAtomValue } from "@effect/atom-react";
import { RiAddLine, RiArrowLeftLine, RiCloseLine, RiRobot2Line, RiToolsLine } from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import { createContext, use } from "react";
import { harnessCatalogsAtom, harnessReadinessAtom } from "../daemon/atoms";
import { BoardResult, useBoard } from "../features/activity-session";
import {
  availableHarnessCatalogs,
  harnessIsDisabled,
  providerPickerCatalogs,
  selectableHarnessCatalogs,
} from "../features/operation-settings";
import {
  actionCatalog,
  type CatalogChoice,
  choiceKey,
  triggerCatalog,
  withOperations,
} from "../features/workflow-catalog";
import { useWorkflowDraft, type WorkflowDraftActions } from "../features/workflow-draft";
import { mockWorkspaces } from "../features/workflow-mock-data";
import {
  type Operation,
  operationEdits,
  type Workflow,
  type WorkspaceScope,
} from "../features/workflow-model";
import { OperationOutcomes } from "./operation-outcomes";
import { ProviderPicker } from "./provider-picker";
import { CatalogMenu, catalogIconFor } from "./workflow-catalog-menu";

interface WorkflowEditorContextValue {
  readonly state: { readonly workflow: Workflow };
  readonly actions: WorkflowDraftActions;
  readonly meta: { readonly workspaces: readonly string[] };
}

const WorkflowEditorContext = createContext<WorkflowEditorContextValue | null>(null);

const useWorkflowEditor = () => {
  const value = use(WorkflowEditorContext);
  if (!value) throw new Error("WorkflowEditor parts need a WorkflowEditor");
  return value;
};

const noWorkspace = "none";
const everyWorkspace = "every";

const workspaceValue = (scope: WorkspaceScope) =>
  scope.kind === "every" ? everyWorkspace : (scope.names[0] ?? noWorkspace);

function WorkspaceSelect() {
  const {
    state: { workflow },
    actions,
    meta: { workspaces },
  } = useWorkflowEditor();
  const items: readonly { value: string; label: string; scope: WorkspaceScope }[] = [
    { value: noWorkspace, label: "No workspace", scope: { kind: "listed", names: [] } },
    ...workspaces.map((workspace) => ({
      value: workspace,
      label: workspace,
      scope: { kind: "listed" as const, names: [workspace] },
    })),
    { value: everyWorkspace, label: "Every workspace", scope: { kind: "every" } },
  ];
  return (
    <Select
      items={items}
      value={workspaceValue(workflow.workspaces)}
      onValueChange={(value) => {
        const picked = items.find((item) => item.value === value);
        if (picked) actions.setWorkspaces(picked.scope);
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

function EditorHeader() {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  return (
    <header className="flex flex-col gap-3">
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
        <Input
          variant="ghost"
          value={workflow.name}
          aria-label="Workflow name"
          className="h-auto flex-1 font-heading text-2xl font-semibold tracking-tight"
          onChange={(event) => actions.rename(event.target.value)}
        />
        <Switch
          checked={workflow.enabled}
          onCheckedChange={actions.setEnabled}
          aria-label="Turn this Workflow on"
        />
        <Button size="sm">Save</Button>
      </div>
      <div className="ps-9">
        <WorkspaceSelect />
      </div>
    </header>
  );
}

function TriggerRow({ trigger }: { readonly trigger: CatalogChoice }) {
  const { actions } = useWorkflowEditor();
  const Icon = catalogIconFor(trigger.icon);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-sm">{trigger.itemName}</span>
      {trigger.optionName ? (
        <Badge variant="secondary" className="font-normal">
          {trigger.optionName}
        </Badge>
      ) : null}
      <Button
        size="icon-sm"
        variant="ghost"
        className="ms-auto"
        aria-label={`Remove ${trigger.itemName}`}
        onClick={() => actions.removeTrigger(trigger)}
      >
        <RiCloseLine />
      </Button>
    </div>
  );
}

function Triggers() {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  return (
    <section aria-label="Triggers" className="flex flex-col gap-1.5">
      {workflow.triggers.map((trigger) => (
        <TriggerRow key={choiceKey(trigger)} trigger={trigger} />
      ))}
      <CatalogMenu.Root catalog={triggerCatalog} onChoose={actions.addTrigger}>
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
        <CatalogMenu.Content placeholder="Search" />
      </CatalogMenu.Root>
    </section>
  );
}

function OperationModelPicker({ operation }: { readonly operation: Operation }) {
  const { actions } = useWorkflowEditor();
  const catalogResult = useAtomValue(harnessCatalogsAtom);
  const readinessResult = useAtomValue(harnessReadinessAtom);
  const boardResult = useBoard();
  const board = BoardResult.$is("Success")(boardResult) ? boardResult.board : null;
  const readiness = board?.harnesses ?? (readinessResult._tag === "Success" ? readinessResult.value : null);
  const controlStore = board?.controlStore ?? null;
  const providers = providerPickerCatalogs(
    availableHarnessCatalogs(catalogResult._tag === "Success" ? catalogResult.value : null),
    readiness,
  );
  return (
    <ProviderPicker.Provider
      value={{
        state: {
          allProviders: providers,
          selectableProviders: selectableHarnessCatalogs(controlStore, providers),
          selectedHarness: operation.model.harness,
          model: operation.model.model,
          options: [],
          own: operation.model.model !== null,
          stale: false,
          disabledHarness: harnessIsDisabled(controlStore, operation.model.harness),
        },
        actions: {
          pick: (harness, model) =>
            actions.updateOperation(operation.id, (current) =>
              operationEdits.chooseModel(current, { harness, model }),
            ),
        },
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
  );
}

function OperationCard({ operation }: { readonly operation: Operation }) {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  const others = workflow.operations.filter((other) => other.id !== operation.id);
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-muted/50 p-2.5">
      <div className="flex items-center gap-2 px-1">
        <RiRobot2Line className="size-4 shrink-0 text-muted-foreground" />
        <Input
          variant="ghost"
          value={operation.name}
          aria-label="Operation name"
          className="h-7 flex-1 text-sm font-medium"
          onChange={(event) => actions.renameOperation(operation.id, event.target.value)}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${operation.name}`}
          onClick={() => actions.removeOperation(operation.id)}
        >
          <RiCloseLine />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg bg-background p-1.5">
        <Textarea
          variant="ghost"
          rows={3}
          value={operation.instruction}
          aria-label={`Instructions for ${operation.name}`}
          placeholder="Instructions"
          className="min-h-16 py-2 text-sm"
          onChange={(event) =>
            actions.updateOperation(operation.id, (current) =>
              operationEdits.instruct(current, event.target.value),
            )
          }
        />
        <div className="flex flex-wrap items-center gap-1">
          <OperationModelPicker operation={operation} />
          <Button size="sm" variant="ghost" className="font-normal text-muted-foreground">
            <RiToolsLine data-icon="inline-start" />
            Tools
          </Button>
        </div>
      </div>

      <div className="px-1">
        <OperationOutcomes.Provider
          operation={operation}
          update={(edit) => actions.updateOperation(operation.id, edit)}
          catalog={withOperations(actionCatalog, others)}
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
      {workflow.operations.map((operation) => (
        <OperationCard key={operation.id} operation={operation} />
      ))}
      <Button
        variant="ghost"
        className="w-full justify-start rounded-xl bg-muted/50 py-3 font-normal text-muted-foreground hover:bg-muted"
        onClick={actions.addOperation}
      >
        <RiAddLine data-icon="inline-start" />
        Add Operation
      </Button>
    </section>
  );
}

export function WorkflowEditor({ workflow: seed }: { readonly workflow: Workflow }) {
  const { workflow, actions } = useWorkflowDraft(seed);
  return (
    <WorkflowEditorContext value={{ state: { workflow }, actions, meta: { workspaces: mockWorkspaces } }}>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 py-8">
        <EditorHeader />
        <Triggers />
        <Operations />
      </div>
    </WorkflowEditorContext>
  );
}
