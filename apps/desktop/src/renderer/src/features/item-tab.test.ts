import { type BoardItem, RunSummary, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { describeItemState, itemTabSubject, subTabsFor } from "./item-tab";

const workItem = Schema.decodeSync(WorkItemId)("issue:acme:%237");

const run = (status: RunSummary["status"]) =>
  Schema.decodeSync(RunSummary)({
    id: "run-1",
    workspace: "acme",
    workItem,
    operation: "triage",
    harness: "codex",
    branch: null,
    session: null,
    usage: null,
    status,
    startedAtMillis: 1,
    endedAtMillis: null,
    eventCount: 0,
    eventsPrunedAtMillis: null,
  });

const readyEntry: BoardItem = {
  workspace: Schema.decodeSync(WorkspaceId)("acme"),
  item: {
    _tag: "ReadyToMerge",
    id: Schema.decodeSync(WorkItemId)("#7"),
    title: "Fix login",
    url: "https://github.com/acme/web/pull/9",
    pr: {
      number: 9,
      url: "https://github.com/acme/web/pull/9",
      checks: "passing",
      review: "ready",
      baseDivergence: "clean",
      waitingSinceMillis: 1,
    },
  },
};

const operationNames = (operation: string) => (operation === "triage" ? "Triage" : operation);

describe("item tab subject", () => {
  it("opens a Run-only item by its number, its Run's title, and a link to the issue", () => {
    const subject = itemTabSubject(null, workItem, {
      title: "Remove the instruction package",
      url: "https://github.com/acme/web/issues/7",
    });
    expect(subject).toStrictEqual({
      id: workItem,
      label: "#7",
      title: "Remove the instruction package",
      url: "https://github.com/acme/web/issues/7",
      pr: null,
    });
    expect(subTabsFor(subject).map(({ key }) => key)).toStrictEqual(["main", "run"]);
  });

  it("uses the item number as the title when no Run carries a subject", () => {
    expect(itemTabSubject(null, workItem, null)).toMatchObject({ label: "#7", title: "#7", url: null });
  });

  it("labels a settled Run-only item by its Run status and a board item as ready to merge", () => {
    const runOnly = itemTabSubject(null, workItem, null);
    const ready = itemTabSubject(readyEntry, readyEntry.item.id, null);
    expect(describeItemState(run("crashed"), runOnly, operationNames).label).toBe("Crashed");
    expect(describeItemState(null, ready, operationNames).label).toBe("Ready to merge");
    expect(describeItemState(run("running"), ready, operationNames)).toStrictEqual({
      label: "Running · Triage",
      tone: "live",
      running: true,
    });
  });
});
