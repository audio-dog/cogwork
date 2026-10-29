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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { ContextAssembler } from "./context-assembler";
import { Coordination } from "./coordination";
import { CredentialStore } from "./credential-store";
import { Harness, type HarnessRunnerEnv } from "./harness";
import { defaultRunBudget } from "./provider-runner";
import { RunLedger } from "./run-ledger";
import { RunRecorder } from "./run-recorder";
import { SessionStore } from "./session-store";
import { type TriggerAdmission, TriggerObservationStore } from "./trigger-observation";
import { Workflows } from "./workflow";
import { WorkflowNotifications } from "./workflow-notification";

const runId = Schema.decodeSync(RunId);
const workspaceId = Schema.decodeSync(WorkspaceId);
const workItemId = Schema.decodeSync(WorkItemId);
const failedTerminal: AgUiEvent = { type: "RUN_FINISHED", finishReason: "failed" };

const operationKeyOf = (admission: TriggerAdmission, operation: string) => ({
  workflow: admission.subscription.workflow,
  operation,
});

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
  const contextAssembler = yield* ContextAssembler;
  const notifications = yield* WorkflowNotifications;
  const observationStore = yield* TriggerObservationStore;
  const executionContext = yield* Effect.context<HarnessRunnerEnv>().pipe(
    Effect.map(
      Context.pick(
        SessionStore,
        ContextAssembler,
        CredentialStore,
        FileSystem.FileSystem,
        Path.Path,
        HttpClient.HttpClient,
      ),
    ),
  );
  const decodeIssues = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  const settle = (record: RunRecord, status: RunRecord["status"]) =>
    Effect.flatMap(Clock.currentTimeMillis, (endedAtMillis) =>
      ledger.updateRun(record.id, { status, usage: null, endedAtMillis }),
    );

  const complete = Effect.fn("WorkflowRun.complete")(function* (admission: TriggerAdmission) {
    const isLast = yield* observationStore.complete(admission);
    if (!isLast) return;
    yield* coordination.markProcessed(admission.event.key, admission.event.revision);
  });

  const decline = (admission: TriggerAdmission) =>
    coordination
      .park(admission.event.key, { _tag: "MissingOperation" })
      .pipe(Effect.andThen(complete(admission)));

  const executeRaw = Effect.fn("WorkflowRun.execute")(function* (admission: TriggerAdmission) {
    const record = yield* workflows.get({ id: admission.subscription.workflow });
    const document = record.publishedCopy;
    const trigger = document?.triggers.find(({ id }) => id === admission.subscription.trigger);
    const operation = document?.operations.find(({ id }) => id === admission.subscription.operation);
    if (!record.enabled || document === null || trigger === undefined || operation === undefined) {
      yield* complete(admission);
      return;
    }

    const catalogResult = yield* workflows.catalog;
    const selectedHarness = operation.model.harness ?? catalogResult.machine.defaultHarness;
    const hasMissingNeed = operation.requires.some(
      (need) => !catalogResult.machine.readyNeeds.includes(need),
    );
    if (selectedHarness === null || hasMissingNeed) return yield* decline(admission);
    const options = Object.fromEntries(operation.model.options.map(({ id, value }) => [id, value]));
    const preflight = yield* Effect.result(
      harness.preflight(selectedHarness, operation.permissionProfile, operation.model.model, options),
    );
    if (Result.isFailure(preflight)) return yield* decline(admission);

    const key = operationKeyOf(admission, operation.id);
    const claim = yield* Effect.acquireRelease(
      coordination.claim(admission.event.key, { operation: key, lineage: admission.lineage }),
      (activeClaim) =>
        coordination
          .release(admission.event.key, activeClaim)
          .pipe(Effect.catch((error) => Effect.logError("Workflow Claim release failed", { error }))),
    );
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const id = runId(randomUUID());
    const workspace = workspaceId(admission.subscription.workflow);
    const item = workItemId(keyOf(admission.event.key));
    const session = yield* sessions.mint(
      { workspace, harness: selectedHarness, createdAtMillis: startedAtMillis },
      harness.sessionKind,
    );
    const priorIssues = (yield* Ref.get(decodeIssues)).get(keyOf(admission.event.key)) ?? null;
    const assembled = yield* contextAssembler.assemble({
      runId: id,
      workspace,
      cwd: "/",
      projectRoot: "/",
      operatingInstructions: operation,
      contributions: [],
    });
    yield* Effect.addFinalizer(() => contextAssembler.cleanup(id).pipe(Effect.ignore));
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
        options,
        profile: operation.permissionProfile,
      },
      instructions: assembled.layers,
      operatingInstructions: {
        name: assembled.operatingInstructionsName,
        path: assembled.operatingInstructionsPath,
        resources: [
          ...assembled.operatingInstructionResources,
          ...(priorIssues === null ? [] : [{ source: "previous-result-issues", content: priorIssues }]),
        ],
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
        prose: admission.event.workContext ?? {
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
      Stream.filter(agUiIsStructuredOutputComplete),
      Stream.runLast,
      Effect.timeout(defaultRunBudget(operation.permissionProfile)),
      Effect.exit,
    );
    if (Exit.isFailure(eventsExit)) {
      const reason = String(eventsExit.cause);
      yield* recorder.record(run, failedTerminal);
      const view = yield* coordination.recordAttempt(admission.event.key, {
        operation: key,
        outcome: "failed",
        lineage: admission.lineage,
        reason,
      });
      const exhausted = view.counters(key).exhausted;
      yield* settle(run, exhausted ? "exhausted" : "failed");
      if (exhausted) {
        yield* coordination.park(admission.event.key, { _tag: "Exhausted", reason });
        yield* complete(admission);
      }
      return;
    }

    const output = Option.getOrUndefined(eventsExit.value);
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
        yield* complete(admission);
      }
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
      yield* complete(admission);
      yield* settle(run, "failed");
      return;
    }

    const actions = matchWorkflowTransitions(operation, decoded.value.answers).flatMap(
      ({ actions }) => actions,
    );
    if (actions.some(({ entry }) => entry === "cogwork.notify")) {
      yield* notifications.write(run, {
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
    yield* complete(admission);
    yield* settle(run, "succeeded");
  });

  return {
    execute: (admission: TriggerAdmission) =>
      executeRaw(admission).pipe(Effect.provide(executionContext), Effect.scoped, Effect.asVoid),
  } as const;
});

export const WorkflowRun = Context.Reference<Effect.Success<typeof make>>(
  "@cogwork/engine/workflow-run/WorkflowRun",
  {
    defaultValue: () => ({ execute: () => Effect.void }),
  },
);

export const layer = Layer.effect(WorkflowRun, make);
