import type { HarnessName } from "@cogwork/contracts";
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
import { type ReactNode, useState } from "react";
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
import { mockWorkspaces } from "../features/workflow-mock-data";
import { blankOperation, type Operation, type Workflow } from "../features/workflow-model";
import { OperationOutcomes } from "./operation-outcomes";
import { ProviderPicker } from "./provider-picker";
import { AddFromCatalog, catalogIconFor } from "./workflow-catalog-menu";

/**
 * The Workflow editor: its Triggers, then each Operation with its instructions, its model, and its
 * outcomes. Runs on mock data — nothing is saved or sent to the daemon yet.
 */

const noWorkspace = "none";
const everyWorkspace = "every";

const workspaceItems = [
  { value: noWorkspace, label: "No workspace" },
  ...mockWorkspaces.map((workspace) => ({ value: workspace, label: workspace })),
  { value: everyWorkspace, label: "Every workspace" },
];

const workspaceValue = (workspaces: readonly string[]) => {
  if (workspaces.length === 0) return noWorkspace;
  if (workspaces.length === mockWorkspaces.length) return everyWorkspace;
  return workspaces[0] ?? noWorkspace;
};

function Section({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </section>
  );
}

function EditorHeader({ workflow }: { readonly workflow: Workflow }) {
  const [enabled, setEnabled] = useState(workflow.enabled);
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
        defaultValue={workflow.name}
        aria-label="Workflow name"
        className="h-auto border-0 bg-transparent px-0 font-heading text-2xl font-semibold tracking-tight shadow-none focus-visible:ring-0 md:text-2xl dark:bg-transparent"
      />
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <Switch
            size="sm"
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label="Turn this Workflow on"
          />
          {enabled ? "On" : "Off"}
        </span>
        <Separator orientation="vertical" className="h-4" />
        <Select items={workspaceItems} defaultValue={workspaceValue(workflow.workspaces)}>
          <SelectTrigger size="sm" className="w-44 border-0 shadow-none" aria-label="Workspaces">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {workspaceItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </header>
  );
}

function TriggerRow({
  trigger,
  onRemove,
}: {
  readonly trigger: CatalogChoice;
  readonly onRemove: () => void;
}) {
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
        onClick={onRemove}
      >
        <RiCloseLine />
      </Button>
    </div>
  );
}

interface ModelChoice {
  readonly harness: HarnessName | null;
  readonly model: string | null;
}

/** The Harness and model one Operation runs with. No choice means the Operation settings decide. */
function OperationModelPicker() {
  const [choice, setChoice] = useState<ModelChoice>({ harness: null, model: null });
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
          selectedHarness: choice.harness,
          model: choice.model,
          options: [],
          own: choice.model !== null,
          stale: false,
          disabledHarness: harnessIsDisabled(controlStore, choice.harness),
        },
        actions: { pick: (harness, model) => setChoice({ harness, model }) },
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

function OperationCard({
  operation,
  others,
  onRemove,
}: {
  readonly operation: Operation;
  readonly others: readonly Operation[];
  readonly onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-muted/50 p-2.5">
      <div className="flex items-center gap-2 px-1">
        <RiRobot2Line className="size-4 shrink-0 text-muted-foreground" />
        <Input
          defaultValue={operation.name}
          aria-label="Operation name"
          className="h-7 flex-1 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Button size="icon-sm" variant="ghost" aria-label={`Remove ${operation.name}`} onClick={onRemove}>
          <RiCloseLine />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg bg-background p-1.5">
        <Textarea
          rows={3}
          defaultValue={operation.instruction}
          aria-label={`Instructions for ${operation.name}`}
          placeholder="Tell the agent what to do and how to decide."
          className="resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex flex-wrap items-center gap-1">
          <OperationModelPicker />
          <Button size="sm" variant="ghost" className="font-normal text-muted-foreground">
            <RiToolsLine data-icon="inline-start" />
            Add tools, skills or MCPs
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 px-1">
        <span className="text-xs text-muted-foreground">Outcomes</span>
        <OperationOutcomes.Provider seed={operation} catalog={withOperations(actionCatalog, others)}>
          <OperationOutcomes.List />
        </OperationOutcomes.Provider>
      </div>
    </div>
  );
}

export function WorkflowEditor({ workflow }: { readonly workflow: Workflow }) {
  const [triggers, setTriggers] = useState<readonly CatalogChoice[]>(workflow.triggers);
  const [operations, setOperations] = useState<readonly Operation[]>(workflow.operations);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 py-8">
      <EditorHeader workflow={workflow} />

      <Section label="Triggers">
        {triggers.map((trigger) => (
          <TriggerRow
            key={choiceKey(trigger)}
            trigger={trigger}
            onRemove={() => setTriggers(triggers.filter((candidate) => candidate !== trigger))}
          />
        ))}
        <AddFromCatalog
          catalog={triggerCatalog}
          label="Add Trigger"
          placeholder="Search Triggers…"
          onChoose={(trigger) => setTriggers([...triggers, trigger])}
        />
      </Section>

      <Section label="Operations">
        {operations.map((operation) => (
          <OperationCard
            key={operation.id}
            operation={operation}
            others={operations.filter((other) => other.id !== operation.id)}
            onRemove={() => setOperations(operations.filter((other) => other.id !== operation.id))}
          />
        ))}
        <Button
          variant="ghost"
          className="w-full justify-start rounded-xl bg-muted/50 py-3 font-normal text-muted-foreground hover:bg-muted"
          onClick={() => setOperations([...operations, blankOperation(operations.map((other) => other.id))])}
        >
          <RiAddLine data-icon="inline-start" />
          Add Operation
        </Button>
      </Section>
    </div>
  );
}
