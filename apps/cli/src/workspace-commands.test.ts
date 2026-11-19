import { WorkspaceId, WorkspaceState } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  decodeWorkspaceUpdateJson,
  formatRebindResult,
  formatRegistrationResult,
  formatUpdateResult,
} from "./workspace-commands";

const workspaceId = Schema.decodeSync(WorkspaceId);
const workspaceState = Schema.decodeSync(WorkspaceState);

describe("formatRegistrationResult", () => {
  it("reports the minted identity when repository input fails", () => {
    const id = workspaceId("0198f16a-21d7-7000-8000-000000000001");

    assert.strictEqual(
      formatRegistrationResult("missing input", {
        _tag: "Failed",
        id,
        source: "/repos/missing",
        message: "Workspace input is missing",
      }),
      `Registered missing input as ${id}, but Workspace input failed: Workspace input is missing`,
    );
  });
});

describe("formatRebindResult", () => {
  it("reports the stable identity and new path", () => {
    const id = workspaceId("0198f16a-21d7-7000-8000-000000000001");

    assert.strictEqual(
      formatRebindResult(
        workspaceState({
          _tag: "Registered",
          id,
          displayName: "Cogwork",
          checkoutPath: "/repos/moved",
          issueTracker: "github",
          record: {
            displayName: "Cogwork",
            checkoutPath: "/repos/moved",
            issueTracker: { type: "github" },
            linearHistory: false,
          },
          contributions: [],
        }),
      ),
      `Re-bound Cogwork (${id}) to /repos/moved.`,
    );
  });
});

describe("formatUpdateResult", () => {
  it.effect("schema-decodes the JSON update input", () =>
    Effect.gen(function* () {
      const update = yield* decodeWorkspaceUpdateJson(
        '{"displayName":"Cogwork","issueTracker":{"type":"github","connectionId":"github/acme"},"linearHistory":false,"concurrency":3}',
      );

      assert.strictEqual(update.displayName, "Cogwork");
      assert.strictEqual(update.concurrency, 3);
    }),
  );

  it("reports the edited workspace name", () => {
    const id = workspaceId("0198f16a-21d7-7000-8000-000000000001");

    assert.strictEqual(
      formatUpdateResult(
        workspaceState({
          _tag: "Registered",
          id,
          displayName: "Cogwork",
          checkoutPath: "/repos/cogwork",
          issueTracker: "github",
          record: {
            displayName: "Cogwork",
            checkoutPath: "/repos/cogwork",
            issueTracker: { type: "github" },
            linearHistory: false,
          },
          contributions: [],
        }),
      ),
      "Updated Cogwork.",
    );
  });
});
