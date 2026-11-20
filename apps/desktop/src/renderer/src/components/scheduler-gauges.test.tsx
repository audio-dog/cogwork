import { initialBoard, type SchedulerStats, WorkspaceId } from "@cogwork/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivitySessionContext, initialActivitySession } from "../features/activity-session";
import { PausedBanner, SchedulerControls } from "./scheduler-gauges";

const workspaceId = "01a1a28e-b763-7ccb-9208-2b284d962dae";

const stats = (
  scheduling: SchedulerStats["scheduling"],
  perWorkspace: SchedulerStats["perWorkspace"] = [],
): SchedulerStats => ({
  scheduling,
  globalInFlight: 1,
  globalLimit: 4,
  perWorkspaceLimit: 2,
  dailyBudgetUsed: 3,
  dailyBudgetLimit: 10,
  perWorkspace,
});

const sessionWith = (
  scheduling: SchedulerStats["scheduling"],
  perWorkspace: SchedulerStats["perWorkspace"] = [],
) => ({
  ...initialActivitySession,
  connection: "live" as const,
  board: { ...initialBoard, scheduler: stats(scheduling, perWorkspace) },
});

describe("SchedulerControls", () => {
  it("names a busy workspace by its display name, not its id", () => {
    const markup = renderToStaticMarkup(
      <ActivitySessionContext
        value={sessionWith("running", [
          { id: WorkspaceId.make(workspaceId), displayName: "cogwork", inFlight: 4, limit: 4 },
        ])}
      >
        <SchedulerControls />
      </ActivitySessionContext>,
    );

    expect(markup).toContain("cogwork · 4 / 4");
    expect(markup).not.toContain(workspaceId);
  });
});

describe("PausedBanner", () => {
  it("renders the paused notice from a supplied session", () => {
    const markup = renderToStaticMarkup(
      <ActivitySessionContext value={sessionWith("paused")}>
        <PausedBanner />
      </ActivitySessionContext>,
    );

    expect(markup).toContain("Scheduling is paused");
  });

  it("renders nothing while scheduling is live", () => {
    const markup = renderToStaticMarkup(
      <ActivitySessionContext value={sessionWith("running")}>
        <PausedBanner />
      </ActivitySessionContext>,
    );

    expect(markup).toBe("");
  });

  it("renders nothing before the session connects", () => {
    const markup = renderToStaticMarkup(
      <ActivitySessionContext value={initialActivitySession}>
        <PausedBanner />
      </ActivitySessionContext>,
    );

    expect(markup).toBe("");
  });
});
