import {
  adviseReadiness,
  applyWorkflowEdits,
  type MachineReadiness,
  NeedIdentity,
  RunPlanPolicyProfile,
  validateWorkflow,
  type WorkflowCatalog,
  type WorkflowCatalogEntry,
  type WorkflowDiagnostic,
  type WorkflowEdit,
  type WorkflowNodeId,
  WorkflowNodeId as WorkflowNodeIdSchema,
  type WorkflowOperation,
  type WorkflowParameterValue,
  type WorkflowRecord,
  WorkflowWorkspaceSelection,
} from "@cogwork/contracts";
import { Alert, AlertDescription } from "@cogwork/ui/components/alert";
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
import { useDebouncedCallback } from "@react-hookz/web";
import { RiAddLine, RiArrowLeftLine, RiCloseLine, RiDeleteBinLine, RiRobot2Line } from "@remixicon/react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { createContext, use, useRef, useState } from "react";
import { newWorkflowOperation } from "../features/workflow-defaults";
import { useWorkflowSession, type WorkflowClient } from "../features/workflow-session";
import { CatalogMenu } from "./workflow-catalog-menu";

interface WorkflowEditorValue {
  readonly state: { readonly workflow: WorkflowRecord };
  readonly actions: WorkflowClient;
  readonly meta: {
    readonly catalog: WorkflowCatalog | null;
    readonly machine: MachineReadiness | null;
  };
}

const WorkflowEditorContext = createContext<WorkflowEditorValue | null>(null);

const useWorkflowEditor = () => {
  const value = use(WorkflowEditorContext);
  if (!value) throw new Error("WorkflowEditor parts need a WorkflowEditor");
  return value;
};

const decodeNodeId = Schema.decodeUnknownSync(WorkflowNodeIdSchema);
const decodeNeed = Schema.decodeUnknownSync(NeedIdentity);
const decodeWorkspaceSelection = Schema.decodeUnknownSync(WorkflowWorkspaceSelection);
const freshNodeId = (prefix: string) => decodeNodeId(`${prefix}-${crypto.randomUUID()}`);

const editOne = (actions: WorkflowClient, workflow: WorkflowRecord, edit: WorkflowEdit) =>
  actions.edit(workflow.id, [edit]);

const diagnosticsAt = (workflow: WorkflowRecord, location: Partial<WorkflowDiagnostic["location"]>) =>
  [...workflow.diagnostics, ...workflow.readiness].filter((diagnostic) =>
    [
      { expected: location.trigger, actual: diagnostic.location.trigger },
      { expected: location.operation, actual: diagnostic.location.operation },
      { expected: location.question, actual: diagnostic.location.question },
      { expected: location.choice, actual: diagnostic.location.choice },
      { expected: location.field, actual: diagnostic.location.field },
    ].every(({ expected, actual }) => expected === undefined || expected === actual),
  );

const diagnosticKey = (diagnostic: WorkflowDiagnostic, index: number) =>
  [
    diagnostic.code,
    diagnostic.class,
    diagnostic.location.trigger,
    diagnostic.location.operation,
    diagnostic.location.question,
    diagnostic.location.choice,
    diagnostic.location.field,
    diagnostic.message,
    index,
  ].join(":");

function Diagnostics({ diagnostics }: { readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> }) {
  return diagnostics.map((diagnostic, index) => (
    <Alert key={diagnosticKey(diagnostic, index)} data-diagnostic-class={diagnostic.class}>
      <AlertDescription className="flex items-center gap-2">
        <Badge variant={diagnostic.class === "malformed" ? "destructive" : "secondary"}>
          {diagnostic.class}
        </Badge>
        {diagnostic.code === "hand-off-and-trigger"
          ? `${diagnostic.message.split(" ").at(-1)} will run two times`
          : diagnostic.message}
      </AlertDescription>
    </Alert>
  ));
}

interface BufferedTextState {
  readonly server: string;
  readonly text: string;
  readonly dirty: boolean;
}

