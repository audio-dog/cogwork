import {
  BranchName,
  HarnessName,
  type OperationSettingRow,
  RunId,
  type RunPlanObservation,
  type RunPlanPolicyProfile,
  type RunRecord,
  type Session,
  SessionId,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import type { AdmittedWork } from "./classify";
import type * as OperationResolution from "./operation-resolution";
import type { RegisteredWorkspace } from "./projector";
import * as RunLedger from "./run-ledger";
import { resolveRunPlanStage } from "./run-plan";
import * as RunPreparation from "./run-preparation";
import { engineTestLayerWithOperationResolution } from "./testing/engine-test-layer";
import {
  branchName,
  PullRequestReadiness,
  WorktreeError,
  WorktreeManager,
  type WorktreeManagerService,
} from "./worktree";

const cursor = Schema.decodeSync(HarnessName)("cursor");
const codex = Schema.decodeSync(HarnessName)("codex");
const replay = Schema.decodeSync(HarnessName)("replay");
const itemId = Schema.decodeSync(WorkItemId);
const sessionId = Schema.decodeSync(SessionId);
const runId = Schema.decodeSync(RunId);
const externalBranch = Schema.decodeSync(BranchName)("review/external-branch");
const observation = {
  generation: 7,
  observedAtMillis: 1_000,
} satisfies RunPlanObservation;

const workspace: RegisteredWorkspace = {
  source: "control-store:workspace",
  repository: "colonylabs/cogwork",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "workspace",
    checkoutPath: "/repo",
    issueTracker: { type: "github", connectionId: "github/default" },
  }),
};

const workContext = (id: WorkItemId) =>
  ({
    reference: { workItem: id, url: null },
    prose: { body: "", comments: [] },
    facts: {
      roles: [],
      assignees: [],
      openBlockers: 0,
      claim: null,
      priority: "medium",
      pr: null,
    },
  }) satisfies AdmittedWork["workContext"];

const implementItem = (number: number) => {
  const id = itemId(`#${number}`);
  return {
    id,
    title: `Implement ${number}`,
    stage: "implement",
    priority: "medium",
    priorFailures: 0,
    workContext: workContext(id),
  } satisfies AdmittedWork;
};

const followUpItem = (number: number, fresh = false) => {
  const id = itemId(`#${number}`);
  return {
    id,
    title: `Follow up ${number}`,
    stage: "follow-up",
    priority: "medium",
    priorFailures: 0,
    workContext: workContext(id),
    followUp: {
      checks: "failing",
      humanCommentAtMillis: 0,
      botTriggerAtMillis: 0,
      noProgress: 0,
      stalled: false,
      fresh,
      baseDivergence: "none",
    },
  } satisfies AdmittedWork;
};

const triageItem = (number: number) => {
  const id = itemId(`#${number}`);
  return {
    id,
    title: `Triage ${number}`,
    stage: "triage",
    priority: "medium",
    priorFailures: 0,
    workContext: workContext(id),
  } satisfies AdmittedWork;
};

const operationSettingsFor = (harness: HarnessName, profile?: RunPlanPolicyProfile) => {
  const profileSettings = profile
    ? ([
        {
          setting: "permission-profile",
          level: { _tag: "Default" },
          scope: { _tag: "SettingsProfile" },
          value: profile,
        },
      ] satisfies ReadonlyArray<OperationSettingRow>)
    : [];
  return [
    {
      setting: "enabled",
      level: { _tag: "Default" },
      scope: { _tag: "SettingsProfile" },
      value: true,
    },
    {
      setting: "harness",
      level: { _tag: "Default" },
      scope: { _tag: "SettingsProfile" },
      value: harness,
    },
    ...profileSettings,
  ] satisfies ReadonlyArray<OperationSettingRow>;
};

const operationFor = (item: AdmittedWork, harness: HarnessName = cursor, profile?: RunPlanPolicyProfile) => {
  const operation = resolveRunPlanStage(workspace.config, item.stage, operationSettingsFor(harness, profile));
  if (!operation) return assert.fail(`expected ${item.stage} operation`);
  return operation;
};

