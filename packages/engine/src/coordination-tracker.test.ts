import {
  type AttemptRecord,
  type Claim,
  codingOperation,
  keyOf,
  LineageId,
  type TriageRole,
  WorkItemId,
  WorkspaceConfig,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { classify } from "./classify";
import { triageProposalBody } from "./comments";
import type { CommentHost, CoordinationComment } from "./coordination";
import * as Coordination from "./coordination";
import { verifyCoordinationContract } from "./coordination-contract";
import {
  type CoordinationHost,
  handoffRoleFor,
  type ListedItem,
  makeCoordinationTracker,
  makeTrackerCoordination,
} from "./coordination-tracker";
import type { FollowUpMarker } from "./follow-up";
import { wireCodec } from "./github/markers";
import { IssueTrackerError, type RoleChanges } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";
import { LogProbe } from "./testing/log-probe";

const codec = wireCodec;
const decodeId = Schema.decodeSync(WorkItemId);

const claimant = "test-bot";
const claimLabel = "claimed";

const triageRoles: ReadonlyArray<TriageRole> = [
  "needs-triage",
  "ready-for-agent",
  "needs-info",
  "ready-for-human",
  "wontfix",
];
const isRole = (label: string): label is TriageRole => triageRoles.some((role) => role === label);

const serializeClaim = (claim: Claim) => Coordination.serializeClaim(codec, claim);
const coordinationBody = (markers: ReadonlyArray<string>) =>
  Coordination.formatCoordinationBody(codec, {
    status: Coordination.defaultStatus,
    markers,
    detail: null,
  });

interface FakeItem {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly openBlockers: number;
  readonly comments: ReadonlyArray<CoordinationComment<number>>;
}

interface SeedItem {
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly assignees?: ReadonlyArray<string>;
  readonly openBlockers?: number;
  readonly comments?: ReadonlyArray<CoordinationComment<number>>;
}

const toFakeItem = (seed: SeedItem): readonly [number, FakeItem] => [
  seed.number,
  {
    number: seed.number,
    title: seed.title ?? `issue ${seed.number}`,
    body: seed.body ?? "",
    labels: seed.labels ?? [],
    assignees: seed.assignees ?? [],
    openBlockers: seed.openBlockers ?? 0,
    comments: seed.comments ?? [],
  },
];

const numberOf = (id: WorkItemId) => Number.parseInt(id.replace(/^#/, ""), 10);

const makeFakeHost = Effect.fn("fakeHost")(function* (
  seed: ReadonlyArray<SeedItem>,
  failedRoleRemoval?: TriageRole,
) {
  const items = yield* Ref.make(new Map<number, FakeItem>(seed.map(toFakeItem)));
  const nextCommentId = yield* Ref.make(1000);
  const roleLog = yield* Ref.make<ReadonlyArray<{ readonly number: number; readonly changes: RoleChanges }>>(
    [],
  );

  const patch = (number: number, update: (item: FakeItem) => FakeItem) =>
    Ref.update(items, (all) => {
      const item = all.get(number);
      return item ? new Map(all).set(number, update(item)) : all;
    });
  const withLabel = (label: string) => (item: FakeItem) =>
    item.labels.includes(label) ? item : { ...item, labels: [...item.labels, label] };
  const withoutLabel = (label: string) => (item: FakeItem) => ({
    ...item,
    labels: item.labels.filter((existing) => existing !== label),
  });

  const commentsFor = (number: number): CommentHost<number> => ({
    comments: Ref.get(items).pipe(Effect.map((all) => all.get(number)?.comments ?? [])),
    edit: (id, body) =>
      patch(number, (item) => ({
        ...item,
        comments: item.comments.map((comment) => (comment.id === id ? { ...comment, body } : comment)),
      })),
    create: (body) =>
      Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(nextCommentId, (value) => value + 1);
        yield* patch(number, (item) => ({
          ...item,
          comments: [...item.comments, { id, body, isBot: true, createdAtMillis: id }],
        }));
      }),
  });

  const toListed = (item: FakeItem): ListedItem<number> => ({
    id: decodeId(`#${item.number}`),
    title: item.title,
    url: `https://github.com/owner/repo/issues/${item.number}`,
    roles: item.labels.filter(isRole),
    assignees: item.assignees,
    claimLabeled: item.labels.includes(claimLabel),
    openBlockers: item.openBlockers,
    acceptedClaimants: [claimant],
    priority: "medium",
    comments: item.comments,
  });

  const host: CoordinationHost<number, number> = {
    codec,
    rateLimitScope: () => null,
    list: () => Ref.get(items).pipe(Effect.map((all) => [...all.values()].map(toListed))),
    resolve: (_workspace, id) => Effect.succeed(numberOf(id)),
    readProse: () => Effect.succeed({ body: "", comments: [] }),
    comments: commentsFor,
    claimIdentity: () => claimant,
    addClaim: (number) => patch(number, withLabel(claimLabel)),
    removeClaim: (number) => patch(number, withoutLabel(claimLabel)),
    addRole: (number, role) => patch(number, withLabel(role)),
    removeRole: (number, role) =>
      role === failedRoleRemoval
        ? Effect.fail(new IssueTrackerError({ reason: "unavailable", message: `cannot remove ${role}` }))
        : patch(number, withoutLabel(role)),
    afterRoleChange: (number, changes) => Ref.update(roleLog, (log) => [...log, { number, changes }]),
  };

  return {
    host,
    itemAt: (number: number) => Ref.get(items).pipe(Effect.map((all) => all.get(number))),
    roleLog: Ref.get(roleLog),
  };
});

const workspace: RegisteredWorkspace = {
  source: "fake.workspace.ts",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "fake",
    checkoutPath: "/repos/fake",
    issueTracker: { type: "github" },
  }),
};

