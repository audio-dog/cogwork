import { ClassifiedItem, RunSummary } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { describeItemState, previousAttempts, resolveSubTab, selectedRunForItem, subTabs } from "./item-tab";

const classifiedItem = Schema.decodeSync(ClassifiedItem);
const runSummary = Schema.decodeSync(RunSummary);

const run = (over: Partial<Parameters<typeof runSummary>[0]> = {}) =>
  runSummary({
    id: "run-1",
    workspace: "acme",
    workItem: "42",
    stage: "implement",
    harness: "cursor",
    branch: null,
    session: null,
    usage: null,
    status: "succeeded",
    startedAtMillis: 100,
    endedAtMillis: 200,
    eventCount: 0,
    ...over,
  });

const readyPr = {
  number: 7,
  url: "https://example.test/pr/7",
  checks: "passing" as const,
  review: "ready" as const,
  baseDivergence: "none" as const,
  waitingSinceMillis: 0,
};

describe("describeItemState", () => {
  it("reads Running · stage when a live run is going, whatever the tag", () => {
    const item = classifiedItem({ _tag: "Blocked", id: "42", title: "t", url: null, openBlockers: 3 });
    const state = describeItemState(item, run({ status: "running", stage: "follow-up" }));
    expect(state).toEqual({ label: "Running · follow-up", tone: "live", running: true });
  });

  it("names a decision for a NeedsHuman item, carrying the reason", () => {
    const item = classifiedItem({
      _tag: "NeedsHuman",
      id: "42",
      title: "t",
      reason: "needs-info",
      proposal: null,
      url: null,
    });
    expect(describeItemState(item, null)).toEqual({
      label: "Needs a decision · needs-info",
      tone: "attention",
      running: false,
    });
  });

  it("counts open blockers, pluralized", () => {
    const one = classifiedItem({ _tag: "Blocked", id: "1", title: "t", url: null, openBlockers: 1 });
    const many = classifiedItem({ _tag: "Blocked", id: "2", title: "t", url: null, openBlockers: 2 });
    expect(describeItemState(one, null).label).toBe("Blocked · 1 open blocker");
    expect(describeItemState(many, null).label).toBe("Blocked · 2 open blockers");
    expect(describeItemState(one, null).tone).toBe("muted");
  });

  it("reads Ready to merge from the classification", () => {
    const item = classifiedItem({
      _tag: "ReadyToMerge",
      id: "42",
      title: "t",
      url: null,
      pr: readyPr,
    });
    expect(describeItemState(item, null)).toEqual({
      label: "Ready to merge",
      tone: "ready",
      running: false,
    });
  });

  it("falls back to a calm queued/working chip for eligible and claimed items", () => {
    const eligible = classifiedItem({ _tag: "Eligible", id: "42", title: "t", url: null, stage: "triage" });
    expect(describeItemState(eligible, null)).toEqual({
      label: "Queued · triage",
      tone: "muted",
      running: false,
    });
    const claimed = classifiedItem({
      _tag: "Claimed",
      id: "42",
      title: "t",
      url: null,
      claim: {
        by: "agent",
        claimedAtMillis: 0,
        operation: { workflow: "coding", operation: "implement" },
        lineage: { root: "run-1", parent: null, hop: 0 },
      },
      pr: readyPr,
    });
    expect(describeItemState(claimed, null).label).toBe("Working · implement");
  });
});

describe("subTabs / resolveSubTab", () => {
  it("always offers Main and Live run, and adds Pull request only with a PR", () => {
    expect(subTabs(false).map((tab) => tab.key)).toEqual(["main", "run"]);
    expect(subTabs(true).map((tab) => tab.key)).toEqual(["main", "run", "pr"]);
  });

  it("keeps a still-present sub-tab and falls back to Main when it disappears", () => {
    expect(resolveSubTab("pr", subTabs(true))).toBe("pr");
    expect(resolveSubTab("pr", subTabs(false))).toBe("main");
    expect(resolveSubTab("run", subTabs(false))).toBe("run");
  });
});

describe("previousAttempts", () => {
  it("drops the focal run and sorts the rest newest first", () => {
    const focal = run({ id: "focal", startedAtMillis: 500 });
    const older = run({ id: "older", startedAtMillis: 100 });
    const newer = run({ id: "newer", startedAtMillis: 300 });
    const attempts = previousAttempts([older, focal, newer], focal.id);
    expect(attempts.map((attempt) => attempt.id)).toEqual(["newer", "older"]);
  });

  it("returns everything, newest first, when there is no focal run", () => {
    const a = run({ id: "a", startedAtMillis: 100 });
    const b = run({ id: "b", startedAtMillis: 200 });
    expect(previousAttempts([a, b], null).map((attempt) => attempt.id)).toEqual(["b", "a"]);
  });
});

describe("selectedRunForItem", () => {
  it("rejects a requested run from another item", () => {
    const selected = run({ workItem: "99" });
    const item = run();
    expect(selectedRunForItem(selected, item.workspace, item.workItem)).toBeNull();
  });

  it("keeps a requested run for the item", () => {
    const selected = run();
    expect(selectedRunForItem(selected, selected.workspace, selected.workItem)?.id).toBe("run-1");
  });
});
