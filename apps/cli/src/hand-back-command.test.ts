import { ClassifiedItem, WorkItemId, WorkItemNotFound, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { handBackCommand, handBackItem } from "./hand-back-command";

const workspaceId = Schema.decodeSync(WorkspaceId);
const workItemId = Schema.decodeSync(WorkItemId);
const classifiedItem = Schema.decodeSync(ClassifiedItem);

const eligible = classifiedItem({
  _tag: "Eligible",
  id: "284",
  title: "Hand back from the CLI",
  stage: "implement",
});

describe("hand-back command", () => {
  it.effect("sends the named item, role, and note and reports its new classification", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const output = yield* handBackItem(
        {
          workspace: "cogwork",
          item: "284",
          role: "ready-for-agent",
          note: "worktree setup repaired",
        },
        (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(Effect.map(() => eligible)),
      );

      assert.deepStrictEqual(yield* Ref.get(requests), [
        {
          workspace: workspaceId("cogwork"),
          workItem: workItemId("284"),
          role: "ready-for-agent",
          note: "worktree setup repaired",
        },
      ]);
      assert.strictEqual(output, "Handed back implement 284 Hand back from the CLI");
    }),
  );

  it.effect("omits the note when none is given", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<unknown>>([]);
      yield* handBackItem({ workspace: "cogwork", item: "284", role: "ready-for-agent" }, (request) =>
        Ref.update(requests, (current) => [...current, request]).pipe(Effect.map(() => eligible)),
      );

      assert.deepStrictEqual(yield* Ref.get(requests), [
        {
          workspace: workspaceId("cogwork"),
          workItem: workItemId("284"),
          role: "ready-for-agent",
        },
      ]);
    }),
  );

  it.effect("turns an unknown workspace or item into a clear CLI error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        handBackItem(
          { workspace: "missing-workspace", item: "missing-item", role: "ready-for-agent" },
          (request) =>
            Effect.fail(
              new WorkItemNotFound({
                workspace: request.workspace,
                workItem: request.workItem,
              }),
            ),
        ),
      );

      assert.strictEqual(error._tag, "UserError");
      assert.strictEqual(
        error.message,
        'No parked work item "missing-item" was found in workspace "missing-workspace".',
      );
    }),
  );

  it("is available as a root command", () => {
    assert.isDefined(handBackCommand);
  });
});
