import { applyDaemonEvent, DaemonEvent, initialBoard } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { attentionEntries, filterAttention } from "./attention";

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
  it("orders pull requests by longest wait", () => {
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
          item: { _tag: "ReadyToMerge", id: "4", title: "Older PR", url: null, pr: pr(5) },
        },
      ]),
    );

    expect(entries.map(({ kind, item }) => [kind, item.id])).toEqual([
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
        workspace: "beta",
        item: { _tag: "ReadyToMerge", id: "2", title: "PR", url: null, pr: pr(10) },
      },
    ]),
  );

  it("treats an empty workspace set as all and filters selected workspaces", () => {
    expect(filterAttention(entries, new Set()).map((entry) => entry.item.id)).toEqual(["2"]);
    expect(filterAttention(entries, new Set(["beta"])).map((entry) => entry.item.id)).toEqual(["2"]);
    expect(filterAttention(entries, new Set(["acme"]))).toEqual([]);
  });
});
