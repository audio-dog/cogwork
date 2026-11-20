import { initialBoard, type SchedulerStats } from "@cogwork/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivitySessionContext, initialActivitySession } from "../features/activity-session";
import { PausedBanner } from "./scheduler-gauges";

const stats = (scheduling: SchedulerStats["scheduling"]): SchedulerStats => ({
  scheduling,
  globalInFlight: 1,
  globalLimit: 4,
  perWorkspaceLimit: 2,
  dailyBudgetUsed: 3,
  dailyBudgetLimit: 10,
  perWorkspace: [],
});

const sessionWith = (scheduling: SchedulerStats["scheduling"]) => ({
  ...initialActivitySession,
  connection: "live" as const,
  board: { ...initialBoard, scheduler: stats(scheduling) },
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