interface WorktreeCall {
  readonly item: string;
  readonly options: Parameters<WorktreeManagerService["ensure"]>[2];
}

class WorktreeCalls extends Context.Service<WorktreeCalls, Ref.Ref<ReadonlyArray<WorktreeCall>>>()(
  "@cogwork/engine/run-preparation.test/WorktreeCalls",
) {
  static readonly layer = Layer.effect(WorktreeCalls, Ref.make<ReadonlyArray<WorktreeCall>>([]));
}

interface WorktreeDoubleConfig {
  readonly created?: boolean;
  readonly failure?: WorktreeError;
}

const worktreeLayer = ({
  created = false,
  failure,
}: WorktreeDoubleConfig = {}): Layer.Layer<WorktreeManager | WorktreeCalls> =>
  Layer.effect(
    WorktreeManager,
    Effect.map(
      WorktreeCalls,
      (calls): WorktreeManagerService => ({
        withRunOwnershipLock: (effect) => effect,
        tryWithMaintenanceLock: Effect.asSome,
        ensure: (_workspace, item, options) =>
          Ref.update(calls, (current) => [...current, { item: item.id, options }]).pipe(
            Effect.andThen(
              failure
                ? Effect.fail(failure)
                : Effect.succeed({
                    branch: options?.branch ?? branchName(item),
                    path: `/worktrees/${options?.branch ?? branchName(item)}`,
                    created,
                  }),
            ),
          ),
        pullRequestReadiness: (_workspace, item) =>
          Effect.succeed(PullRequestReadiness.Ready({ headBranch: branchName(item), baseBranch: "main" })),
        list: () => Effect.succeed([]),
        remove: () => Effect.void,
        reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
      }),
    ),
  ).pipe(Layer.provideMerge(WorktreeCalls.layer));

const testLayer = (
  harness: HarnessName = cursor,
  worktree: WorktreeDoubleConfig = {},
  profile?: RunPlanPolicyProfile,
): Layer.Layer<
  OperationResolution.OperationResolution | RunLedger.RunLedger | WorktreeManager | WorktreeCalls
> => {
  const engineServices = engineTestLayerWithOperationResolution({
    harness,
    operationSettings: operationSettingsFor(harness, profile),
  });
  return Layer.merge(engineServices, worktreeLayer(worktree));
};

const session = (id: string, harness: HarnessName = cursor) =>
  ({
    kind: "opaque-handle",
    id: sessionId(id),
    workspace: workspace.config.name,
    harness,
    createdAtMillis: 1_000,
    handle: id,
  }) satisfies Session;

const record = (
  id: string,
  item: AdmittedWork,
  stored: Session,
  startedAtMillis: number,
  branch: BranchName = branchName(item),
) =>
  ({
    id: runId(id),
    workspace: workspace.config.name,
    workItem: item.id,
    stage: item.stage,
    harness: stored.harness,
    branch,
    session: stored.id,
    usage: null,
    status: "succeeded",
    startedAtMillis,
    endedAtMillis: startedAtMillis + 1,
  }) satisfies RunRecord;

const seedBranchSession = (
  item: AdmittedWork,
  stored: Session,
  startedAtMillis = 1_000,
  branch: BranchName = branchName(item),
) =>
  Effect.gen(function* () {
    const ledger = yield* RunLedger.RunLedger;
    yield* ledger.insertSession(stored);
    yield* ledger.insertRun(
      record(`run-${item.id}-${startedAtMillis}`, item, stored, startedAtMillis, branch),
    );
  });

const resume = (item: AdmittedWork, stored: Session) =>
  ({
    ...item,
    resume: { session: stored.id, reason: "interrupted" },
  }) satisfies AdmittedWork;

const prepare = Effect.fn("RunPreparationTest.prepare")(function* (
  item: AdmittedWork,
  harness: HarnessName = cursor,
  profile?: RunPlanPolicyProfile,
) {
  yield* TestClock.setTime(20_000);
  const preparation = yield* RunPreparation.make;
  return yield* preparation.prepare({
    runId: runId(`prepared-${item.id}`),
    workspace,
    item,
    operation: operationFor(item, harness, profile),
    startedAtMillis: 20_000,
    observation,
  });
});

