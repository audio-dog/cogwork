import {
  adviseReadiness,
  applyWorkflowEdits,
  NeedIdentity,
  RunPlanPolicyProfile,
  validateWorkflow,
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
import { submitWorkflowField, useWorkflowSession, type WorkflowClient } from "../features/workflow-session";
import { CatalogMenu } from "./workflow-catalog-menu";

interface WorkflowEditorValue {
  readonly state: { readonly workflow: WorkflowRecord };
  readonly actions: WorkflowClient;
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

function Diagnostics({ diagnostics }: { readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> }) {
  return diagnostics.map((diagnostic) => (
    <Alert key={`${diagnostic.code}:${diagnostic.location.field}`} data-diagnostic-class={diagnostic.class}>
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

interface BufferedTextValue {
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly blur: () => void;
}

const useBufferedText = (value: string, save: (text: string) => Promise<string>): BufferedTextValue => {
  const [text, setTextState] = useState(value);
  const server = useRef(value);
  const submitted = useRef(value);
  const generation = useRef(0);
  const dirty = useRef(false);
  if (server.current !== value && !dirty.current) {
    server.current = value;
    submitted.current = value;
    setTextState(value);
  }
  const submit = async (draft: string) => {
    const atGeneration = generation.current;
    try {
      const daemonValue = await submitWorkflowField(submitted, draft, save);
      if (daemonValue === null) return;
      server.current = daemonValue;
      submitted.current = daemonValue;
      if (atGeneration !== generation.current) return;
      dirty.current = false;
      setTextState(daemonValue);
    } catch {
      submitted.current = server.current;
    }
  };
  const submitAfterPause = useDebouncedCallback(submit, [save], 500);
  return {
    text,
    setText: (next) => {
      generation.current += 1;
      dirty.current = true;
      setTextState(next);
      submitAfterPause(next);
    },
    blur: () => submit(text),
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

const workspaceIds = (workflow: WorkflowRecord) =>
  workflow.workingCopy.workspaces._tag === "Listed" ? workflow.workingCopy.workspaces.workspaces : [];

function WorkspaceSelect() {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  const { state } = useWorkflowSession();
  const current = workflow.workingCopy.workspaces;
  const value = current._tag === "Every" ? "every" : (current.workspaces[0] ?? "none");
  const items = [
    { value: "none", label: "No workspace" },
    ...(state.machine?.workspaces.map(({ id }) => ({ value: id, label: id })) ?? []),
    { value: "every", label: "Every workspace" },
  ];
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (!next) return;
        const selected = state.machine?.workspaces.find(({ id }) => id === next)?.id;
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
  } = useWorkflowEditor();
  const trigger = workflow.workingCopy.triggers.find(({ id }) => id === triggerId);
  const [liveOptions, setLiveOptions] = useState<
    ReadonlyArray<{ readonly value: string; readonly label: string }>
  >([]);
  if (!trigger) return null;
  const fixedOptions = parameter.values.map((value) => ({ value, label: value }));
  const options = parameter.source === "fixed" ? fixedOptions : liveOptions;
  const selected = parameterValue(trigger.parameters, parameter.id);
  return (
    <Select
      items={options}
      value={selected}
      onOpenChange={async (open) => {
        if (!open || parameter.source !== "live") return;
        setLiveOptions(
          (await actions.listOptions(entry.key, parameter.id, workspaceIds(workflow))).map(
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
  } = useWorkflowEditor();
  const { state } = useWorkflowSession();
  const trigger = workflow.workingCopy.triggers.find(({ id }) => id === triggerId);
  const entry = state.catalog?.entries.find(({ key }) => key === trigger?.entry);
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
  } = useWorkflowEditor();
  const { state } = useWorkflowSession();
  const entries = state.catalog?.entries.filter(({ kind }) => kind === "trigger") ?? [];
  const start = workflow.workingCopy.operations[0]?.id;
  return (
    <section aria-label="Triggers" className="flex flex-col gap-1.5">
      {workflow.workingCopy.triggers.map((trigger) => (
        <TriggerRow key={trigger.id} triggerId={trigger.id} />
      ))}
      {state.machine && start ? (
        <CatalogMenu.Provider
          entries={entries}
          machine={state.machine}
          onChoose={(entry) =>
            editOne(actions, workflow, {
              _tag: "AddTrigger",
              trigger: {
                id: freshNodeId("trigger"),
                entry: entry.key,
                parameters: entry.parameters.map((parameter) => ({
                  id: parameter.id,
                  value: parameter.values[0] ?? "",
                })),
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

const blankOperation = (): WorkflowOperation => ({
  id: freshNodeId("operation"),
  name: "New Operation",
  instructionPackage: null,
  instruction: "",
  permissionProfile: "full",
  requires: [],
  model: { harness: null, model: null, options: [] },
  forEach: null,
  questions: [],
  transitions: [],
  hints: [],
});

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

export const orderedOperations = (workflow: WorkflowRecord) => {
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
  } = useWorkflowEditor();
  const { state } = useWorkflowSession();
  const models =
    state.catalog?.harnesses.flatMap((harness) =>
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
            ...(state.catalog?.instructionPackages.map((value) => ({ value, label: value })) ?? []),
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
              {state.catalog?.instructionPackages.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
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

function Transition({ operation, index }: { readonly operation: WorkflowOperation; readonly index: number }) {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  const { state } = useWorkflowSession();
  const transition = operation.transitions[index];
  if (!transition) return null;
  const entries = state.catalog?.entries.filter(({ kind }) => kind === "action") ?? [];
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
          <div key={`${action.entry}:${actionIndex}`} className="flex items-center gap-2 text-sm">
            <span>{entry?.name ?? action.entry}</span>
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
      {state.machine ? (
        <CatalogMenu.Provider
          entries={entries}
          machine={state.machine}
          onChoose={(entry) =>
            editOne(actions, workflow, {
              _tag: "SetTransitionActions",
              operation: operation.id,
              when: transition.when,
              actions: [
                ...transition.actions,
                {
                  entry: entry.key,
                  parameters: entry.parameters.map((parameter) => ({
                    id: parameter.id,
                    value: parameter.values[0] ?? "",
                  })),
                },
              ],
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
              <BufferedInput
                value={choice.name}
                label={`${question.text} ${choice.id}`}
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
              <Diagnostics
                diagnostics={diagnosticsAt(workflow, {
                  operation: operation.id,
                  question: question.id,
                  choice: choice.id,
                })}
              />
            </div>
          ))}
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

function OperationHints({ operation }: { readonly operation: WorkflowOperation }) {
  const {
    state: { workflow },
    actions,
  } = useWorkflowEditor();
  const { state } = useWorkflowSession();
  const entryByKey = new Map(state.catalog?.entries.map((entry) => [entry.key, entry]) ?? []);
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
      {operation.transitions.map((_, index) => (
        <Transition key={index} operation={operation} index={index} />
      ))}
      <Button
        size="xs"
        variant="ghost"
        className="self-start"
        onClick={() =>
          editOne(actions, workflow, {
            _tag: "AddTransition",
            operation: operation.id,
            when: operation.questions.flatMap((question) =>
              question.choices[0] ? [{ question: question.id, choice: question.choices[0].id }] : [],
            ),
          })
        }
      >
        <RiAddLine data-icon="inline-start" /> Add Transition
      </Button>
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
        onClick={() => editOne(actions, workflow, { _tag: "AddOperation", operation: blankOperation() })}
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
  const workflow = preview && preview.workingRevision > remote.workingRevision ? preview : remote;
  const current = useRef(workflow);
  current.current = workflow;
  const editorActions: WorkflowClient = {
    ...actions,
    edit: async (id, edits) => {
      const base = current.current;
      const pendingRevision = base.workingRevision + 1;
      const applied = applyWorkflowEdits(base.workingCopy, edits);
      if (applied._tag === "Ok" && state.catalog && state.machine) {
        const next = {
          ...base,
          workingCopy: applied.value,
          workingRevision: pendingRevision,
          diagnostics: validateWorkflow(applied.value, state.catalog),
          readiness: adviseReadiness(applied.value, state.catalog, state.machine),
        };
        current.current = next;
        setPreview(next);
      }
      try {
        const accepted = await actions.edit(id, edits);
        if (accepted.workingRevision >= current.current.workingRevision) {
          current.current = accepted;
          setPreview(accepted);
        }
        return accepted;
      } catch (error) {
        if (current.current.workingRevision <= pendingRevision) {
          current.current = remote;
          setPreview(remote);
        }
        throw error;
      }
    },
  };
  return (
    <WorkflowEditorContext value={{ state: { workflow }, actions: editorActions }}>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 py-8">
        <EditorHeader />
        <Triggers />
        <Operations />
      </div>
    </WorkflowEditorContext>
  );
}