const useBufferedText = (value: string, save: (text: string) => Promise<string>) => {
  const [state, setState] = useState<BufferedTextState>({ server: value, text: value, dirty: false });
  const submitted = useRef(value);
  const generation = useRef(0);
  const draft = state.server === value || state.dirty ? state : { server: value, text: value, dirty: false };
  const submit = async (draft: string) => {
    if (draft === submitted.current) return;
    submitted.current = draft;
    const atGeneration = generation.current;
    try {
      const daemonValue = await save(draft);
      if (atGeneration !== generation.current) return;
      submitted.current = daemonValue;
      setState({ server: daemonValue, text: daemonValue, dirty: false });
    } catch {
      if (atGeneration !== generation.current) return;
      submitted.current = value;
      setState({ server: value, text: value, dirty: false });
    }
  };
  const submitAfterPause = useDebouncedCallback(submit, [save], 500);
  return {
    text: draft.text,
    setText: (next: string) => {
      const nextGeneration = generation.current + 1;
      generation.current = nextGeneration;
      if (!draft.dirty) submitted.current = draft.text;
      setState({ server: draft.server, text: next, dirty: true });
      submitAfterPause(next);
    },
    blur: () => (draft.dirty ? submit(draft.text) : undefined),
  };
};

function BufferedInput({
  value,
  save,
  label,
  className,
  placeholder,
}: {
  readonly value: string;
  readonly save: (text: string) => Promise<string>;
  readonly label: string;
  readonly className?: string;
  readonly placeholder?: string;
}) {
  const draft = useBufferedText(value, save);
  return (
    <Input
      variant="ghost"
      value={draft.text}
      aria-label={label}
      className={className}
      placeholder={placeholder}
      onChange={(event) => draft.setText(event.target.value)}
      onBlur={draft.blur}
    />
  );
}

function BufferedTextarea({
  value,
  save,
  label,
  placeholder,
}: {
  readonly value: string;
  readonly save: (text: string) => Promise<string>;
  readonly label: string;
  readonly placeholder?: string;
}) {
  const draft = useBufferedText(value, save);
  return (
    <Textarea
      variant="ghost"
      rows={3}
      value={draft.text}
      aria-label={label}
      placeholder={placeholder}
      className="min-h-16 py-2 text-sm"
      onChange={(event) => draft.setText(event.target.value)}
      onBlur={draft.blur}
    />
  );
}

const workspaceIds = (workflow: WorkflowRecord, machine: MachineReadiness | null) =>
  workflow.workingCopy.workspaces._tag === "Listed"
    ? workflow.workingCopy.workspaces.workspaces
    : (machine?.workspaces.map(({ id }) => id) ?? []);

function WorkspaceSelect() {
  const {
    state: { workflow },
    actions,
    meta: { machine },
  } = useWorkflowEditor();
  const current = workflow.workingCopy.workspaces;
  const currentWorkspace = current._tag === "Listed" ? current.workspaces[0] : undefined;
  const value = current._tag === "Every" ? "every" : (currentWorkspace ?? "none");
  const machineItems = machine?.workspaces.map(({ id }) => ({ value: id, label: id })) ?? [];
  const currentWorkspaceIsMissing =
    currentWorkspace !== undefined && !machineItems.some(({ value: id }) => id === currentWorkspace);
  const items = [
    { value: "none", label: "No workspace" },
    ...(currentWorkspaceIsMissing ? [{ value: currentWorkspace, label: currentWorkspace }] : []),
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
        editOne(actions, workflow, { _tag: "SelectWorkspaces", workspaces });
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
  const navigate = useNavigate();
  const incomplete = workflow.diagnostics.some(
    ({ class: diagnosticClass }) => diagnosticClass === "incomplete",
  );
  const rootDiagnostics = diagnosticsAt(workflow, {
    trigger: null,
    operation: null,
    question: null,
    choice: null,
  });
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
        <BufferedInput
          value={workflow.workingCopy.name}
          label="Workflow name"
          className="h-auto flex-1 font-heading text-2xl font-semibold tracking-tight"
          save={async (name) => {
            if (!name.trim()) return workflow.workingCopy.name;
            return (await editOne(actions, workflow, { _tag: "Rename", name })).workingCopy.name;
          }}
        />
        <Switch
          checked={workflow.enabled}
          disabled={workflow.publishedRevision === null}
          onCheckedChange={(enabled) => actions.switchEnabled(workflow.id, enabled)}
          aria-label="Turn this Workflow on"
        />
        <Button
          size="sm"
          disabled={incomplete || workflow.publishedRevision === workflow.workingRevision}
          onClick={() => actions.publish(workflow.id, workflow.workingRevision)}
        >
          Publish
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Delete Workflow"
          onClick={async () => {
            await actions.delete(workflow.id);
            await navigate({ to: "/workflows" });
          }}
        >
          <RiDeleteBinLine />
        </Button>
      </div>
      <div className="ps-9">
        <WorkspaceSelect />
      </div>
      <Diagnostics diagnostics={rootDiagnostics} />
    </header>
  );
}

