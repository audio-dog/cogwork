import {
  applyDaemonEvent,
  type Board,
  ClassifiedItem,
  DaemonEvent,
  initialBoard,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { boardColumnOf, boardColumns, lanes } from "./board-view";

const decodeItem = Schema.decodeSync(ClassifiedItem);
const decodeEvent = Schema.decodeSync(DaemonEvent);
const decodeWorkspace = Schema.decodeSync(WorkspaceId);

type EventInput = Parameters<typeof decodeEvent>[0];
type ItemInput = Parameters<typeof decodeItem>[0];

const pr = {
  number: 7,
  url: "https://example.test/pr/7",
  checks: "passing" as const,
  review: "pending" as const,
  baseDivergence: "none" as const,
  waitingSinceMillis: 1,
};

const fold = (events: ReadonlyArray<EventInput>): Board =>
  events.reduce((board, event) => applyDaemonEvent(board, decodeEvent(event)), initialBoard);

const registered = (name: string): EventInput => ({
  _tag: "WorkspaceChanged",
  workspace: {
    _tag: "Registered",
    name,
    checkoutPath: `/repos/${name}`,
    issueTracker: "github",
    harness: "cursor",
    poll: { status: "ok" },
  },
});

const changed = (workspace: string, item: ItemInput): EventInput => ({
  _tag: "ItemChanged",
  workspace,
  item,
});

describe("boardColumnOf", () => {
  it("routes an eligible triage item to Needs triage", () => {
    expect(boardColumnOf(decodeItem({ _tag: "Eligible", id: "1", title: "a", stage: "triage" }))).toBe(
      "needs-triage",
    );
  });

  it("routes an eligible implement item to Ready for agent", () => {
    expect(boardColumnOf(decodeItem({ _tag: "Eligible", id: "1", title: "a", stage: "implement" }))).toBe(
      "ready-for-agent",
    );
  });

  it("routes follow-up and verify eligible items to In review", () => {
    expect(boardColumnOf(decodeItem({ _tag: "Eligible", id: "1", title: "a", stage: "follow-up", pr }))).toBe(
      "in-review",
    );
    expect(boardColumnOf(decodeItem({ _tag: "Eligible", id: "2", title: "b", stage: "verify", pr }))).toBe(
      "in-review",
    );
  });

  it("routes a claimed item to Working", () => {
    expect(
      boardColumnOf(
        decodeItem({
          _tag: "Claimed",
          id: "1",
          title: "a",
          claim: { by: "daemon", claimedAtMillis: 0, stage: "implement" },
        }),
      ),
    ).toBe("working");
  });

  it("routes a needs-human item to Needs you and a blocked item to Blocked", () => {
    expect(
      boardColumnOf(
        decodeItem({ _tag: "NeedsHuman", id: "1", title: "a", reason: "needs-info", proposal: null }),
      ),
    ).toBe("needs-you");
    expect(boardColumnOf(decodeItem({ _tag: "Blocked", id: "2", title: "b", openBlockers: 1 }))).toBe(
      "blocked",
    );
  });
});

describe("boardColumns", () => {
  it("groups items into the six ordered columns across workspaces", () => {
    const board = fold([
      changed("acme", { _tag: "Eligible", id: "1", title: "triage me", stage: "triage" }),
      changed("acme", { _tag: "Eligible", id: "2", title: "ready", stage: "implement" }),
      changed("beta", { _tag: "NeedsHuman", id: "3", title: "help", reason: "needs-info", proposal: null }),
    ]);

    const columns = boardColumns(board, null);
    expect(columns.map((c) => c.id)).toEqual([
      "needs-triage",
      "ready-for-agent",
      "working",
      "in-review",
      "needs-you",
      "blocked",
    ]);
    expect(columns.find((c) => c.id === "needs-triage")?.items).toHaveLength(1);
    expect(columns.find((c) => c.id === "ready-for-agent")?.items).toHaveLength(1);
    expect(columns.find((c) => c.id === "needs-you")?.items).toHaveLength(1);
  });

  it("honors the workspace filter", () => {
    const board = fold([
      changed("acme", { _tag: "Eligible", id: "1", title: "triage me", stage: "triage" }),
      changed("beta", { _tag: "Eligible", id: "2", title: "other", stage: "triage" }),
    ]);

    const filtered = boardColumns(board, decodeWorkspace("acme"));
    expect(filtered.find((c) => c.id === "needs-triage")?.items).toHaveLength(1);
  });
});

describe("lanes", () => {
  it("builds one lane per workspace with per-column counts and running total", () => {
    const board = fold([
      registered("acme"),
      registered("beta"),
      changed("acme", { _tag: "Eligible", id: "1", title: "a", stage: "triage" }),
      changed("acme", { _tag: "Blocked", id: "2", title: "b", openBlockers: 2 }),
      {
        _tag: "RunChanged",
        run: {
          id: "run-1",
          workspace: "acme",
          workItem: "1",
          stage: "implement",
          harness: "cursor",
          branch: null,
          session: null,
          usage: null,
          status: "running",
          startedAtMillis: 0,
          endedAtMillis: null,
          eventCount: 0,
        },
      },
    ]);

    const result = lanes(board);
    expect(result.map((lane) => lane.key)).toEqual(["acme", "beta"]);
    const acme = result[0];
    expect(acme.total).toBe(2);
    expect(acme.running).toBe(1);
    expect(acme.columns.find((c) => c.id === "needs-triage")?.count).toBe(1);
    expect(acme.columns.find((c) => c.id === "blocked")?.count).toBe(1);
    expect(acme.columns.find((c) => c.id === "needs-triage")?.items).toHaveLength(1);
    expect(result[1].total).toBe(0);
  });
});
