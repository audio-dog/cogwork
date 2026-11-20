import { WorkspaceConfig, WorkspaceId } from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { schedulerStatsOf } from "./read-model";

const registered = Schema.decodeSync(WorkspaceId)("01a1a28e-b763-7ccb-9208-2b284d962dae");
const failed = Schema.decodeSync(WorkspaceId)("01a1ebe3-0000-7000-8000-000000000000");

it("names each workspace's scheduler load with its display name", () => {
  const stats = schedulerStatsOf(
    {
      workspaces: [
        {
          source: "test",
          contributions: [],
          config: Schema.decodeSync(WorkspaceConfig)({
            id: registered,
            displayName: "cogwork",
            checkoutPath: "/repos/cogwork",
            issueTracker: { type: "github" },
          }),
        },
      ],
      failures: [{ id: failed, displayName: "web", source: "test", message: "checkout missing" }],
    },
    { globalLimit: 4, perWorkspaceLimit: 2, dailyBudget: 10 },
    {
      global: 1,
      perWorkspace: new Map([[registered, 1]]),
      inflight: new Set(),
      acted: new Set(),
      budgetDay: 0,
      budgetUsed: 0,
      stopping: false,
      paused: false,
    },
  );

  assert.deepStrictEqual(
    stats.perWorkspace.map(({ id, displayName }) => [id, displayName]),
    [
      [registered, "cogwork"],
      [failed, "web"],
    ],
  );
});