const parameterValue = (parameters: ReadonlyArray<WorkflowParameterValue>, id: string) =>
  parameters.find((parameter) => parameter.id === id)?.value ?? "";

function TriggerParameter({
  triggerId,
  entry,
  parameter,
}: {
  readonly triggerId: WorkflowNodeId;
  readonly entry: WorkflowCatalogEntry;
  readonly parameter: WorkflowCatalogEntry["parameters"][number];
}) {
  const {
    state: { workflow },
    actions,
    meta: { machine },
  } = useWorkflowEditor();
  const trigger = workflow.workingCopy.triggers.find(({ id }) => id === triggerId);
  const [liveOptions, setLiveOptions] = useState<
    ReadonlyArray<{ readonly value: string; readonly label: string }>
  >(
    parameterValue(trigger?.parameters ?? [], parameter.id)
      ? [
          {
            value: parameterValue(trigger?.parameters ?? [], parameter.id),
            label: parameterValue(trigger?.parameters ?? [], parameter.id),
          },
        ]
      : [],
  );
  if (!trigger) return null;
  const options = liveOptions;
  const selected = parameterValue(trigger.parameters, parameter.id);
  return (
    <Select
      items={options}
      value={selected}
      onOpenChange={async (open) => {
        if (!open) return;
        setLiveOptions(
          (await actions.listOptions(entry.key, parameter.id, workspaceIds(workflow, machine))).map(
            ({ value, name }) => ({ value, label: name }),
          ),
        );
      }}
      onValueChange={(value) => {
        if (value === null) return;
        editOne(actions, workflow, {
          _tag: "SetTriggerParameter",
          trigger: trigger.id,
          parameter: parameter.id,
          values: [value],
        });
      }}
    >
      <SelectTrigger size="sm" aria-label={`${entry.name} ${parameter.id}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function TriggerRow({ triggerId }: { readonly triggerId: WorkflowNodeId }) {
  const {
    state: { workflow },
    actions,
    meta: { catalog },
  } = useWorkflowEditor();
  const trigger = workflow.workingCopy.triggers.find(({ id }) => id === triggerId);
  const entry = catalog?.entries.find(({ key }) => key === trigger?.entry);
  if (!trigger) return null;
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-muted/50 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{entry?.name ?? trigger.entry}</span>
        {entry?.parameters.map((parameter) => (
          <TriggerParameter key={parameter.id} triggerId={trigger.id} entry={entry} parameter={parameter} />
        ))}
        <Select
          items={workflow.workingCopy.operations.map(({ id, name }) => ({ value: id, label: name }))}
          value={trigger.start}
          onValueChange={(start) => {
            const operation = workflow.workingCopy.operations.find(({ id }) => id === start);
            if (operation)
              editOne(actions, workflow, {
                _tag: "SetTriggerStart",
                trigger: trigger.id,
                start: operation.id,
              });
          }}
        >
          <SelectTrigger size="sm" aria-label={`${entry?.name ?? trigger.entry} starts`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {workflow.workingCopy.operations.map((operation) => (
                <SelectItem key={operation.id} value={operation.id}>
                  {operation.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          size="icon-sm"
          variant="ghost"
          className="ms-auto"
          aria-label={`Remove ${entry?.name ?? trigger.entry}`}
          onClick={() => editOne(actions, workflow, { _tag: "RemoveTrigger", trigger: trigger.id })}
        >
          <RiCloseLine />
        </Button>
      </div>
      <Diagnostics diagnostics={diagnosticsAt(workflow, { trigger: trigger.id })} />
    </div>
  );
}

function Triggers() {
  const {
    state: { workflow },
    actions,
    meta: { catalog, machine },
  } = useWorkflowEditor();
  const entries = catalog?.entries.filter(({ kind }) => kind === "trigger") ?? [];
  const start = workflow.workingCopy.operations[0]?.id;
  return (
    <section aria-label="Triggers" className="flex flex-col gap-1.5">
      {workflow.workingCopy.triggers.map((trigger) => (
        <TriggerRow key={trigger.id} triggerId={trigger.id} />
      ))}
      {machine && start ? (
        <CatalogMenu.Provider
          entries={entries}
          machine={machine}
          onChoose={(entry) =>
            editOne(actions, workflow, {
              _tag: "AddTrigger",
              trigger: {
                id: freshNodeId("trigger"),
                entry: entry.key,
                parameters: [],
                start,
              },
            })
          }
        >
          <CatalogMenu.Trigger
            render={
              <Button
                variant="ghost"
                className="w-full justify-start rounded-xl bg-muted/50 py-3 font-normal text-muted-foreground hover:bg-muted"
              />
            }
          >
            <RiAddLine data-icon="inline-start" /> Add Trigger
          </CatalogMenu.Trigger>
          <CatalogMenu.Content />
        </CatalogMenu.Provider>
      ) : null}
    </section>
  );
}

const operationPath = (
  id: WorkflowNodeId,
  operations: ReadonlyArray<WorkflowOperation>,
  seen: Set<WorkflowNodeId>,
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
  const seen = new Set<WorkflowNodeId>();
  const reached = workflow.workingCopy.triggers.flatMap(({ start }) =>
    operationPath(start, workflow.workingCopy.operations, seen),
  );
  return [...reached, ...workflow.workingCopy.operations.filter(({ id }) => !seen.has(id))];
};

function OperationSettings({ operation }: { readonly operation: WorkflowOperation }) {
  const {
    state: { workflow },
    actions,
    meta: { catalog },
  } = useWorkflowEditor();
  const models =
    catalog?.harnesses.flatMap((harness) =>
      harness.models.map((model) => ({ value: `${harness.name}/${model.id}`, harness: harness.name, model })),
    ) ?? [];
  const selectedModel =
    operation.model.harness && operation.model.model
      ? `${operation.model.harness}/${operation.model.model}`
      : "default";
  const model = models.find(({ value }) => value === selectedModel)?.model;
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-background p-2">
      <BufferedTextarea
        value={operation.instruction}
        label={`Instructions for ${operation.name}`}
        placeholder="Instructions"
        save={async (instruction) =>
          (
            await editOne(actions, workflow, { _tag: "SetInstruction", operation: operation.id, instruction })
          ).workingCopy.operations.find(({ id }) => id === operation.id)?.instruction ?? instruction
        }
      />
      <div className="flex flex-wrap gap-2">
        <Select
          items={[
            { value: "none", label: "No package" },
            ...(catalog?.instructionPackages.map((value) => ({ value, label: value })) ?? []),
          ]}
          value={operation.instructionPackage ?? "none"}
          onValueChange={(value) =>
            editOne(actions, workflow, {
              _tag: "SetInstructionPackage",
              operation: operation.id,
              package: value === "none" ? null : value,
            })
          }
        >
          <SelectTrigger size="sm" aria-label={`${operation.name} instruction package`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="none">No package</SelectItem>
              {catalog?.instructionPackages.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          items={RunPlanPolicyProfile.literals.map((value) => ({
            value,
            label: value === "read-only" ? "Read only" : "Full",
          }))}
          value={operation.permissionProfile}
          onValueChange={(profile) => {
            const selected = RunPlanPolicyProfile.literals.find((value) => value === profile);
            if (selected)
              editOne(actions, workflow, {
                _tag: "SetPermissionProfile",
                operation: operation.id,
                profile: selected,
              });
          }}
        >
          <SelectTrigger size="sm" aria-label={`${operation.name} permission profile`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="read-only">Read only</SelectItem>
              <SelectItem value="full">Full</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          items={[
            { value: "default", label: "Default model" },
            ...models.map(({ value }) => ({ value, label: value })),
          ]}
          value={selectedModel}
          onValueChange={(value) => {
            const picked = models.find((candidate) => candidate.value === value);
            editOne(actions, workflow, {
              _tag: "SetModel",
              operation: operation.id,
              model: picked
                ? { harness: picked.harness, model: picked.model.id, options: [] }
                : { harness: null, model: null, options: [] },
            });
          }}
        >
          <SelectTrigger size="sm" aria-label={`${operation.name} model`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="default">Default model</SelectItem>
              {models.map(({ value }) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {model?.options.map((descriptor) => {
        const selected =
          operation.model.options.find(({ id }) => id === descriptor.id)?.value ?? descriptor.values[0];
        if (selected === undefined) return null;
        return (
          <Select
            key={descriptor.id}
            items={descriptor.values.map((value) => ({ value: String(value), label: String(value) }))}
            value={String(selected)}
            onValueChange={(value) =>
              editOne(actions, workflow, {
                _tag: "SetModel",
                operation: operation.id,
                model: {
                  ...operation.model,
                  options: [
                    ...operation.model.options.filter(({ id }) => id !== descriptor.id),
                    {
                      id: descriptor.id,
                      value: descriptor.values.includes(true) ? value === "true" : (value ?? ""),
                    },
                  ],
                },
              })
            }
          >
            <SelectTrigger size="sm" aria-label={`${operation.name} ${descriptor.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {descriptor.values.map((value) => (
                  <SelectItem key={String(value)} value={String(value)}>
                    {String(value)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        );
      })}
      <BufferedInput
        value={operation.requires.join(", ")}
        label={`${operation.name} requires`}
        placeholder="Requires"
        save={async (text) => {
          const requires = text
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
            .map((value) => decodeNeed(value));
          const updated = await editOne(actions, workflow, {
            _tag: "SetRequires",
            operation: operation.id,
            requires,
          });
          return (
            updated.workingCopy.operations.find(({ id }) => id === operation.id)?.requires.join(", ") ?? text
          );
        }}
      />
      <BufferedInput
        value={operation.forEach ?? ""}
        label={`${operation.name} for each finding`}
        placeholder="For each finding"
        save={async (text) => {
          const forEach = text.trim() || null;
          const updated = await editOne(actions, workflow, {
            _tag: "SetForEach",
            operation: operation.id,
            forEach,
          });
          return updated.workingCopy.operations.find(({ id }) => id === operation.id)?.forEach ?? "";
        }}
      />
    </div>
  );
}

const transitionLabel = (
  operation: WorkflowOperation,
  when: WorkflowOperation["transitions"][number]["when"],
) => {
  if (when.length === 0) return "Every time";
  return when
    .map((answer) => {
      const question = operation.questions.find(({ id }) => id === answer.question);
      const choice = question?.choices.find(({ id }) => id === answer.choice);
      return `${question?.text ?? answer.question}: ${choice?.name ?? answer.choice}`;
    })
    .join(" · ");
};

function ActionParameter({
  entry,
  parameter,
  value,
  onChange,
}: {
  readonly entry: WorkflowCatalogEntry;
  readonly parameter: WorkflowCatalogEntry["parameters"][number];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const {
    state: { workflow },
    actions,
    meta: { machine },
  } = useWorkflowEditor();
  const [options, setOptions] = useState<ReadonlyArray<{ readonly value: string; readonly label: string }>>(
    value ? [{ value, label: value }] : [],
  );
  return (
    <Select
      items={options}
      value={value}
      onOpenChange={async (open) => {
        if (!open) return;
        setOptions(
          (await actions.listOptions(entry.key, parameter.id, workspaceIds(workflow, machine))).map(
            (option) => ({
              value: option.value,
              label: option.name,
            }),
          ),
        );
      }}
      onValueChange={(selected) => {
        if (selected !== null) onChange(selected);
      }}
    >
      <SelectTrigger size="sm" aria-label={`${entry.name} ${parameter.id}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function Transition({ operation, index }: { readonly operation: WorkflowOperation; readonly index: number }) {
  const {
    state: { workflow },
    actions,
    meta: { catalog, machine },
  } = useWorkflowEditor();
  const transition = operation.transitions[index];
  if (!transition) return null;
  const entries = catalog?.entries.filter(({ kind }) => kind === "action") ?? [];
  return (
    <div className="flex flex-col gap-2 rounded-lg px-2 py-1.5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span>{transitionLabel(operation, transition.when)}</span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ms-auto"
          aria-label="Remove Transition"
          onClick={() =>
            editOne(actions, workflow, {
              _tag: "RemoveTransition",
              operation: operation.id,
              when: transition.when,
            })
          }
        >
          <RiCloseLine />
        </Button>
      </div>
      {transition.actions.map((action, actionIndex) => {
        const entry = entries.find(({ key }) => key === action.entry);
        return (
          <div key={`${action.entry}:${actionIndex}`} className="flex flex-wrap items-center gap-2 text-sm">
            <span>{entry?.name ?? action.entry}</span>
            {entry?.parameters.map((parameter) => (
              <ActionParameter
                key={parameter.id}
                entry={entry}
                parameter={parameter}
                value={parameterValue(action.parameters, parameter.id)}
                onChange={(value) => {
                  const parameters = [
                    ...action.parameters.filter(({ id }) => id !== parameter.id),
                    { id: parameter.id, value },
                  ];
                  editOne(actions, workflow, {
                    _tag: "SetTransitionActions",
                    operation: operation.id,
                    when: transition.when,
                    actions: transition.actions.map((candidate, candidateIndex) =>
                      candidateIndex === actionIndex ? { ...candidate, parameters } : candidate,
                    ),
                  });
                }}
              />
            ))}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove ${entry?.name ?? action.entry}`}
              onClick={() =>
                editOne(actions, workflow, {
                  _tag: "SetTransitionActions",
                  operation: operation.id,
                  when: transition.when,
                  actions: transition.actions.filter((_, candidate) => candidate !== actionIndex),
                })
              }
            >
              <RiCloseLine />
            </Button>
          </div>
        );
      })}
      {machine ? (
        <CatalogMenu.Provider
          entries={entries}
          machine={machine}
          onChoose={(entry) =>
            editOne(actions, workflow, {
              _tag: "SetTransitionActions",
              operation: operation.id,
              when: transition.when,
              actions: [...transition.actions, { entry: entry.key, parameters: [] }],
            })
          }
        >
          <CatalogMenu.Trigger render={<Button size="xs" variant="ghost" className="self-start" />}>
            <RiAddLine data-icon="inline-start" /> Add Action
          </CatalogMenu.Trigger>
          <CatalogMenu.Content />
        </CatalogMenu.Provider>
      ) : null}
      <Select
        items={[
          { value: "none", label: "No hand-off" },
          ...workflow.workingCopy.operations
            .filter(({ id }) => id !== operation.id)
            .map(({ id, name }) => ({ value: id, label: name })),
        ]}
        value={transition.handOff ?? "none"}
        onValueChange={(handOff) => {
          const target = workflow.workingCopy.operations.find(({ id }) => id === handOff)?.id ?? null;
          editOne(actions, workflow, {
            _tag: "SetTransitionHandOff",
            operation: operation.id,
            when: transition.when,
            handOff: target,
          });
        }}
      >
        <SelectTrigger size="sm" aria-label={`${transitionLabel(operation, transition.when)} hand-off`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="none">No hand-off</SelectItem>
            {workflow.workingCopy.operations
              .filter(({ id }) => id !== operation.id)
              .map(({ id, name }) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

function OperationQuestions({ operation }: { readonly operation: WorkflowOperation }) {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  return (
    <div className="flex flex-col gap-2">
      {operation.questions.map((question) => (
        <div key={question.id} className="flex flex-col gap-1 rounded-lg px-2 py-1.5">
          <div className="flex gap-2">
            <BufferedInput
              value={question.text}
              label={`${operation.name} question`}
              save={async (text) => {
                if (!text.trim()) return question.text;
                const updated = await editOne(actions, workflow, {
                  _tag: "SetQuestionText",
                  operation: operation.id,
                  question: question.id,
                  text,
                });
                return (
                  updated.workingCopy.operations
                    .find(({ id }) => id === operation.id)
                    ?.questions.find(({ id }) => id === question.id)?.text ?? text
                );
              }}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Remove question"
              onClick={() =>
                editOne(actions, workflow, {
                  _tag: "RemoveQuestion",
                  operation: operation.id,
                  question: question.id,
                })
              }
            >
              <RiCloseLine />
            </Button>
          </div>
          <Diagnostics
            diagnostics={diagnosticsAt(workflow, {
              operation: operation.id,
              question: question.id,
              choice: null,
            })}
          />
          {question.choices.map((choice) => (
            <div key={choice.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-1">
                <BufferedInput
                  value={choice.name}
                  label={`${question.text} ${choice.id}`}
                  className="flex-1"
                  save={async (name) => {
                    if (!name.trim()) return choice.name;
                    const updated = await editOne(actions, workflow, {
                      _tag: "RenameChoice",
                      operation: operation.id,
                      question: question.id,
                      choice: choice.id,
                      name,
                    });
                    return (
                      updated.workingCopy.operations
                        .find(({ id }) => id === operation.id)
                        ?.questions.find(({ id }) => id === question.id)
                        ?.choices.find(({ id }) => id === choice.id)?.name ?? name
                    );
                  }}
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${choice.name}`}
                  onClick={() =>
                    editOne(actions, workflow, {
                      _tag: "RemoveChoice",
                      operation: operation.id,
                      question: question.id,
                      choice: choice.id,
                    })
                  }
                >
                  <RiCloseLine />
                </Button>
              </div>
              <Diagnostics
                diagnostics={diagnosticsAt(workflow, {
                  operation: operation.id,
                  question: question.id,
                  choice: choice.id,
                })}
              />
            </div>
          ))}
          <Button
            size="xs"
            variant="ghost"
            className="self-start"
            onClick={() =>
              editOne(actions, workflow, {
                _tag: "AddChoice",
                operation: operation.id,
                question: question.id,
                choice: { id: freshNodeId("answer"), name: "New answer" },
              })
            }
          >
            <RiAddLine data-icon="inline-start" /> Add Answer
          </Button>
        </div>
      ))}
      <Button
        size="xs"
        variant="ghost"
        className="self-start"
        onClick={() => {
          const question = freshNodeId("question");
          editOne(actions, workflow, {
            _tag: "AddQuestion",
            operation: operation.id,
            question: {
              id: question,
              text: "What should happen?",
              choices: [
                { id: freshNodeId("answer"), name: "Yes" },
                { id: freshNodeId("answer"), name: "No" },
              ],
            },
          });
        }}
      >
        <RiAddLine data-icon="inline-start" /> Add Question
      </Button>
    </div>
  );
}

const transitionKey = (answers: WorkflowOperation["transitions"][number]["when"]) =>
  answers
    .map(({ question, choice }) => `${question}:${choice}`)
    .sort()
    .join("|");

function AddTransition({ operation }: { readonly operation: WorkflowOperation }) {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  const [answers, setAnswers] = useState<WorkflowOperation["transitions"][number]["when"]>([]);
  const orderedAnswers = operation.questions.flatMap((question) => {
    const answer = answers.find((candidate) => candidate.question === question.id);
    return answer ? [answer] : [];
  });
  const duplicate = operation.transitions.some(
    ({ when }) => transitionKey(when) === transitionKey(orderedAnswers),
  );
  return (
    <div className="flex flex-wrap items-center gap-2 px-2">
      {operation.questions.map((question) => {
        const selected = answers.find((answer) => answer.question === question.id)?.choice ?? "any";
        const items = [
          { value: "any", label: `Any ${question.text}` },
          ...question.choices.map(({ id, name }) => ({ value: id, label: name })),
        ];
        return (
          <Select
            key={question.id}
            items={items}
            value={selected}
            onValueChange={(value) => {
              const choice = question.choices.find(({ id }) => id === value);
              const remaining = answers.filter((answer) => answer.question !== question.id);
              setAnswers(choice ? [...remaining, { question: question.id, choice: choice.id }] : remaining);
            }}
          >
            <SelectTrigger size="sm" aria-label={`${question.text} Transition answer`}>
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
      })}
      <Button
        size="xs"
        variant="ghost"
        disabled={duplicate}
        onClick={() =>
          editOne(actions, workflow, {
            _tag: "AddTransition",
            operation: operation.id,
            when: orderedAnswers,
          })
        }
      >
        <RiAddLine data-icon="inline-start" /> Add Transition
      </Button>
    </div>
  );
}

function OperationHints({ operation }: { readonly operation: WorkflowOperation }) {
  const {
    state: { workflow },
    actions,
    meta: { catalog },
  } = useWorkflowEditor();
  const entryByKey = new Map(catalog?.entries.map((entry) => [entry.key, entry]) ?? []);
  const fields = [
    ...new Set(
      operation.transitions.flatMap(({ actions: transitionActions }) =>
        transitionActions.flatMap((action) => entryByKey.get(action.entry)?.agentInputs ?? []),
      ),
    ),
  ];
  if (fields.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 px-2">
      <span className="text-xs font-medium text-muted-foreground">Hints</span>
      {fields.map((field) => (
        <BufferedInput
          key={field}
          value={operation.hints.find((hint) => hint.field === field)?.text ?? ""}
          label={`${operation.name} ${field} hint`}
          placeholder={field}
          save={async (text) => {
            const updated = await editOne(actions, workflow, {
              _tag: "SetHint",
              operation: operation.id,
              field,
              text: text.trim() || null,
            });
            return (
              updated.workingCopy.operations
                .find(({ id }) => id === operation.id)
                ?.hints.find((hint) => hint.field === field)?.text ?? ""
            );
          }}
        />
      ))}
    </div>
  );
}

function OperationCard({ operation }: { readonly operation: WorkflowOperation }) {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-muted/50 p-2.5">
      <div className="flex items-center gap-2 px-1">
        <RiRobot2Line className="size-4 shrink-0 text-muted-foreground" />
        <BufferedInput
          value={operation.name}
          label="Operation name"
          className="h-7 flex-1 text-sm font-medium"
          save={async (name) => {
            if (!name.trim()) return operation.name;
            const updated = await editOne(actions, workflow, {
              _tag: "RenameOperation",
              operation: operation.id,
              name,
            });
            return updated.workingCopy.operations.find(({ id }) => id === operation.id)?.name ?? name;
          }}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${operation.name}`}
          onClick={() => editOne(actions, workflow, { _tag: "RemoveOperation", operation: operation.id })}
        >
          <RiCloseLine />
        </Button>
      </div>
      <OperationSettings operation={operation} />
      <OperationQuestions operation={operation} />
      <OperationHints operation={operation} />
      <Separator />
      {operation.transitions.map((transition, index) => (
        <Transition key={transitionKey(transition.when)} operation={operation} index={index} />
      ))}
      <AddTransition operation={operation} />
      <Diagnostics
        diagnostics={diagnosticsAt(workflow, {
          operation: operation.id,
          question: null,
          choice: null,
        })}
      />
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
          editOne(actions, workflow, { _tag: "AddOperation", operation: newWorkflowOperation() })
        }
      >
        <RiAddLine data-icon="inline-start" /> Add Operation
      </Button>
    </section>
  );
}

export function WorkflowEditor({ workflow: initial }: { readonly workflow: WorkflowRecord }) {
  const { state, actions } = useWorkflowSession();
  const remote = state.workflows.find(({ id }) => id === initial.id) ?? initial;
  const [preview, setPreview] = useState<WorkflowRecord | null>(null);
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
  const editorActions: WorkflowClient = {
    ...actions,
    edit: async (id, edits) => {
      const key = Symbol();
      pending.current = [...pending.current, { key, edits }];
      refreshPreview();
      const request = editQueue.current.then(() => actions.edit(id, edits));
      const settled = request.then(
        (next) => {
          accepted.current = next;
          pending.current = pending.current.filter((entry) => entry.key !== key);
          refreshPreview();
          return next;
        },
        (error) => {
          pending.current = pending.current.filter((entry) => entry.key !== key);
          refreshPreview();
          throw error;
        },
      );
      editQueue.current = settled.catch(() => accepted.current);
      return settled;
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
  return (
    <WorkflowEditorContext
      value={{
        state: { workflow },
        actions: editorActions,
        meta: { catalog: state.catalog, machine: state.machine },
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
