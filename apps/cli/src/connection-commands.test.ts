import { WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { formatConnectionMutation } from "./connection-commands";

describe("Connection commands", () => {
  it("names dangling workspaces after removal", () => {
    const workspaceId = Schema.decodeSync(WorkspaceId);
    assert.strictEqual(
      formatConnectionMutation("Removed", {
        overview: { connections: [] },
        danglingWorkspaces: [workspaceId("alpha"), workspaceId("beta")],
      }),
      "Removed Connection.\nWarning: Workspaces left dangling: alpha, beta.",
    );
  });
});
