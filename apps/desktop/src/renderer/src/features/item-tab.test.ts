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

describe("item tab subject", () => {
  it("opens an item that has Runs but no board entry, with no pull request tab", () => {
    const subject = itemTabSubject(null, workItem);
    expect(subject).toStrictEqual({ id: workItem, title: workItem, url: null, pr: null });
    expect(subTabsFor(subject).map(({ key }) => key)).toStrictEqual(["main", "run"]);
  });

  it("labels a settled Run-only item by its Run status and a board item as ready to merge", () => {
    const runOnly = itemTabSubject(null, workItem);
    const ready = itemTabSubject(readyEntry, readyEntry.item.id);
    expect(describeItemState(run("crashed"), runOnly).label).toBe("Crashed");
    expect(describeItemState(null, ready).label).toBe("Ready to merge");
    expect(describeItemState(run("running"), ready)).toStrictEqual({
      label: "Running · triage",
      tone: "live",
      running: true,
    });
  });
});
