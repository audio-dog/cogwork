import { WorkItemId, WorkItemRef, WorkspaceId } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { notificationChanges } from "./desktop-notifications";

const workItemId = Schema.decodeSync(WorkItemId);
const workspaceId = Schema.decodeSync(WorkspaceId);

const park = (id: string, summary = "Review the parked item") => ({
  item: WorkItemRef.cases.Issue.make({ workspace: workspaceId("acme"), id: workItemId(id) }),
  summary,
});

describe("desktop notification requests", () => {
  it("requests each new park once and dismisses it when it leaves the read model", () => {
    const first = notificationChanges(new Set(), [park("#818")]);
    const unchanged = notificationChanges(first.next, [park("#818")]);
    const removed = notificationChanges(unchanged.next, []);

    expect(first.current).toEqual([
      {
        id: "issue:acme:%23818",
        focus: "issue:acme:%23818",
        title: "Cogwork needs you",
        body: "issue:acme:%23818: Review the parked item",
      },
    ]);
    expect(first.changed).toBe(true);
    expect(unchanged.changed).toBe(false);
    expect(removed.changed).toBe(true);
  });

  it("keeps separate parks separate", () => {
    const changes = notificationChanges(new Set(), [park("#818"), park("#819")]);

    expect(changes.current.map(({ id }) => id)).toEqual(["issue:acme:%23818", "issue:acme:%23819"]);
  });

  it("projects long work item keys into bounded notification ids", () => {
    const focus = `issue:acme:${"8".repeat(100)}`;
    const changes = notificationChanges(new Set(), [park("8".repeat(100))]);

    expect(changes.current[0]?.id.length).toBeLessThanOrEqual(64);
    expect(changes.current[0]?.focus).toBe(focus);
  });
});
