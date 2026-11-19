import { PrincipalId, WorkflowDocument, WorkflowId, type WorkflowRecord } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { WorkingCopyDaemon } from "../daemon/working-copy-daemon";
import { MemoryDaemon, memoryDaemonLayer } from "../testing/working-copy-daemon";
import { WorkingCopies, type WorkingCopySnapshot, layer as workingCopiesLayer } from "./working-copy";

const workflowId = Schema.decodeUnknownSync(WorkflowId)("workflow-1");

const draft: WorkflowRecord = {
  id: workflowId,
  principal: Schema.decodeUnknownSync(PrincipalId)("person"),
  workingCopy: Schema.decodeUnknownSync(WorkflowDocument)({
    name: "Draft",
    workspaces: { _tag: "Every" },
    triggers: [],
    operations: [],
  }),
  workingRevision: 1,
  publishedCopy: null,
  publishedRevision: null,
  enabled: false,
  diagnostics: [],
  readiness: [],
};

const testLayer = workingCopiesLayer.pipe(Layer.provideMerge(memoryDaemonLayer([draft])));

const snapshotWhere = (predicate: (snapshot: WorkingCopySnapshot) => boolean) =>
  Effect.flatMap(WorkingCopies, (copies) =>
    copies.snapshots(workflowId).pipe(Stream.filter(predicate), Stream.runHead),
  );

