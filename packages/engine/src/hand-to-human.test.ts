import { WorkItemId, WorkspaceConfig } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { handoffRoleFor, handToHuman, releaseClaim } from "./hand-to-human";
import { IssueTrackerError, type IssueTrackerService, type RoleChanges } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";

const id = Schema.decodeSync(WorkItemId);

const workspace: RegisteredWorkspace = {
  source: "a.workspace.ts",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "a",
    checkoutPath: "/repos/a",
    issueTracker: { type: "github", repo: "owner/a", actorLogin: "clanker-bot" },
    harness: { preferred: "cursor" },
    playbook: { triage: { enabled: true } },
  }),
};

const item = { id: id("#1"), title: "item 1" };

const stub = (over: Partial<IssueTrackerService>): IssueTrackerService => ({
  rateLimitScope: () => null,
  observe: () => Effect.succeed([]),
  claim: () => Effect.void,
  release: () => Effect.void,
  recordAttempt: () => Effect.void,
  recordFollowUp: () => Effect.void,
  note: () => Effect.void,
  setRoles: () => Effect.void,
  ...over,
});

interface Recorder {
  readonly roles: Ref.Ref<ReadonlyArray<RoleChanges>>;
  readonly notes: Ref.Ref<ReadonlyArray<string>>;
  readonly released: Ref.Ref<ReadonlyArray<string>>;
}

const recording = (over: Partial<IssueTrackerService> = {}) =>
  Effect.gen(function* () {
    const roles = yield* Ref.make<ReadonlyArray<RoleChanges>>([]);
    const notes = yield* Ref.make<ReadonlyArray<string>>([]);
    const released = yield* Ref.make<ReadonlyArray<string>>([]);
    const tracker = stub({
      setRoles: (_workspace, _itemId, changes) => Ref.update(roles, (xs) => [...xs, changes]),
      note: (_workspace, _itemId, detail) => Ref.update(notes, (xs) => [...xs, detail]),
      release: (_workspace, itemId) => Ref.update(released, (xs) => [...xs, itemId]),
      ...over,
    });
    return { tracker, recorder: { roles, notes, released } satisfies Recorder };
  });

const unavailable = new IssueTrackerError({ reason: "unavailable", message: "tracker down" });

describe("handoffRoleFor", () => {
  it("maps each retryable stage back to the role it hands off from", () => {
    assert.strictEqual(handoffRoleFor("implement"), "ready-for-agent");
    assert.strictEqual(handoffRoleFor("triage"), "needs-triage");
  });

  it("has no role to hand back for stages that carry none", () => {
    assert.isNull(handoffRoleFor("follow-up"));
    assert.isNull(handoffRoleFor("verify"));
  });
});

describe("handToHuman", () => {
  it.effect("swaps the stage role and posts the handoff note with a resume command", () =>
    Effect.gen(function* () {
      const { tracker, recorder } = yield* recording();
      yield* handToHuman(tracker)({
        workspace,
        item,
        stage: "implement",
        cause: { kind: "max-attempts", attempts: 3 },
        reason: "boom",
        session: "sess-1",
      });
      assert.deepStrictEqual(yield* Ref.get(recorder.roles), [
        { remove: ["ready-for-agent"], add: ["ready-for-human"] },
      ]);
      const note = (yield* Ref.get(recorder.notes))[0] ?? "";
      assert.include(note, "Exhausted after 3 failed implement attempts.");
      assert.include(note, "ready-for-human");
      assert.include(note, "Last failure: boom");
      assert.include(note, "agent --resume 'sess-1'");
    }),
  );

  it.effect("leaves the release to the caller", () =>
    Effect.gen(function* () {
      const { tracker, recorder } = yield* recording();
      yield* handToHuman(tracker)({
        workspace,
        item,
        stage: "implement",
        cause: { kind: "max-attempts", attempts: 3 },
        reason: "boom",
        session: null,
      });
      assert.deepStrictEqual(yield* Ref.get(recorder.released), []);
    }),
  );

  it.effect("omits the resume block when the run left no session", () =>
    Effect.gen(function* () {
      const { tracker, recorder } = yield* recording();
      yield* handToHuman(tracker)({
        workspace,
        item,
        stage: "triage",
        cause: { kind: "crash-loop", crashes: 2 },
        reason: "gone",
        session: null,
      });
      assert.deepStrictEqual(yield* Ref.get(recorder.roles), [
        { remove: ["needs-triage"], add: ["ready-for-human"] },
      ]);
      const note = (yield* Ref.get(recorder.notes))[0] ?? "";
      assert.include(note, "Exhausted after 2 consecutive triage crashes.");
      assert.notInclude(note, "Resume the session");
    }),
  );
});

describe("releaseClaim", () => {
  it.effect("releases the claim through the tracker", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make<ReadonlyArray<string>>([]);
      const tracker = stub({
        release: (_workspace, itemId) => Ref.update(released, (xs) => [...xs, itemId]),
      });
      yield* releaseClaim(tracker)(workspace, id("#1"));
      assert.deepStrictEqual(yield* Ref.get(released), [id("#1")]);
    }),
  );

  it.effect("tolerates a tracker failure with a warning instead of failing", () =>
    Effect.gen(function* () {
      const tracker = stub({ release: () => Effect.fail(unavailable) });
      const exit = yield* releaseClaim(tracker)(workspace, id("#1")).pipe(Effect.exit);
      assert.isTrue(exit._tag === "Success");
    }),
  );
});
