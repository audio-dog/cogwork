import { WorkspaceId, WorkspaceState } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { formatRebindResult, formatRegistrationResult } from "./workspace-commands";

const workspaceId = Schema.decodeSync(WorkspaceId);
const workspaceState = Schema.decodeSync(WorkspaceState);

describe("formatRegistrationResult", () => {
  it("reports the minted identity when repository input fails", () => {
    const name = workspaceId("0198f16a-21d7-7000-8000-000000000001");

    assert.strictEqual(
      formatRegistrationResult("missing input", {
        _tag: "Failed",
        name,
        source: "/repos/missing",
        message: "Workspace input is missing",
      }),
      `Registered missing input as ${name}, but Workspace input failed: Workspace input is missing`,
    );
  });
});

describe("formatRebindResult", () => {
  it("reports the stable identity and new path", () => {
    const name = workspaceId("0198f16a-21d7-7000-8000-000000000001");

    assert.strictEqual(
      formatRebindResult(
        workspaceState({
          _tag: "Registered",
          name,
          displayName: "Cogwork",
          checkoutPath: "/repos/moved",
          issueTracker: "github",
          harness: "codex",
          poll: { status: "pending" },
        }),
      ),
      `Re-bound Cogwork (${name}) to /repos/moved.`,
    );
  });
});
