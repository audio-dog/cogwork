import { randomUUID } from "node:crypto";
import {
  type AgUiEvent,
  agUiIsStructuredOutputComplete,
  keyOf,
  matchWorkflowTransitions,
  RunId,
  RunPlan,
  type RunRecord,
  WorkItemId,
  WorkspaceId,
  workflowOperationResultJsonSchema,
  workflowOperationResultSchema,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Coordination } from "./coordination";
import { Harness, type HarnessRunnerEnv } from "./harness";
import { RunLedger } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { SessionStore } from "./session-store";
import type { TriggerAdmission } from "./trigger-observation";
import { Workflows } from "./workflow";
import { WorkflowNotifications } from "./workflow-notification";

const runId = Schema.decodeSync(RunId);
const workspaceId = Schema.decodeSync(WorkspaceId);
const workItemId = Schema.decodeSync(WorkItemId);

const operationKeyOf = (admission: TriggerAdmission, operation: string) => ({
  workflow: admission.subscription.workflow,
  operation,
});

const resultEvent = (events: ReadonlyArray<AgUiEvent>) => events.findLast(agUiIsStructuredOutputComplete);

const operationResources = (
  instruction: string,
  questions: unknown,
  hints: unknown,
  decodeIssues: string | null,
) => [
  { source: "framing", content: "Complete this Workflow Operation and return only the required result." },
  { source: "instruction", content: instruction.trim() || "Complete the named Workflow Operation." },
  { source: "questions", content: JSON.stringify(questions) },
  { source: "hints", content: JSON.stringify(hints) },
  ...(decodeIssues === null ? [] : [{ source: "previous-result-issues", content: decodeIssues }]),
];

const projection = [
  "Harness Adapter",
  "Instructions",
  "Messages",
  "Work Context",
  "Middleware",
  "Sandbox",
  "Structured Output",
  "Persistence",
  "Provenance",
].map((member) => ({ member, disposition: "projected" as const }));