const divergedWorktree = new WorktreeError({
  reason: "diverged",
  remote: "origin",
  branch: branchName(implementItem(111)),
  message: "branch diverged",
  retryable: false,
});

describe("RunPreparation.prepare", () => {
  it.layer(testLayer())((it) => {
    it.effect("resumes the branch's persisted Session", () => {
      const item = implementItem(101);
      const stored = session("session-branch");
      return Effect.gen(function* () {
        yield* seedBranchSession(item, stored);
        const prepared = yield* prepare(item);
        assert.strictEqual(prepared.session, stored.id);
      });
    });
  });

  it.layer(testLayer())((it) => {
    it.effect("starts fresh when recovery points at a stale branch Session", () => {
      const item = implementItem(102);
      const stale = session("session-stale");
      const latest = session("session-latest");
      return Effect.gen(function* () {
        yield* seedBranchSession(item, stale, 1_000);
        yield* seedBranchSession(item, latest, 2_000);
        const prepared = yield* prepare(resume(item, stale));
        const prompt = prepared.plan.messages[0]?.content ?? "";
        assert.notStrictEqual(prepared.session, stale.id);
        assert.notStrictEqual(prepared.session, latest.id);
        assert.include(prompt, item.title);
        assert.notInclude(prompt, "You were interrupted part-way through");
      });
    });
  });

  it.layer(testLayer())((it) => {
    it.effect("starts fresh after a Harness switch", () => {
      const item = implementItem(103);
      const stored = session("session-codex", codex);
      return Effect.gen(function* () {
        yield* seedBranchSession(item, stored);
        const prepared = yield* prepare(item);
        assert.notStrictEqual(prepared.session, stored.id);
      });
    });
  });

  it.layer(testLayer())((it) => {
    it.effect("does not resurrect an older Session after a Harness switches back", () => {
      const item = implementItem(110);
      const older = session("session-old-cursor");
      const latest = session("session-latest-codex", codex);
      return Effect.gen(function* () {
        yield* seedBranchSession(item, older, 1_000);
        yield* seedBranchSession(item, latest, 2_000);
        const prepared = yield* prepare(item);
        assert.notStrictEqual(prepared.session, older.id);
        assert.notStrictEqual(prepared.session, latest.id);
      });
    });
  });

  it.layer(testLayer(cursor, { created: true }))((it) => {
    it.effect("starts a fresh Session when recovery recreates the Sandbox lineage", () => {
      const item = implementItem(104);
      const stored = session("session-lineage");
      return Effect.gen(function* () {
        yield* seedBranchSession(item, stored);
        const prepared = yield* prepare(resume(item, stored));
        const prompt = prepared.plan.messages[0]?.content ?? "";
        assert.notStrictEqual(prepared.session, stored.id);
        assert.include(prompt, item.title);
        assert.include(prompt, "You were interrupted part-way through");
      });
    });
  });

  it.layer(testLayer())((it) => {
    it.effect("uses a continuation nudge for an interrupted Run", () => {
      const item = implementItem(105);
      const stored = session("session-interrupted");
      return Effect.gen(function* () {
        yield* seedBranchSession(item, stored);
        const prepared = yield* prepare(resume(item, stored));
        const prompt = prepared.plan.messages[0]?.content ?? "";
        assert.strictEqual(prepared.session, stored.id);
        assert.include(prompt, "You were interrupted part-way through");
        assert.include(prompt, prepared.checkoutPath);
        assert.notInclude(prompt, item.title);
      });
    });
  });

  it.layer(testLayer())((it) => {
    it.effect("resumes the linked external branch's persisted Session for follow-up", () => {
      const item = { ...followUpItem(106), followUpBranch: externalBranch };
      const stored = session("session-external-branch");
      return Effect.gen(function* () {
        yield* seedBranchSession(item, stored, 1_000, externalBranch);
        const prepared = yield* prepare(item);
        const calls = yield* Ref.get(yield* WorktreeCalls);
        assert.strictEqual(prepared.session, stored.id);
        assert.strictEqual(prepared.branch, externalBranch);
        assert.deepStrictEqual(calls, [{ item: item.id, options: { branch: externalBranch } }]);
      });
    });
  });

  it.layer(testLayer())((it) => {
    it.effect("resumes explicit recovery on the linked external branch", () => {
      const base = { ...followUpItem(113), followUpBranch: externalBranch };
      const stored = session("session-external-recovery");
      const item = resume(base, stored);
      return Effect.gen(function* () {
        yield* seedBranchSession(item, stored, 1_000, externalBranch);
        const prepared = yield* prepare(item);
        const calls = yield* Ref.get(yield* WorktreeCalls);
        assert.strictEqual(prepared.session, stored.id);
        assert.strictEqual(prepared.branch, externalBranch);
        assert.deepStrictEqual(calls, [{ item: item.id, options: { resume: true, branch: externalBranch } }]);
      });
    });
  });

  it.layer(testLayer())((it) => {
    it.effect("starts a fresh Session for an explicit fresh follow-up", () => {
      const item = followUpItem(107, true);
      const stored = session("session-follow-up");
      return Effect.gen(function* () {
        yield* seedBranchSession(item, stored);
        const prepared = yield* prepare(item);
        const prompt = prepared.plan.messages[0]?.content ?? "";
        assert.notStrictEqual(prepared.session, stored.id);
        assert.include(prompt, item.title);
        assert.notInclude(prompt, "You were interrupted part-way through");
      });
    });
  });

  it.layer(testLayer(cursor, { created: true }))((it) => {
    it.effect("starts a fresh follow-up Session when the worktree was recreated", () => {
      const item = followUpItem(112);
      const stored = session("session-recreated-follow-up");
      return Effect.gen(function* () {
        yield* seedBranchSession(item, stored);
        const prepared = yield* prepare(item);
        assert.notStrictEqual(prepared.session, stored.id);
      });
    });
  });

  it.layer(testLayer(cursor, {}, "read-only"))((it) => {
    it.effect("uses the workspace checkout for a read-only implement Operation", () => {
      const item = implementItem(114);
      return Effect.gen(function* () {
        const prepared = yield* prepare(item, cursor, "read-only");
        assert.strictEqual(prepared.checkoutPath, workspace.config.checkoutPath);
        assert.isNull(prepared.branch);
        assert.deepStrictEqual(yield* Ref.get(yield* WorktreeCalls), []);
      });
    });
  });

  it.layer(testLayer())((it) => {
    it.effect("uses the workspace checkout without touching a worktree for triage", () => {
      const item = triageItem(108);
      return Effect.gen(function* () {
        const prepared = yield* prepare(item);
        assert.strictEqual(prepared.checkoutPath, workspace.config.checkoutPath);
        assert.isNull(prepared.branch);
        assert.deepStrictEqual(yield* Ref.get(yield* WorktreeCalls), []);
      });
    });
  });

  it.layer(testLayer(replay, {}, "read-only"))((it) => {
    it.effect("uses the workspace checkout without touching a worktree for replay", () => {
      const item = implementItem(109);
      return Effect.gen(function* () {
        const prepared = yield* prepare(item, replay, "read-only");
        assert.strictEqual(prepared.checkoutPath, workspace.config.checkoutPath);
        assert.isNull(prepared.branch);
        assert.deepStrictEqual(yield* Ref.get(yield* WorktreeCalls), []);
      });
    });
  });

  it.layer(testLayer(cursor, { failure: divergedWorktree }))((it) => {
    it.effect("preserves the candidate Session in a typed preparation failure", () => {
      const item = implementItem(111);
      const stored = session("session-prepare-failure");
      return Effect.gen(function* () {
        yield* seedBranchSession(item, stored);
        const failure = yield* Effect.flip(prepare(item));
        assert.strictEqual(failure._tag, "PreparationFailure");
        assert.strictEqual(failure.error, divergedWorktree);
        assert.strictEqual(failure.session?.id, stored.id);
      });
    });
  });
});
