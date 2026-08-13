import {
  type AttemptRecord,
  type Claim,
  type TriageRole,
  WorkItemId,
  WorkspaceConfig,
} from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { triageProposalBody } from "./comments";
import type { CommentHost, CoordinationComment } from "./coordination";
import * as Coordination from "./coordination";
import { type CoordinationHost, type ListedItem, makeCoordinationTracker } from "./coordination-tracker";
import type { FollowUpMarker } from "./follow-up";
import { wireCodec } from "./github/markers";
import type { RoleChanges } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";

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
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly openBlockers: number;
  readonly comments: ReadonlyArray<CoordinationComment<number>>;
}

interface SeedItem {
  readonly number: number;
  readonly title?: string;
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
    labels: seed.labels ?? [],
    assignees: seed.assignees ?? [],
    openBlockers: seed.openBlockers ?? 0,
    comments: seed.comments ?? [],
  },
];

const numberOf = (id: WorkItemId) => Number.parseInt(id.replace(/^#/, ""), 10);

const makeFakeHost = Effect.fn("fakeHost")(function* (seed: ReadonlyArray<SeedItem>) {
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
    roles: item.labels.filter(isRole),
    assignees: item.assignees,
    claimLabeled: item.labels.includes(claimLabel),
    openBlockers: item.openBlockers,
    claimIdentity: claimant,
    comments: item.comments,
  });

  const host: CoordinationHost<number, number> = {
    codec,
    rateLimitScope: () => null,
    list: () => Ref.get(items).pipe(Effect.map((all) => [...all.values()].map(toListed))),
    resolve: (_workspace, id) => Effect.succeed(numberOf(id)),
    comments: commentsFor,
    claimIdentity: () => claimant,
    addClaim: (number) => patch(number, withLabel(claimLabel)),
    removeClaim: (number) => patch(number, withoutLabel(claimLabel)),
    addRole: (number, role) => patch(number, withLabel(role)),
    removeRole: (number, role) => patch(number, withoutLabel(role)),
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
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "fake",
    checkoutPath: "/repos/fake",
    issueTracker: { type: "github", repo: "owner/repo" },
    harness: { preferred: "cursor" },
  }),
};

const observed = (tracker: ReturnType<typeof makeCoordinationTracker>, id: string) =>
  tracker.observe(workspace).pipe(Effect.map((items) => items.find((item) => item.id === id)));

describe("coordination tracker", () => {
  it.effect("claims an item, then observes the claim as ours with its stage carried", () =>
    Effect.gen(function* () {
      const { host } = yield* makeFakeHost([{ number: 7, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      const request = { claimedAtMillis: 1_722_000_000_000, stage: "implement" } as const;
      yield* tracker.claim(workspace, decodeId("#7"), request);
      const item = yield* observed(tracker, "#7");
      assert.deepStrictEqual(item?.claim, { by: claimant, ...request });
      assert.isTrue(item?.claimedByUs);
      assert.isTrue(item?.owned);
    }),
  );

  it.effect("carries earlier markers forward and keeps one coordination comment", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 7, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      const claim = { claimedAtMillis: 10, stage: "implement" } as const;
      const attempt: AttemptRecord = { stage: "implement", outcome: "failed", atMillis: 11 };
      yield* tracker.claim(workspace, decodeId("#7"), claim);
      yield* tracker.recordAttempt(workspace, decodeId("#7"), attempt, "git worktree add: boom");
      const item = yield* observed(tracker, "#7");
      assert.deepStrictEqual(item?.claim, { by: claimant, ...claim });
      assert.deepStrictEqual(item?.attempts, [attempt]);
      const stored = yield* itemAt(7);
      assert.strictEqual(stored?.comments.length, 1);
      assert.include(
        stored?.comments[0]?.body ?? "",
        "Last implement attempt failed: git worktree add: boom",
      );
    }),
  );

  it.effect("records a follow-up marker and carries a hand-off detail through a later write", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 5, labels: ["ready-for-agent"] }]);
      const tracker = makeCoordinationTracker(host);
      const marker: FollowUpMarker = {
        checks: "failing",
        humanCommentAtMillis: 4,
        noProgress: 1,
        baseDivergence: "clean",
        botTriggerAtMillis: 0,
      };
      yield* tracker.recordFollowUp(workspace, decodeId("#5"), marker, "Handing this to a human.");
      yield* tracker.recordAttempt(workspace, decodeId("#5"), {
        stage: "follow-up",
        outcome: "failed",
        atMillis: 6,
      });
      const item = yield* observed(tracker, "#5");
      assert.deepStrictEqual(item?.followUp, marker);
      const stored = yield* itemAt(5);
      assert.strictEqual(stored?.comments.length, 1);
      assert.strictEqual(
        Coordination.coordinationDetail(codec, stored?.comments[0]?.body ?? ""),
        "Handing this to a human.",
      );
    }),
  );

  it.effect("posts a note as its own comment, clears a stale detail, and reads back as the proposal", () =>
    Effect.gen(function* () {
      const { host, itemAt } = yield* makeFakeHost([{ number: 3, labels: ["needs-triage"] }]);
      const tracker = makeCoordinationTracker(host);
      yield* tracker.recordFollowUp(
        workspace,
        decodeId("#3"),
        { checks: "failing", humanCommentAtMillis: 1, noProgress: 1, baseDivergence: "none", botTriggerAtMillis: 0 },
        "Old folded detail",
      );
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

  it.effect("swaps role labels and then runs the after-role-change hook", () =>
    Effect.gen(function* () {
      const { host, roleLog } = yield* makeFakeHost([{ number: 1, labels: ["needs-triage"] }]);
      const tracker = makeCoordinationTracker(host);
      const changes: RoleChanges = { add: ["wontfix"], remove: ["needs-triage"] };
      yield* tracker.setRoles(workspace, decodeId("#1"), changes);
      const item = yield* observed(tracker, "#1");
      assert.deepStrictEqual([...(item?.roles ?? [])].toSorted(), ["wontfix"]);
      assert.deepStrictEqual(yield* roleLog, [{ number: 1, changes }]);
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
              body: coordinationBody([
                serializeClaim({ by: "other-forge", claimedAtMillis: 1, stage: "implement" }),
              ]),
            },
          ],
        },
      ]);
      const tracker = makeCoordinationTracker(host);
      const item = yield* observed(tracker, "#33");
      assert.strictEqual(item?.claim?.by, "other-forge");
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
              body: coordinationBody([serializeClaim({ by: "attacker", claimedAtMillis: 1 })]),
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