export const make = Effect.gen(function* () {
  const workflows = yield* Workflows;
  const coordination = yield* Coordination;
  const harness = yield* Harness;
  const sessions = yield* SessionStore;
  const ledger = yield* RunLedger;
  const recorder = yield* RunRecorder;
  const notifications = yield* WorkflowNotifications;
  const executionContext = yield* Effect.context<HarnessRunnerEnv>();
  const decodeIssues = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  const settle = (record: RunRecord, status: RunRecord["status"]) =>
    Effect.flatMap(Clock.currentTimeMillis, (endedAtMillis) =>
      ledger.updateRun(record.id, { status, usage: null, endedAtMillis }),
    );

  const executeRaw = Effect.fn("WorkflowRun.execute")(function* (admission: TriggerAdmission) {
    const record = yield* workflows.get({ id: admission.subscription.workflow });
    const document = record.publishedCopy;
    const trigger = document?.triggers.find(({ id }) => id === admission.subscription.trigger);
    const operation = document?.operations.find(({ id }) => id === trigger?.start);
    if (!record.enabled || document === null || trigger === undefined || operation === undefined) {
      yield* coordination.markProcessed(admission.event.key, admission.event.revision);
      return;
    }

    const catalogResult = yield* workflows.catalog;
    const selectedHarness = operation.model.harness ?? catalogResult.machine.defaultHarness;
    if (selectedHarness === null) return yield* Effect.die("Workflow Operation has no Harness");

    const key = operationKeyOf(admission, operation.id);
    const claim = yield* coordination.claim(admission.event.key, {
      operation: key,
      lineage: admission.lineage,
    });
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const id = runId(randomUUID());
    const workspace = workspaceId(admission.subscription.workflow);
    const item = workItemId(keyOf(admission.event.key));
    const session = yield* sessions.mint(
      { workspace, harness: selectedHarness, createdAtMillis: startedAtMillis },
      harness.sessionKind,
    );
    const priorIssues = (yield* Ref.get(decodeIssues)).get(keyOf(admission.event.key)) ?? null;
    const observation = {
      generation: record.publishedRevision ?? 0,
      observedAtMillis: admission.event.atMillis,
    };
    const plan = RunPlan.make({
      id,
      operation: "implement",
      harness: {
        name: selectedHarness,
        model: operation.model.model,
        options: Object.fromEntries(operation.model.options.map(({ id, value }) => [id, value])),
        profile: operation.permissionProfile,
      },
      instructions: [],
      operatingInstructions: {
        name: operation.name,
        path: `workflow/${record.id}/${operation.id}`,
        resources: operationResources(
          operation.instruction,
          operation.questions,
          operation.hints,
          priorIssues,
        ),
      },
      messages: [{ role: "user", content: `Run Workflow Operation: ${operation.name}` }],
      tools: [],
      skills: [],
      mcp: [],
      subagents: [],
      commands: [],
      hooks: [],
      middleware: [...harness.planMiddleware(selectedHarness)],
      structuredOutput: workflowOperationResultJsonSchema(operation, catalogResult.catalog)[
        "~standard"
      ].jsonSchema.input({ target: "draft-2020-12" }),
      connections: [],
      workContext: {
        reference: { workItem: item, url: null },
        facts: { roles: [], assignees: [], openBlockers: 0, claim, priority: "medium", pr: null },
        prose: {
          body: `Scheduled instant ${admission.event.revision} for Workflow ${record.id}.`,
          comments: [],
        },
        observation,
      },
      sandbox: { workspace: null, policy: operation.permissionProfile },
      persistence: { sessionKind: harness.sessionKind(selectedHarness) },
      provenance: {
        resolution: [],
        stamps: [],
        projectedNames: [],
        projection,
        observation,
      },
    });
    const run: RunRecord = {
      id,
      workspace,
      workItem: item,
      stage: "implement",
      harness: selectedHarness,
      branch: null,
      session,
      usage: null,
      status: "running",
      startedAtMillis,
      endedAtMillis: null,
    };
    yield* ledger.acceptRun(run, plan);

    const eventsExit = yield* harness.run({ plan, session, mcpCredentials: new Map() }).pipe(
      Stream.tap((event) => recorder.record(run, event)),
      Stream.runCollect,
      Effect.exit,
    );
    if (Exit.isFailure(eventsExit)) {
      yield* coordination.recordAttempt(admission.event.key, {
        operation: key,
        outcome: "failed",
        lineage: admission.lineage,
        reason: String(eventsExit.cause),
      });
      yield* settle(run, "failed");
      yield* coordination.release(admission.event.key, claim);
      return;
    }

    const output = resultEvent(eventsExit.value);
    const decoded = Schema.decodeUnknownExit(workflowOperationResultSchema(operation, catalogResult.catalog))(
      output?.value.object,
    );
    if (Exit.isFailure(decoded)) {
      const issues = String(decoded.cause);
      yield* Ref.update(decodeIssues, (current) => new Map(current).set(keyOf(admission.event.key), issues));
      const view = yield* coordination.recordAttempt(admission.event.key, {
        operation: key,
        outcome: "failed",
        lineage: admission.lineage,
        reason: issues,
      });
      const exhausted = view.counters(key).exhausted;
      yield* settle(run, exhausted ? "exhausted" : "failed");
      if (exhausted) {
        yield* coordination.park(admission.event.key, { _tag: "Exhausted", reason: issues });
        yield* coordination.markProcessed(admission.event.key, admission.event.revision);
      }
      yield* coordination.release(admission.event.key, claim);
      return;
    }

    yield* Ref.update(decodeIssues, (current) => {
      const next = new Map(current);
      next.delete(keyOf(admission.event.key));
      return next;
    });
    if (decoded.value.stuck) {
      yield* coordination.recordAttempt(admission.event.key, {
        operation: key,
        outcome: "failed",
        lineage: admission.lineage,
        reason: decoded.value.summary,
      });
      yield* coordination.park(admission.event.key, { _tag: "Stuck", summary: decoded.value.summary });
      yield* coordination.markProcessed(admission.event.key, admission.event.revision);
      yield* settle(run, "failed");
      yield* coordination.release(admission.event.key, claim);
      return;
    }

    const actions = matchWorkflowTransitions(operation, decoded.value.answers).flatMap(
      ({ actions }) => actions,
    );
    if (actions.some(({ entry }) => entry === "cogwork.notify")) {
      yield* notifications.write({
        id: `${record.id}:${operation.id}:${admission.event.revision}`,
        workflow: record.id,
        operation: operation.id,
        summary: decoded.value.summary,
        answers: decoded.value.answers,
        atMillis: yield* Clock.currentTimeMillis,
      });
    }
    yield* coordination.recordAttempt(admission.event.key, {
      operation: key,
      outcome: "succeeded",
      lineage: admission.lineage,
    });
    yield* coordination.markProcessed(admission.event.key, admission.event.revision);
    yield* settle(run, "succeeded");
    yield* coordination.release(admission.event.key, claim);
  });

  return {
    execute: (admission: TriggerAdmission) =>
      executeRaw(admission).pipe(Effect.provide(executionContext), Effect.asVoid),
  } as const;
});

export const WorkflowRun = Context.Reference<Effect.Success<typeof make>>(
  "@cogwork/engine/workflow-run/WorkflowRun",
  {
    defaultValue: () => ({ execute: () => Effect.void }),
  },
);

export const layer = Layer.effect(WorkflowRun, make);
