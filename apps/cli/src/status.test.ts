import { WorkspaceId } from "@cogwork/contracts";
import { describe, expect, it } from "vitest";
import { formatScheduler } from "./status";

describe("formatScheduler", () => {
  it("names each busy workspace by its display name", () => {
    const line = formatScheduler({
      scheduling: "running",
      globalInFlight: 4,
      globalLimit: 4,
      perWorkspaceLimit: 4,
      dailyBudgetUsed: 4,
      dailyBudgetLimit: 50,
      perWorkspace: [
        {
          id: WorkspaceId.make("01a1a28e-b763-7ccb-9208-2b284d962dae"),
          displayName: "cogwork",
          inFlight: 4,
          limit: 4,
        },
      ],
    });

    expect(line).toBe("scheduler: 4/4 in-flight · budget 4/50 (cogwork=4/4)");
  });
});