const lineageFor = (id: string) => ({
  root: LineageId.make(keyOf({ _tag: "Issue", workspace: workspace.config.name, id: decodeId(id) })),
  parent: null,
  hop: 0,
});
const claimRecord = (by: string, id: string, claimedAtMillis: number, stage = "implement") => ({
  by,
  claimedAtMillis,
  operation: codingOperation(stage),
  lineage: lineageFor(id),
});
const attemptRecord = (
  id: string,
  stage: string,
  outcome: "succeeded" | "failed" | "abandoned",
  atMillis: number,
) => ({ operation: codingOperation(stage), outcome, atMillis, lineage: lineageFor(id) });

const observed = (tracker: ReturnType<typeof makeCoordinationTracker>, id: string) =>
  tracker.observe(workspace).pipe(Effect.map((items) => items.find((item) => item.id === id)));

describe("coordination tracker", () => {
  it.effect("satisfies the shared coordination contract", () =>
    Effect.gen(function* () {
      const { host } = yield* makeFakeHost([{ number: 7, labels: ["ready-for-agent"] }]);
      const [listed] = yield* host.list(workspace);
      if (listed === undefined) return assert.fail("missing tracker item");
      const coordination = makeTrackerCoordination(host, workspace, listed, claimant);
      yield* verifyCoordinationContract(coordination, {
        _tag: "Issue",
        workspace: workspace.config.name,
        id: decodeId("#7"),
      });
    }),
  );

  it.effect("claims an item, then observes the claim as ours with its stage carried", () =>
    Effect.gen(function* () {
      const { host } = yield* makeFakeHost([{ number: 7, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      const request = { claimedAtMillis: 1_722_000_000_000, stage: "implement" } as const;
      yield* tracker.claim(workspace, decodeId("#7"), request);
      const item = yield* observed(tracker, "#7");
      assert.deepStrictEqual(
        item?.claim,
        claimRecord(claimant, "#7", request.claimedAtMillis, request.stage),
      );
      assert.isTrue(item?.claimedByUs);
    }),
  );

  it.effect("leaves no claim label when the coordination marker write fails", () =>
    Effect.gen(function* () {
      const { host } = yield* makeFakeHost([{ number: 7, labels: ["ready-for-agent"] }]);
      const comments = host.comments;
      const tracker = makeCoordinationTracker({
        ...host,
        comments: (ref) => ({
          ...comments(ref),
          create: () =>
            Effect.fail(
              new IssueTrackerError({ reason: "unavailable", message: "coordination marker write failed" }),
            ),
        }),
      });

      const error = yield* tracker
        .claim(workspace, decodeId("#7"), { claimedAtMillis: 1_722_000_000_000, stage: "implement" })
        .pipe(Effect.flip);
      assert.strictEqual(error.message, "coordination marker write failed");

      const [item] = yield* tracker.observe(workspace);
      assert.isFalse(item?.claimHeld ?? true);
      const nextPoll = classify(item ? [{ ...item, pr: null }] : []);
      assert.deepStrictEqual(
        nextPoll.eligible.map((work) => work.id),
        [decodeId("#7")],
      );
    }),
  );

  it.effect("keeps an existing claim when its coordination marker refresh fails", () =>
    Effect.gen(function* () {
      const { host } = yield* makeFakeHost([{ number: 7, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      yield* tracker.claim(workspace, decodeId("#7"), {
        claimedAtMillis: 1_722_000_000_000,
        stage: "implement",
      });

      const comments = host.comments;
      const failingTracker = makeCoordinationTracker({
        ...host,
        comments: (ref) => ({
          ...comments(ref),
          edit: () =>
            Effect.fail(
              new IssueTrackerError({ reason: "unavailable", message: "coordination marker write failed" }),
            ),
        }),
      });

      yield* failingTracker
        .claim(workspace, decodeId("#7"), { claimedAtMillis: 1_722_000_000_001, stage: "implement" })
        .pipe(Effect.flip);

      const [item] = yield* failingTracker.observe(workspace);
      assert.isTrue(item?.claimHeld ?? false);
      assert.isTrue(item?.claimedByUs ?? false);
      assert.strictEqual(item?.claim?.claimedAtMillis, 1_722_000_000_000);
    }),
  );

  it.effect("carries earlier markers forward and keeps one coordination comment", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 7, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      const claim = { claimedAtMillis: 10, stage: "implement" } as const;
      const attempt: AttemptRecord = attemptRecord("#7", "implement", "failed", 11);
      yield* tracker.claim(workspace, decodeId("#7"), claim);
      yield* tracker.attemptFailed(workspace, decodeId("#7"), {
        ...codingOperation("implement"),
        atMillis: 11,
        reason: "git worktree add: boom",
      });
      const item = yield* observed(tracker, "#7");
      assert.deepStrictEqual(item?.claim, claimRecord(claimant, "#7", 10));
      assert.deepStrictEqual(item?.attempts, [{ ...attempt, reason: "git worktree add: boom" }]);
      const stored = yield* itemAt(7);
      assert.strictEqual(stored?.comments.length, 1);
      assert.include(
        stored?.comments[0]?.body ?? "",
        "Last implement attempt failed: `git worktree add: boom`",
      );
    }),
  );

  it.effect("posts a note as its own comment, clears a stale detail, and reads back as the proposal", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 3, labels: ["needs-triage"] }]);
      const tracker = makeCoordinationTracker(host);
      yield* tracker.stalled(workspace, decodeId("#3"), {
        marker: {
          checks: "failing",
          humanCommentAtMillis: 1,
          noProgress: 1,
          baseDivergence: "none",
          botTriggerAtMillis: 0,
        },
        atMillis: 2,
        detail: "Old folded detail",
      });
      yield* tracker.note(workspace, decodeId("#3"), triageProposalBody("Recommend ready-for-agent."));
      const stored = yield* itemAt(3);
      assert.strictEqual(stored?.comments.length, 2);
      const ledger = Coordination.selectLedger(codec, stored?.comments ?? []);
      const note = stored?.comments.find((comment) => comment.id !== ledger?.id);
      assert.isNull(Coordination.coordinationDetail(codec, ledger?.body ?? ""));
      assert.isFalse(Coordination.hasLedgerMarker(codec, note?.body ?? ""));
      const item = yield* observed(tracker, "#3");
      assert.strictEqual(item?.proposal, "Recommend ready-for-agent.");
    }),
  );

  it.effect("stops reading a claim once release drops the claim label", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 7, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      yield* tracker.claim(workspace, decodeId("#7"), { claimedAtMillis: 1, stage: "implement" });
      yield* tracker.release(workspace, decodeId("#7"));
      const item = yield* observed(tracker, "#7");
      assert.isNull(item?.claim ?? null);
      const stored = yield* itemAt(7);
      assert.isFalse(stored?.labels.includes(claimLabel) ?? true);
    }),
  );

  it.effect("reads a claim stamped by a different identity as not ours", () =>
    Effect.gen(function* () {
      const { host } = yield* makeFakeHost([
        {
          number: 33,
          labels: ["ready-for-agent", claimLabel],
          comments: [
            {
              id: 1,
              isBot: true,
              createdAtMillis: 1,
              body: coordinationBody([serializeClaim(claimRecord("other-agent", "#33", 1))]),
            },
          ],
        },
      ]);
      const tracker = makeCoordinationTracker(host);
      const item = yield* observed(tracker, "#33");
      assert.strictEqual(item?.claim?.by, "other-agent");
      assert.isFalse(item?.claimedByUs);
    }),
  );

  it.effect("ignores a claim marker in a comment the host does not attribute to itself", () =>
    Effect.gen(function* () {
      const { host } = yield* makeFakeHost([
        {
          number: 8,
          labels: ["ready-for-agent", claimLabel],
          comments: [
            {
              id: 1,
              isBot: false,
              createdAtMillis: 1,
              body: coordinationBody([serializeClaim(claimRecord("attacker", "#8", 1))]),
            },
          ],
        },
      ]);
      const tracker = makeCoordinationTracker(host);
      const item = yield* observed(tracker, "#8");
      assert.isNull(item?.claim ?? null);
    }),
  );
});

