import { WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RegisteredWorkspace } from "./projector";
import { emptyLayer, SourceControlProvider } from "./source-control";

const workspace: RegisteredWorkspace = {
  source: "linear.workspace.ts",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "linear",
    checkoutPath: "/repos/linear",
    issueTracker: { type: "linear" },
  }),
};

describe("SourceControlProvider.emptyLayer", () => {
  it.effect("refuses pull request creation permanently", () =>
    Effect.gen(function* () {
      const provider = yield* SourceControlProvider;
      const error = yield* Effect.flip(
        provider.openPullRequest(workspace, {
          headBranch: "474-ready",
          baseBranch: "main",
          title: "Open pull requests from the engine",
          body: "Closes #474",
        }),
      );

      assert.strictEqual(error.reason, "unavailable");
      assert.isFalse(error.retryable);
    }).pipe(Effect.provide(emptyLayer)),
  );
});
