import {
  keyOf,
  matchWorkflowTransitions,
  ParkReason as ParkReasonSchema,
  type RunId,
  WorkflowActionArtifact,
  WorkflowActionTarget,
  type WorkflowAttention,
  type WorkflowCatalog,
  type WorkflowNotification,
  type WorkflowNotificationId,
  type WorkflowPark,
  type WorkflowRecord,
  type WorkItemRef,
  WorkItemRef as WorkItemRefSchema,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { type ReactNode, useState } from "react";
import { Attention, type AttentionLayout } from "../components/attention-board";
import type { CatalogIcon } from "./workflow-catalog";
import type {
  Artifact,
  NotificationRecord,
  ParkedItem,
  ParkReason,
  PlanStep,
  StepState,
} from "./workflow-parks";

interface ApproveInput {
  readonly item: WorkItemRef;
  readonly attempt: RunId;
  readonly digest: string;
  readonly edits: Readonly<Record<string, string>>;
}

interface AttemptInput {
  readonly item: WorkItemRef;
  readonly attempt: RunId;
}

export interface AttentionClient {
  readonly approve: (input: ApproveInput) => Promise<string>;
  readonly reject: (input: AttemptInput & { readonly note?: string }) => Promise<void>;
  readonly handBack: (input: { readonly item: WorkItemRef; readonly note?: string }) => Promise<void>;
  readonly chooseAnswer: (
    input: AttemptInput & {
      readonly answers: Readonly<Record<string, string>>;
      readonly inputs: Readonly<Record<string, string>>;
    },
  ) => Promise<void>;
  readonly dismiss: (input: { readonly id: WorkflowNotificationId }) => Promise<void>;
}

export interface AttentionSnapshot {
  readonly attention: WorkflowAttention;
  readonly notifications: ReadonlyArray<WorkflowNotification>;
  readonly workflows: ReadonlyArray<WorkflowRecord>;
  readonly catalog: WorkflowCatalog;
}

const catalogIcons: ReadonlyArray<CatalogIcon> = [
  "schedule",
  "github",
  "linear",
  "slack",
  "granola",
  "webhook",
  "cogwork",
  "operation",
];

const catalogIcon = (system: string | null) =>
  catalogIcons.find((candidate) => candidate === system) ?? "cogwork";

const source = (app: CatalogIcon, label: string) => ({ app, label });

const sourceOf = (item: WorkItemRef, issueApp: CatalogIcon = "cogwork") =>
  WorkItemRefSchema.match(item, {
    Issue: ({ id }) => source(issueApp, id),
    PullRequest: ({ number }) => source("github", `PR #${number}`),
    GranolaNote: ({ noteId }) => source("granola", noteId),
    SlackMessage: ({ channel }) => source("slack", channel),
    SlackConversation: ({ channel }) => source("slack", channel),
    ScheduleInstant: ({ instantMillis }) => source("schedule", String(instantMillis)),
    FanOutChild: ({ position }) => source("cogwork", `Finding ${position + 1}`),
  });

const workflowRef = (
  id: WorkflowPark["workflow"],
  revision: number,
  workflows: ReadonlyArray<WorkflowRecord>,
) => {
  const record = workflows.find((workflow) => workflow.id === id);
  return {
    id,
    name: record?.publishedCopy?.name ?? record?.workingCopy.name ?? id,
    revision,
  };
};

const operationOf = (park: WorkflowPark, workflows: ReadonlyArray<WorkflowRecord>) =>
  workflows
    .find(({ id }) => id === park.workflow)
    ?.publishedCopy?.operations.find(({ id }) => id === park.operation);

const titleCase = (value: string) =>
  value
    .split(/[_-]/)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

const targetLabel = (target: WorkflowActionTarget) =>
  WorkflowActionTarget.match(target, {
    Cogwork: () => "Cogwork",
    NoWorkspace: () => "No Workspace",
    SlackChannel: ({ channel }) => channel,
    SlackMessage: ({ channel, ts }) => `${channel} · ${ts}`,
    CurrentIssue: ({ issue }) => issue,
    ExistingIssue: ({ issue }) => issue,
    NewIssue: ({ workspace }) => workspace,
    NewPullRequest: ({ issue }) => issue,
    CurrentPullRequest: ({ item }) => sourceOf(item).label,
  });

const targetApp = (target: WorkflowActionTarget) =>
  WorkflowActionTarget.match<CatalogIcon | null>(target, {
    Cogwork: () => "cogwork",
    NoWorkspace: () => null,
    SlackChannel: () => "slack",
    SlackMessage: () => "slack",
    CurrentIssue: ({ app }) => catalogIcon(app),
    ExistingIssue: ({ app }) => catalogIcon(app),
    NewIssue: ({ app }) => catalogIcon(app),
    NewPullRequest: ({ app }) => catalogIcon(app),
    CurrentPullRequest: ({ app }) => catalogIcon(app),
  });

const stepStates = {
  pending: "planned",
  executing: "planned",
  completed: "done",
  failed: "failed",
} satisfies Record<"pending" | "executing" | "completed" | "failed", StepState>;

const planSteps = (park: WorkflowPark, catalog: WorkflowCatalog) => {
  const hiddenEntries = new Set(["cogwork.wait-for-approval", "cogwork.hand-to-me"]);
  return (park.plan?.steps ?? [])
    .filter(({ entry }) => !hiddenEntries.has(entry))
    .map((step) => {
      const entry = catalog.entries.find(({ key }) => key === step.entry);
      const failedReason = ParkReasonSchema.guards.WriteFailed(park.reason) ? park.reason.error : null;
      const issueArtifact = Schema.is(WorkflowActionArtifact)(step.artifact) ? step.artifact : null;
      return {
        id: `${step.position}:${step.entry}`,
        app: catalogIcon(entry?.system ?? null),
        action: entry?.name ?? titleCase(step.entry.slice(step.entry.indexOf(".") + 1)),
        target: targetLabel(step.target),
        parameters: step.parameters.map(({ value }) => value),
        inputs: Object.entries(step.inputs).map(([id, text]) => ({
          id,
          label: titleCase(id),
          text,
        })),
        state: stepStates[step.status],
        note: step.status === "failed" ? failedReason : (issueArtifact?.issue ?? null),
      } satisfies PlanStep;
    });
};

const answerSets = (park: WorkflowPark, workflows: ReadonlyArray<WorkflowRecord>) => {
  const questions = operationOf(park, workflows)?.questions ?? [];
  return questions.reduce<ReadonlyArray<{ answers: Readonly<Record<string, string>>; labels: string[] }>>(
    (sets, question) =>
      sets.flatMap((set) =>
        question.choices.map((choice) => ({
          answers: { ...set.answers, [question.id]: choice.id },
          labels: [...set.labels, choice.name],
        })),
      ),
    [{ answers: {}, labels: [] }],
  );
};

const choicesFor = (
  park: WorkflowPark,
  workflows: ReadonlyArray<WorkflowRecord>,
  catalog: WorkflowCatalog,
) => {
  const operation = operationOf(park, workflows);
  if (!operation) return [];
  return answerSets(park, workflows).map(({ answers, labels }) => {
    const entries = new Set(
      matchWorkflowTransitions(operation, answers).flatMap(({ actions }) =>
        actions.map(({ entry }) => entry),
      ),
    );
    const requiredInputs = catalog.entries
      .filter(({ key }) => entries.has(key))
      .flatMap(({ agentInputs }) => agentInputs);
    const inputs = [...new Set(requiredInputs)]
      .filter((id) => !park.plan?.inputs[id]?.trim())
      .map((id) => ({
        id,
        label: operation.hints.find(({ field }) => field === id)?.text ?? titleCase(id),
      }));
    return {
      id: Object.values(answers).join(":"),
      label: labels.join(" · "),
      answers,
      inputs,
    };
  });
};

const reasonOf = (park: WorkflowPark, workflows: ReadonlyArray<WorkflowRecord>, catalog: WorkflowCatalog) =>
  ParkReasonSchema.match<ParkReason>(park.reason, {
    Stuck: ({ summary }) => ({ tag: "stuck", summary }) as const,
    Exhausted: ({ reason }) => ({ tag: "exhausted", failure: reason }) as const,
    HopCap: () => ({ tag: "hop-cap" }) as const,
    MissingOperation: () => ({ tag: "missing-operation" }) as const,
    PlanRejected: ({ reason }) => ({ tag: "plan-rejected", reason }) as const,
    WriteFailed: ({ step, error }) => ({ tag: "write-failed", step, error }) as const,
    DraftOutcomeUnknown: ({ step }) => ({ tag: "draft-outcome-unknown", step }) as const,
    NoWorkspaceRecognized: () => ({ tag: "no-workspace-recognized" }) as const,
    AwaitingApproval: ({ digest, revision }) =>
      ({ tag: "awaiting-approval", digest, builtOn: revision }) as const,
    HandedToYou: () =>
      ({
        tag: "handed-to-you",
        question:
          operationOf(park, workflows)
            ?.questions.map(({ text }) => text)
            .join(" · ") ?? "Choose an answer",
        choices: choicesFor(park, workflows, catalog),
      }) as const,
  });

const parkedItem = (
  park: WorkflowPark,
  workflows: ReadonlyArray<WorkflowRecord>,
  catalog: WorkflowCatalog,
) => {
  const issueApp = park.plan?.steps.map(({ target }) => targetApp(target)).find((app) => app !== null);
  const source = sourceOf(park.item, issueApp ?? "cogwork");
  const workflow = workflowRef(park.workflow, park.publishedRevision, workflows);
  const parent = park.lineage.parent
    ? [{ app: "operation" as const, label: park.lineage.parent, workflow: workflow.name }]
    : [];
  return {
    id: keyOf(park.item),
    ref: park.item,
    attempt: park.attempt,
    title: source.label,
    source,
    workflow,
    operation: operationOf(park, workflows)?.name ?? park.operation,
    lineage: [{ ...source, workflow: null }, ...parent],
    summary: park.summary,
    changedSinceParked: park.changedSinceParked,
    parkedAtMillis: park.parkedAtMillis,
    reason: reasonOf(park, workflows, catalog),
    plan: planSteps(park, catalog),
    commands: park.commands,
  } satisfies ParkedItem;
};

const artifactRecord = (artifact: WorkflowActionArtifact) => {
  const isLinearArtifact = artifact.url.includes("linear.app");
  return {
    app: isLinearArtifact ? "linear" : "github",
    label: artifact.issue,
    url: artifact.url,
  } satisfies Artifact;
};

const notificationRecord = (notification: WorkflowNotification, workflows: ReadonlyArray<WorkflowRecord>) => {
  const source = sourceOf(notification.item);
  const workflow = workflows.find(({ id }) => id === notification.workflow);
  return {
    id: notification.id,
    item: notification.item,
    title: source.label,
    source,
    workflow: workflowRef(notification.workflow, workflow?.publishedRevision ?? 0, workflows),
    operation:
      workflow?.publishedCopy?.operations.find(({ id }) => id === notification.operation)?.name ??
      notification.operation,
    summary: notification.summary,
    answers: Object.entries(notification.answers).map(([question, choice]) => ({ question, choice })),
    artifacts: notification.artifacts.map(artifactRecord),
    atMillis: notification.atMillis,
  } satisfies NotificationRecord;
};

const skippedRecords = (attention: WorkflowAttention, workflows: ReadonlyArray<WorkflowRecord>) =>
  attention.skipped.flatMap((group) => {
    const workflow = workflows.find(({ id }) => id === group.workflow);
    const ref = workflowRef(group.workflow, workflow?.publishedRevision ?? 0, workflows);
    return [
      ...group.steps.map((record, index) => ({
        id: `${group.workflow}:step:${index}`,
        workflow: ref,
        kind: "step" as const,
        app: "cogwork" as const,
        what: record.summary,
        reason: record.reason,
        atMillis: record.atMillis,
      })),
      ...group.events.map((record, index) => ({
        id: `${group.workflow}:event:${index}`,
        workflow: ref,
        kind: "event" as const,
        app: "cogwork" as const,
        what: record.summary,
        reason: record.reason,
        atMillis: record.atMillis,
      })),
    ];
  });

const failureMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const noteField = (note: string) => (note.trim() ? { note } : {});

export function AttentionClientProvider({
  snapshot,
  client,
  layout,
  focus,
  onFocusChange,
  onLayoutChange,
  onOpenItem,
  onRefresh,
  children,
}: {
  readonly snapshot: AttentionSnapshot;
  readonly client: AttentionClient;
  readonly layout: AttentionLayout;
  readonly focus: string | null;
  readonly onFocusChange: (id: string | null) => void;
  readonly onLayoutChange: (layout: AttentionLayout) => void;
  readonly onOpenItem: (item: WorkItemRef) => void;
  readonly onRefresh: () => void;
  readonly children: ReactNode;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const execute = async (request: () => Promise<unknown>) => {
    try {
      await request();
      setFailure(null);
      onRefresh();
      return true;
    } catch (error) {
      setFailure(failureMessage(error));
      return false;
    }
  };
  const currentAttempt = (item: ParkedItem) => {
    if (item.attempt) return item.attempt;
    setFailure("This parked item has no current attempt");
    return null;
  };
  const parked = snapshot.attention.parks.map((park) =>
    parkedItem(park, snapshot.workflows, snapshot.catalog),
  );
  const notifications = snapshot.notifications.map((notification) =>
    notificationRecord(notification, snapshot.workflows),
  );
  return (
    <Attention.Provider
      state={{
        parked,
        notifications,
        skipped: skippedRecords(snapshot.attention, snapshot.workflows),
        layout,
        focus,
        failure,
      }}
      actions={{
        approve: ({ item, digest, edits }) => {
          const attempt = currentAttempt(item);
          return attempt
            ? execute(() => client.approve({ item: item.ref, attempt, digest, edits }))
            : Promise.resolve(false);
        },
        reject: ({ item, note }) => {
          const attempt = currentAttempt(item);
          return attempt
            ? execute(() => client.reject({ item: item.ref, attempt, ...noteField(note) }))
            : Promise.resolve(false);
        },
        handBack: ({ item, note }) => execute(() => client.handBack({ item: item.ref, ...noteField(note) })),
        chooseAnswer: ({ item, choice, inputs }) => {
          const attempt = currentAttempt(item);
          return attempt
            ? execute(() => client.chooseAnswer({ item: item.ref, attempt, answers: choice.answers, inputs }))
            : Promise.resolve(false);
        },
        dismiss: (notification) => execute(() => client.dismiss({ id: notification.id })),
        openItem: onOpenItem,
        setFocus: onFocusChange,
        setLayout: onLayoutChange,
      }}
      meta={{}}
    >
      {children}
    </Attention.Provider>
  );
}
