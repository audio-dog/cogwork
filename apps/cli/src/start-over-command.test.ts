import { WorkItemId, type WorkItemRef, WorkspaceId } from "@cogwork/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestConsole } from "effect/testing";
import { cli } from "./cli";
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
        ({ item }) => Ref.update(sent, (items) => [...items, item]),
      );

      assert.deepStrictEqual(yield* Ref.get(sent), []);
      assert.deepStrictEqual(yield* TestConsole.logLines, ["Start over cancelled."]);
    }),
  );

  it.effect("sends the item after the person confirms", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<WorkItemRef>>([]);
      const questions = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* startOver(
        { workspace: "cogwork", item: "#1048", yes: false },
        (question) => Ref.update(questions, (asked) => [...asked, question]).pipe(Effect.map(() => true)),
        ({ item }) => Ref.update(sent, (items) => [...items, item]),
      );

      assert.lengthOf(yield* Ref.get(questions), 1);
      assert.deepStrictEqual(yield* Ref.get(sent), [issue]);
    }),
  );

  it.effect("skips the question with --yes", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<WorkItemRef>>([]);
      const questions = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* startOver(
        { workspace: "cogwork", item: "#1048", yes: true },
        (question) => Ref.update(questions, (asked) => [...asked, question]).pipe(Effect.map(() => true)),
        ({ item }) => Ref.update(sent, (items) => [...items, item]),
      );

      assert.deepStrictEqual(yield* Ref.get(questions), []);
      assert.deepStrictEqual(yield* Ref.get(sent), [issue]);
    }),
  );

  it.effect("appears in root help", () =>
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "0.0.1" })(["--help"]).pipe(
        Effect.provide(
          Layer.mergeAll(
            FetchHttpClient.layer,
            NodeServices.layer,
            NodeCrypto.layerSecureRandom,
            NodeCrypto.layerDigest,
          ),
        ),
      );

      assert.include((yield* TestConsole.logLines).join("\n"), "start-over");
    }),
  );
});
