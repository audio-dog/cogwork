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
import { RiAddLine, RiCloseLine, RiRobot2Line, RiToolsLine } from "@remixicon/react";
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
import { type Operation, operationEdits, type Workflow } from "../features/workflow-model";
import { OperationOutcomes } from "./operation-outcomes";
import { ProviderPicker } from "./provider-picker";
import { CatalogMenu, catalogIconFor } from "./workflow-catalog-menu";

/**
 * The Workflow editor: its Triggers, then each Operation with its instructions, its model, and its
 * outcomes. Every part edits one draft, held here. Runs on mock data — nothing is saved yet.
 */

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

const workspaceValue = (workspaces: readonly string[], every: readonly string[]) => {
  if (workspaces.length === 0) return noWorkspace;
  if (workspaces.length === every.length) return everyWorkspace;
  return workspaces[0] ?? noWorkspace;
};

const workspacesFor = (value: string, every: readonly string[]): readonly string[] => {
  if (value === noWorkspace) return [];
  if (value === everyWorkspace) return every;
  return [value];
};

function WorkspaceSelect() {
  const {
    state: { workflow },
    actions,
    meta: { workspaces },
  } = useWorkflowEditor();
  const items = [
    { value: noWorkspace, label: "No workspace" },
    ...workspaces.map((workspace) => ({ value: workspace, label: workspace })),
    { value: everyWorkspace, label: "Every workspace" },
  ];
  return (
    <Select
      items={items}
      value={workspaceValue(workflow.workspaces, workspaces)}
      onValueChange={(value) => {
        if (typeof value === "string") actions.setWorkspaces(workspacesFor(value, workspaces));
      }}
    >
      <SelectTrigger size="sm" className="w-44 border-0 shadow-none" aria-label="Workspaces">
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
      <div className="flex items-center gap-2 text-sm">
        <Link to="/workflows" className="text-muted-foreground hover:text-foreground">
          Workflows
        </Link>
        <span className="text-muted-foreground">/</span>
        <span>{workflow.name}</span>
        <Button size="sm" className="ms-auto">
          Save
        </Button>
      </div>
      <Input
        value={workflow.name}
        aria-label="Workflow name"
        className="h-auto border-0 bg-transparent px-0 font-heading text-2xl font-semibold tracking-tight shadow-none focus-visible:ring-0 md:text-2xl dark:bg-transparent"
        onChange={(event) => actions.rename(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <Switch
            size="sm"
            checked={workflow.enabled}
            onCheckedChange={actions.setEnabled}
            aria-label="Turn this Workflow on"
          />
          {workflow.enabled ? "On" : "Off"}
        </span>
        <Separator orientation="vertical" className="h-4" />
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
    <section className="flex flex-col gap-1.5">
      <h2 className="text-xs text-muted-foreground">Triggers</h2>
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
        <CatalogMenu.Content placeholder="Search Triggers…" />
      </CatalogMenu.Root>
    </section>
  );
}

/** The Harness and model one Operation runs with. No choice leaves it to the Operation settings. */
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
          value={operation.name}
          aria-label="Operation name"
          className="h-7 flex-1 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
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
          rows={3}
          value={operation.instruction}
          aria-label={`Instructions for ${operation.name}`}
          placeholder="Tell the agent what to do and how to decide."
          className="resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
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
            Add tools, skills or MCPs
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 px-1">
        <h3 className="text-xs text-muted-foreground">Outcomes</h3>
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
    <section className="flex flex-col gap-1.5">
      <h2 className="text-xs text-muted-foreground">Operations</h2>
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