describe("WorkingCopies", () => {
  it.effect("trims a padded name before it sends, and refuses an empty name without sending", () =>
    Effect.gen(function* () {
      const daemon = yield* MemoryDaemon;
      const copies = yield* WorkingCopies;

      const renamed = yield* Effect.exit(copies.edit(workflowId, [{ _tag: "Rename", name: "Triage " }]));
      const refused = yield* Effect.exit(copies.edit(workflowId, [{ _tag: "Rename", name: "" }]));

      assert.deepStrictEqual(
        (yield* daemon.calls).map((call) => (call._tag === "edit" ? call.edits : null)),
        [[{ _tag: "Rename", name: "Triage" }]],
      );
      assert.strictEqual(Exit.isSuccess(renamed) ? renamed.value.workingCopy.name : null, "Triage");
      assert.strictEqual(Option.getOrNull(Exit.findErrorOption(refused))?._tag, "WorkingCopyInputInvalid");
      const snapshot = yield* snapshotWhere(() => true);
      assert.strictEqual(snapshot._tag === "Some" ? snapshot.value.saveStatus : null, "saved");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("answers each of two concurrent edits with its own reply, in call order", () =>
    Effect.gen(function* () {
      const daemon = yield* MemoryDaemon;
      const copies = yield* WorkingCopies;
      yield* daemon.holdReplies;

      const first = yield* Effect.forkChild(copies.edit(workflowId, [{ _tag: "Rename", name: "First" }]));
      const second = yield* Effect.forkChild(copies.edit(workflowId, [{ _tag: "Rename", name: "Second" }]));
      yield* snapshotWhere(({ pending }) => pending.length === 2);
      yield* daemon.releaseReplies;

      const firstReply = yield* Fiber.join(first);
      const secondReply = yield* Fiber.join(second);
      assert.deepStrictEqual(
        [firstReply, secondReply].map(({ workingCopy, workingRevision }) => [
          workingCopy.name,
          workingRevision,
        ]),
        [
          ["First", 2],
          ["Second", 3],
        ],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("marks a refused edit not saved, and the next accepted edit clears it", () =>
    Effect.gen(function* () {
      const copies = yield* WorkingCopies;

      const failure = yield* Effect.flip(
        copies.edit(workflowId, [{ _tag: "RemoveOperation", operation: "missing" }]),
      );
      const notSaved = yield* snapshotWhere(() => true);
      yield* copies.edit(workflowId, [{ _tag: "Rename", name: "Again" }]);
      const saved = yield* snapshotWhere(() => true);

      assert.strictEqual(failure._tag, "WorkingCopyDaemonError");
      assert.strictEqual(notSaved._tag === "Some" ? notSaved.value.saveStatus : null, "not-saved");
      assert.strictEqual(saved._tag === "Some" ? saved.value.saveStatus : null, "saved");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails a call whose daemon reply dies or is interrupted, and keeps the queue working", () =>
    Effect.gen(function* () {
      const copies = yield* WorkingCopies;
      const died = yield* Effect.exit(copies.edit(workflowId, [{ _tag: "Rename", name: "Triage" }]));
      const interrupted = yield* Effect.exit(copies.edit(workflowId, [{ _tag: "Rename", name: "Triage" }]));

      assert.deepStrictEqual(
        [died, interrupted].map((exit) => Option.getOrNull(Exit.findErrorOption(exit))?._tag),
        ["WorkingCopyDaemonError", "WorkingCopyDaemonError"],
      );

      const answered = yield* Effect.exit(copies.edit(workflowId, [{ _tag: "Rename", name: "Triage" }]));
      assert.isTrue(Exit.isSuccess(answered));
    }).pipe(
      Effect.provide(
        workingCopiesLayer.pipe(
          Layer.provide(
            Layer.effect(WorkingCopyDaemon)(
              Effect.map(
                Ref.make<ReadonlyArray<Effect.Effect<WorkflowRecord>>>([
                  Effect.die(new Error("encode failed")),
                  Effect.interrupt,
                ]),
                (replies) =>
                  WorkingCopyDaemon.of({
                    edit: () =>
                      Ref.modify(replies, ([next, ...rest]) => [next ?? Effect.succeed(draft), rest]).pipe(
                        Effect.flatten,
                      ),
                    publish: () => Effect.die(new Error("unused")),
                    switchEnabled: () => Effect.die(new Error("unused")),
                    changes: Stream.make(draft),
                  }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("merges an edit from another author, and keeps the highest working revision", () =>
    Effect.gen(function* () {
      const daemon = yield* MemoryDaemon;
      const copies = yield* WorkingCopies;
      const laterWorkflow = { ...draft, id: Schema.decodeUnknownSync(WorkflowId)("workflow-2") };

      yield* daemon.editAsAnotherAuthor(workflowId, [{ _tag: "Rename", name: "Agent name" }]);
      const merged = yield* snapshotWhere(({ accepted }) => accepted.workingRevision === 2);
      yield* daemon.seed(draft);
      yield* daemon.seed(laterWorkflow);
      yield* Stream.runHead(copies.snapshots(laterWorkflow.id));
      const kept = yield* snapshotWhere(() => true);

      assert.strictEqual(
        merged._tag === "Some" ? merged.value.accepted.workingCopy.name : null,
        "Agent name",
      );
      assert.strictEqual(kept._tag === "Some" ? kept.value.accepted.workingRevision : null, 2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes the latest revision after the edits queued before it", () =>
    Effect.gen(function* () {
      const daemon = yield* MemoryDaemon;
      const copies = yield* WorkingCopies;
      yield* daemon.holdReplies;

      const edit = yield* Effect.forkChild(copies.edit(workflowId, [{ _tag: "Rename", name: "Ready" }]));
      yield* snapshotWhere(({ pending }) => pending.length === 1);
      const publish = yield* Effect.forkChild(copies.publish(workflowId));
      yield* daemon.releaseReplies;
      yield* Fiber.await(edit);
      yield* Fiber.await(publish);

      assert.deepStrictEqual(
        (yield* daemon.calls).flatMap((call) => (call._tag === "publish" ? [call.revision] : [])),
        [2],
      );
      assert.strictEqual((yield* daemon.record(workflowId))?.publishedCopy?.name, "Ready");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes a draft before it switches the Workflow on", () =>
    Effect.gen(function* () {
      const daemon = yield* MemoryDaemon;
      const copies = yield* WorkingCopies;

      const switched = yield* Effect.exit(copies.switchEnabled(workflowId, true));

      assert.deepStrictEqual(
        (yield* daemon.calls).map(({ _tag }) => _tag),
        ["publish", "switchEnabled"],
      );
      assert.isTrue(Exit.isSuccess(switched) && switched.value.enabled);
    }).pipe(Effect.provide(testLayer)),
  );
});
