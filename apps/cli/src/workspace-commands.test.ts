import { WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { formatRegistrationResult } from "./workspace-commands";

const workspaceId = Schema.decodeSync(WorkspaceId);

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