const marker: FollowUpMarker = {
  checks: "failing",
  humanCommentAtMillis: 4,
  noProgress: 2,
  baseDivergence: "clean",
  botTriggerAtMillis: 0,
};

const ledgerBody = (comments: ReadonlyArray<CoordinationComment<number>>) =>
  Coordination.selectLedger(codec, comments)?.body ?? "";

describe("coordination outcomes", () => {
  it.effect("triaged posts the proposal, swaps the role, and records a triage success", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 10, labels: ["needs-triage"] }]);
      const tracker = makeCoordinationTracker(host);
      yield* tracker.triaged(workspace, decodeId("#10"), {
        role: "ready-for-agent",
        proposal: triageProposalBody("Recommend ready-for-agent."),
        atMillis: 11,
      });
      const stored = yield* itemAt(10);
      assert.include(ledgerBody(stored?.comments ?? []), "triage completed.");
      const item = yield* observed(tracker, "#10");
      assert.deepStrictEqual([...(item?.roles ?? [])], ["ready-for-agent"]);
      assert.deepStrictEqual(item?.attempts, [attemptRecord("#10", "triage", "succeeded", 11)]);
      assert.strictEqual(item?.proposal, "Recommend ready-for-agent.");
    }),
  );

  it.effect("implemented clears ready-for-agent and records an implement success", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 11, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      yield* tracker.implemented(workspace, decodeId("#11"), { atMillis: 12 });
      const stored = yield* itemAt(11);
      assert.include(ledgerBody(stored?.comments ?? []), "implement completed.");
      const item = yield* observed(tracker, "#11");
      assert.deepStrictEqual([...(item?.roles ?? [])], []);
      assert.deepStrictEqual(item?.attempts, [attemptRecord("#11", "implement", "succeeded", 12)]);
    }),
  );

  it.effect("followedUp records the follow-up marker and a follow-up success", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 12, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      yield* tracker.followedUp(workspace, decodeId("#12"), {
        marker,
        summary: "The requested change was already correct.",
        atMillis: 13,
      });
      const stored = yield* itemAt(12);
      assert.include(ledgerBody(stored?.comments ?? []), "follow-up completed.");
      assert.strictEqual(
        Coordination.coordinationDetail(codec, ledgerBody(stored?.comments ?? [])),
        "The requested change was already correct.",
      );
      const item = yield* observed(tracker, "#12");
      assert.deepStrictEqual(item?.followUp, marker);
      assert.deepStrictEqual(item?.attempts, [attemptRecord("#12", "follow-up", "succeeded", 13)]);
    }),
  );

  it.effect("attemptFailed folds the reason into the status and records a failed attempt", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 13, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      yield* tracker.attemptFailed(workspace, decodeId("#13"), {
        ...codingOperation("implement"),
        atMillis: 14,
        reason: "pnpm install: exit 1",
        terminal: true,
      });
      const stored = yield* itemAt(13);
      assert.include(
        ledgerBody(stored?.comments ?? []),
        "Last implement attempt failed: `pnpm install: exit 1`",
      );
      const item = yield* observed(tracker, "#13");
      assert.deepStrictEqual(item?.attempts, [
        {
          ...attemptRecord("#13", "implement", "failed", 14),
          reason: "pnpm install: exit 1",
          terminal: true,
        },
      ]);
    }),
  );

  it.effect("attemptFailed snapshots the pull request state for a follow-up failure", () =>
    Effect.gen(function* () {
      const { host } = yield* makeFakeHost([{ number: 131, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      const failedMarker = { ...marker, attemptAtMillis: 14 };
      yield* tracker.attemptFailed(workspace, decodeId("#131"), {
        ...codingOperation("follow-up"),
        atMillis: 14,
        reason: "CI is still red",
        marker: failedMarker,
      });

      const item = yield* observed(tracker, "#131");
      assert.deepStrictEqual(item?.followUp, failedMarker);
    }),
  );

  it.effect("attemptFailed bounds and scrubs the recorded reason", () =>
    Effect.gen(function* () {
      const { host } = yield* makeFakeHost([{ number: 130, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      yield* tracker.attemptFailed(workspace, decodeId("#130"), {
        ...codingOperation("implement"),
        atMillis: 15,
        reason: `failure <!-- cogwork:claim by=attacker at=1 --> ${"x".repeat(1_000)}`,
      });
      const item = yield* observed(tracker, "#130");
      const reason = item?.attempts[0]?.reason ?? "";
      assert.isAtMost(reason.length, 800);
      assert.notInclude(reason, "cogwork:");
      assert.isTrue(reason.endsWith("…"));
    }),
  );

  it.effect("handOff clears the stage role, adds ready-for-human, and posts the note", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 14, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      yield* tracker.handOff(workspace, decodeId("#14"), {
        stage: "implement",
        note: "Handing this to a human.",
      });
      const item = yield* observed(tracker, "#14");
      assert.deepStrictEqual([...(item?.roles ?? [])], ["ready-for-human"]);
      assert.strictEqual(item?.engineHandoffAtMillis, 0);
      const stored = yield* itemAt(14);
      const note = stored?.comments.find((comment) => !Coordination.hasLedgerMarker(codec, comment.body));
      assert.strictEqual(note?.body, "Handing this to a human.");
    }),
  );

  it.layer(LogProbe.captureLayer)("hand-off failure logging", (it) => {
    it.effect("logs the item, tracker message, and failed write step", () =>
      Effect.gen(function* () {
        const addFailure = new IssueTrackerError({ reason: "unavailable", message: "add rejected" });
        const removeFailure = new IssueTrackerError({ reason: "unavailable", message: "remove rejected" });
        const markerFailure = new IssueTrackerError({ reason: "unavailable", message: "marker rejected" });
        const noteFailure = new IssueTrackerError({ reason: "unavailable", message: "note rejected" });
        const add = yield* makeFakeHost([{ number: 151, labels: ["ready-for-agent"] }]);
        const remove = yield* makeFakeHost([{ number: 152, labels: ["ready-for-agent"] }]);
        const marker = yield* makeFakeHost([{ number: 153, labels: ["ready-for-agent"] }]);
        const note = yield* makeFakeHost([
          {
            number: 154,
            labels: ["ready-for-agent"],
            comments: [
              {
                id: 1,
                isBot: true,
                createdAtMillis: 1,
                body: coordinationBody([]),
              },
            ],
          },
        ]);
        const markerComments = marker.host.comments;
        const noteComments = note.host.comments;
        const cases = [
          {
            id: "#151",
            tracker: makeCoordinationTracker({
              ...add.host,
              addRole: (ref, role) =>
                role === "ready-for-human" ? Effect.fail(addFailure) : add.host.addRole(ref, role),
            }),
          },
          {
            id: "#152",
            tracker: makeCoordinationTracker({
              ...remove.host,
              removeRole: (ref, role) =>
                role === "ready-for-agent" ? Effect.fail(removeFailure) : remove.host.removeRole(ref, role),
            }),
          },
          {
            id: "#153",
            tracker: makeCoordinationTracker({
              ...marker.host,
              comments: (ref) => ({ ...markerComments(ref), create: () => Effect.fail(markerFailure) }),
            }),
          },
          {
            id: "#154",
            tracker: makeCoordinationTracker({
              ...note.host,
              comments: (ref) => ({ ...noteComments(ref), create: () => Effect.fail(noteFailure) }),
            }),
          },
        ];

        const errors = yield* Effect.forEach(cases, ({ id, tracker }) =>
          tracker
            .handOff(workspace, decodeId(id), { stage: "follow-up", note: "Needs a person." })
            .pipe(Effect.flip),
        );
        assert.deepStrictEqual(
          errors.map((error) => error.reason),
          ["unavailable", "unavailable", "unavailable", "unavailable"],
        );

        const logs = yield* LogProbe;
        const failures = (yield* logs.entries)
          .map(({ message }) => message)
          .filter(
            (message): message is ReadonlyArray<unknown> =>
              Array.isArray(message) && message.includes("hand-off write failed"),
          );
        assert.deepStrictEqual(failures, [
          ["hand-off write failed", { item: "#151", step: "add role", message: "add rejected" }],
          ["hand-off write failed", { item: "#152", step: "remove role", message: "remove rejected" }],
          ["hand-off write failed", { item: "#153", step: "marker", message: "marker rejected" }],
          ["hand-off write failed", { item: "#154", step: "note", message: "note rejected" }],
        ]);
      }),
    );
  });

  it.effect("handBack appends its record, applies one role, and keeps its note in the ledger", () =>
    Effect.gen(function* () {
      const failed: AttemptRecord = attemptRecord("#17", "implement", "failed", 2);
      const { host, itemAt, roleLog } = yield* makeFakeHost([
        {
          number: 17,
          labels: ["ready-for-human"],
          comments: [
            {
              id: 1,
              isBot: true,
              createdAtMillis: 1,
              body: coordinationBody([Coordination.serializeAttempt(codec, failed)]),
            },
          ],
        },
      ]);
      const tracker = makeCoordinationTracker(host);
      const changes: RoleChanges = { remove: ["ready-for-human"], add: ["ready-for-agent"] };
      yield* tracker.handBack(workspace, decodeId("#17"), {
        record: { by: "local-owner", atMillis: 5 },
        changes,
        note: "Try the repaired worktree setup.",
        trigger: { kind: "human-feedback", atMillis: 4 },
      });

      const item = yield* observed(tracker, "#17");
      assert.deepStrictEqual(item?.roles, ["ready-for-agent"]);
      assert.deepStrictEqual(item?.attempts, [failed]);
      assert.deepStrictEqual(item?.handback, {
        by: "local-owner",
        atMillis: 5,
        note: "Try the repaired worktree setup.",
      });
      assert.deepStrictEqual(item?.followUpTrigger, { kind: "human-feedback", atMillis: 4 });
      assert.deepStrictEqual(yield* roleLog, [{ number: 17, changes }]);

      const stored = yield* itemAt(17);
      assert.strictEqual(stored?.comments.length, 1);
      assert.strictEqual(
        Coordination.coordinationStatus(codec, ledgerBody(stored?.comments ?? [])),
        "Handed back by local-owner: Try the repaired worktree setup.",
      );
    }),
  );

  it.effect("handBack creates the coordination comment when it is missing", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 18, labels: ["ready-for-human"] }]);
      const tracker = makeCoordinationTracker(host);
      const outcome = yield* Effect.result(
        tracker.handBack(workspace, decodeId("#18"), {
          record: { by: "local-owner", atMillis: 5 },
          changes: { remove: ["ready-for-human"], add: ["ready-for-agent"] },
          note: "Try again with the repaired setup.",
        }),
      );
      if (Result.isFailure(outcome)) return assert.fail(outcome.failure.message);

      const item = yield* itemAt(18);
      assert.strictEqual(item?.comments.length, 1);
      assert.deepStrictEqual(item?.labels, ["ready-for-agent"]);
      const body = ledgerBody(item?.comments ?? []);
      assert.deepStrictEqual(Coordination.parseHandback(codec, body), {
        by: "local-owner",
        atMillis: 5,
        note: "Try again with the repaired setup.",
      });
      assert.strictEqual(
        Coordination.coordinationStatus(codec, body),
        "Handed back by local-owner: Try again with the repaired setup.",
      );
      const observedItem = yield* observed(tracker, "#18");
      assert.strictEqual(observedItem?.coordination?.barrierAtMillis, 5);
    }),
  );

  it.effect("Coordination.handBack creates its record and returns its barrier", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 20, labels: ["ready-for-human"] }]);
      const [listed] = yield* host.list(workspace);
      if (listed === undefined) return assert.fail("missing tracker item");
      const coordination = makeTrackerCoordination(host, workspace, listed, claimant);
      const ref = { _tag: "Issue", workspace: workspace.config.name, id: decodeId("#20") } as const;

      yield* TestClock.setTime(7);
      const outcome = yield* Effect.result(
        coordination.handBack(ref, { by: "local-owner", note: "Try again." }),
      );
      if (Result.isFailure(outcome)) return assert.fail(outcome.failure.message);

      assert.strictEqual(outcome.success.barrierAtMillis, 7);
      const item = yield* itemAt(20);
      assert.strictEqual(item?.comments.length, 1);
      assert.deepStrictEqual(Coordination.parseHandback(codec, ledgerBody(item?.comments ?? [])), {
        by: "local-owner",
        atMillis: 7,
        note: "Try again.",
      });
    }),
  );

  it.effect("handBack leaves no barrier when the role transition fails", () =>
    Effect.gen(function* () {
      const failed = attemptRecord("#19", "follow-up", "failed", 2);
      const { host } = yield* makeFakeHost(
        [
          {
            number: 19,
            labels: ["ready-for-human"],
            comments: [
              {
                id: 1,
                isBot: true,
                createdAtMillis: 1,
                body: coordinationBody([Coordination.serializeAttempt(codec, failed)]),
              },
            ],
          },
        ],
        "ready-for-human",
      );
      const tracker = makeCoordinationTracker(host);
      const error = yield* Effect.flip(
        tracker.handBack(workspace, decodeId("#19"), {
          record: { by: "cogwork", atMillis: 5 },
          changes: { remove: ["ready-for-human"], add: ["ready-for-agent"] },
        }),
      );

      assert.strictEqual(error._tag, "IssueTrackerError");
      const item = yield* observed(tracker, "#19");
      assert.isNull(item?.handback ?? null);
      assert.deepStrictEqual(item?.roles, ["ready-for-human"]);
    }),
  );

  it.effect("stalled records the abandonment, carries the detail, and adds ready-for-human", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 15, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      yield* tracker.stalled(workspace, decodeId("#15"), {
        marker,
        atMillis: 16,
        detail: "Follow-up made no progress. Handing this to a human.",
      });
      const stored = yield* itemAt(15);
      const body = ledgerBody(stored?.comments ?? []);
      assert.include(body, "follow-up abandoned.");
      assert.strictEqual(
        Coordination.coordinationDetail(codec, body),
        "Follow-up made no progress. Handing this to a human.",
      );
      const item = yield* observed(tracker, "#15");
      assert.deepStrictEqual([...(item?.roles ?? [])], ["ready-for-human"]);
      assert.strictEqual(item?.engineHandoffAtMillis, 16);
      assert.deepStrictEqual(item?.attempts, [attemptRecord("#15", "follow-up", "abandoned", 16)]);
    }),
  );

  it.effect("stalled restores the prior role when its role swap fails", () =>
    Effect.gen(function* () {
      const { host } = yield* makeFakeHost([{ number: 15, labels: ["ready-for-agent"] }], "ready-for-agent");
      const tracker = makeCoordinationTracker(host);
      const error = yield* Effect.flip(
        tracker.stalled(workspace, decodeId("#15"), {
          marker,
          atMillis: 16,
          detail: "Follow-up made no progress. Handing this to a human.",
        }),
      );

      assert.strictEqual(error._tag, "IssueTrackerError");
      const item = yield* observed(tracker, "#15");
      assert.deepStrictEqual([...(item?.roles ?? [])], ["ready-for-agent"]);
    }),
  );

  it.effect("reclassify applies the role changes and posts the note", () =>
    Effect.gen(function* () {
      const { host, itemAt, roleLog } = yield* makeFakeHost([
        {
          number: 16,
          labels: ["needs-triage"],
          comments: [
            {
              id: 1,
              isBot: true,
              createdAtMillis: 1,
              body: coordinationBody([Coordination.serializeEngineHandoff(codec, 1)]),
            },
          ],
        },
      ]);
      const tracker = makeCoordinationTracker(host);
      const changes: RoleChanges = { remove: ["needs-triage"], add: ["wontfix"] };
      yield* tracker.reclassify(workspace, decodeId("#16"), { changes, note: "Not planned." });
      const item = yield* observed(tracker, "#16");
      assert.deepStrictEqual([...(item?.roles ?? [])], ["wontfix"]);
      assert.deepStrictEqual(yield* roleLog, [{ number: 16, changes }]);
      assert.strictEqual(item?.engineHandoffAtMillis, null);
      const stored = yield* itemAt(16);
      assert.include(ledgerBody(stored?.comments ?? []), "engine-handoff at=none");
      const note = stored?.comments.find((comment) => !Coordination.hasLedgerMarker(codec, comment.body));
      assert.strictEqual(note?.body, "Not planned.");
    }),
  );
});

describe("handoffRoleFor", () => {
  it("maps each staged role back to the role a hand-off clears", () => {
    assert.strictEqual(handoffRoleFor("implement"), "ready-for-agent");
    assert.strictEqual(handoffRoleFor("triage"), "needs-triage");
    assert.strictEqual(handoffRoleFor("follow-up"), "ready-for-agent");
  });
});
