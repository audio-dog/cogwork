import { applyDaemonEvent, DaemonEvent, initialBoard } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { attentionCounts, attentionEntries, filterAttention } from "./attention";

const decodeDaemonEvent = Schema.decodeUnknownSync(DaemonEvent);
const daemonEvent = (value: Record<string, unknown>) => decodeDaemonEvent({ ...value, emittedAtMillis: 0 });

const pr = (waitingSinceMillis: number) => ({
  number: 7,
  url: "https://example.test/pr/7",
  checks: "passing" as const,
  review: "ready" as const,
  baseDivergence: "none" as const,
  waitingSinceMillis,
});

const board = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => daemonEvent(event)).reduce(applyDaemonEvent, initialBoard);

describe("attentionEntries", () => {
  it("reads classifications, orders decisions first, and orders PRs by longest wait", () => {
    const entries = attentionEntries(
      board([
        {
          _tag: "ItemChanged",
          workspace: "acme",
          item: { _tag: "ReadyToMerge", id: "3", title: "Newer PR", url: null, pr: pr(40) },
        },
        {
          _tag: "ItemChanged",
          workspace: "acme",
          item: {
            _tag: "NeedsHuman",
            id: "1",
            title: "Decision",
            reason: "needs-info",
            proposal: null,
            url: "https://example.test/issues/1",
          },
        },
        {
          _tag: "ItemChanged",
          workspace: "beta",
          item: {
            _tag: "NeedsHuman",
            id: "2",
            title: "Merge-ready decision",
            reason: "ready-for-human",
            proposal: null,
            url: "https://example.test/issues/2",
            pr: pr(10),
          },
        },
        {
          _tag: "ItemChanged",
          workspace: "acme",
          item: { _tag: "ReadyToMerge", id: "4", title: "Older PR", url: null, pr: pr(5) },
        },
        {
          _tag: "ItemChanged",
          workspace: "acme",
          item: {
            _tag: "Claimed",
            id: "5",
            title: "In flight",
            url: null,
            claim: {
              by: "cogwork",
              claimedAtMillis: 0,
              operation: { workflow: "coding", operation: "implement" },
              lineage: { root: "run-1", parent: null, hop: 0 },
            },
            pr: pr(1),
          },
        },
      ]),
    );

    expect(entries.map(({ kind, item }) => [kind, item.id])).toEqual([
      ["needs-decision", "1"],
      ["needs-decision", "2"],
      ["ready-to-merge", "4"],
      ["ready-to-merge", "3"],
    ]);
  });
});

describe("filterAttention", () => {
  const entries = attentionEntries(
    board([
      {
        _tag: "ItemChanged",
        workspace: "acme",
        item: {
          _tag: "NeedsHuman",
          id: "1",
          title: "Decision",
          reason: "needs-info",
          proposal: null,
          url: null,
        },
      },
      {
        _tag: "ItemChanged",
        workspace: "beta",
        item: { _tag: "ReadyToMerge", id: "2", title: "PR", url: null, pr: pr(10) },
      },
    ]),
  );

  it("treats an empty workspace set as all and combines workspace with the active kind", () => {
    expect(filterAttention(entries, "all", new Set()).map((entry) => entry.item.id)).toEqual(["1", "2"]);
    expect(
      filterAttention(entries, "ready-to-merge", new Set(["beta"])).map((entry) => entry.item.id),
    ).toEqual(["2"]);
  });

  it("counts each kind from the full, unfiltered list", () => {
    expect(attentionCounts(entries)).toEqual({ all: 2, "needs-decision": 1, "ready-to-merge": 1 });
  });
});
