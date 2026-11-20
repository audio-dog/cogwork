import { WorkItemId, type WorkItemRef, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { TestConsole } from "effect/testing";

import { startOver } from "./start-over-command";

const issue: WorkItemRef = {
  _tag: "Issue",
  workspace: WorkspaceId.make("cogwork"),
  id: WorkItemId.make("#1048"),
};

describe("start-over command", () => {
  it.effect("sends nothing when the person declines", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<WorkItemRef>>([]);

      yield* startOver(
        { workspace: "cogwork", item: "#1048", yes: false },
        () => Effect.succeed(false),
        (item) => Ref.update(sent, (items) => [...items, item]),
      );

      assert.deepStrictEqual(yield* Ref.get(sent), []);
      assert.deepStrictEqual(yield* TestConsole.logLines, ["Start over cancelled."]);
    }),
  );

  it.effect.each([
    { yes: false, questions: 1 },
    { yes: true, questions: 0 },
  ])("asks $questions times with yes=$yes, then sends the item", ({ yes, questions }) =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<WorkItemRef>>([]);
      const asked = yield* Ref.make(0);

      yield* startOver(
        { workspace: "cogwork", item: "#1048", yes },
        () => Ref.update(asked, (count) => count + 1).pipe(Effect.map(() => true)),
        (item) => Ref.update(sent, (items) => [...items, item]),
      );

      assert.strictEqual(yield* Ref.get(asked), questions);
      assert.deepStrictEqual(yield* Ref.get(sent), [issue]);
    }),
  );
});
