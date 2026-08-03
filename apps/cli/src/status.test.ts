import type { DaemonStatus, WorkspaceInfo } from "@clanker-forge/contracts";
import { HarnessName, WorkItemId, WorkSourceType, WorkspaceId } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { formatStatus } from "./status";

const workItemId = Schema.decodeSync(WorkItemId);
const workspaceId = Schema.decodeSync(WorkspaceId);
const harnessName = Schema.decodeSync(HarnessName);
const workSourceType = Schema.decodeSync(WorkSourceType);

const workspace = (over: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  name: workspaceId("forge"),
  checkoutPath: "/tmp/forge",
  workSource: workSourceType("github"),
  harness: harnessName("cursor"),
  poll: { status: "ok" },
  eligible: [],
  claimed: [],
  blocked: [],
  needsHuman: [],
  ...over,
});

const status = (over: Partial<DaemonStatus> = {}): DaemonStatus => ({
  health: "running",
  startedAtMillis: 0,
  uptimeMillis: 1000,
  scheduler: {
    globalInFlight: 0,
    globalLimit: 4,
    dailyBudgetUsed: 0,
    dailyBudgetLimit: 50,
    perWorkspace: [],
  },
  workspaces: [workspace()],
  failures: [],
  ...over,
});

describe("formatStatus", () => {
  it("renders a needs-human section with each item's reason", () => {
    const output = formatStatus(
      status({
        workspaces: [
          workspace({
            needsHuman: [
              { id: workItemId("#3"), title: "waiting on details", reason: "needs-info" },
              { id: workItemId("#9"), title: "keeps failing", reason: "ready-for-human" },
            ],
          }),
        ],
      }),
    );
    assert.include(output, "      needs-human:");
    assert.include(output, "        · needs-info #3 waiting on details");
    assert.include(output, "        · ready-for-human #9 keeps failing");
  });

  it("renders a blocked section with each item's open-blocker count", () => {
    const output = formatStatus(
      status({
        workspaces: [
          workspace({
            blocked: [
              { id: workItemId("#4"), title: "waiting on one", openBlockers: 1 },
              { id: workItemId("#5"), title: "waiting on two", openBlockers: 2 },
            ],
          }),
        ],
      }),
    );
    assert.include(output, "      blocked:");
    assert.include(output, "        · #4 waiting on one (1 open blocker)");
    assert.include(output, "        · #5 waiting on two (2 open blockers)");
  });

  it("omits the blocked section when nothing has an open blocker", () => {
    assert.notInclude(formatStatus(status()), "      blocked:");
  });

  it("omits the needs-human section when nothing is waiting on a human", () => {
    const output = formatStatus(status());
    assert.include(output, "  - forge [github/cursor] /tmp/forge");
    assert.notInclude(output, "needs-human");
  });

  it("renders eligible and claimed sections alongside the workspace header", () => {
    const output = formatStatus(
      status({
        workspaces: [
          workspace({
            eligible: [{ id: workItemId("#1"), title: "implement me", stage: "implement" }],
            claimed: [
              {
                id: workItemId("#2"),
                title: "in flight",
                claim: { by: "clanker-forge", claimedAtMillis: 10 },
              },
            ],
          }),
        ],
      }),
    );
    assert.include(output, "        · implement #1 implement me");
    assert.include(output, "        · #2 in flight (by clanker-forge)");
  });

  it("reports a paused poll, scheduler load, and workspace load failures", () => {
    const output = formatStatus(
      status({
        scheduler: {
          globalInFlight: 1,
          globalLimit: 4,
          dailyBudgetUsed: 7,
          dailyBudgetLimit: 50,
          perWorkspace: [{ name: workspaceId("forge"), inFlight: 1 }],
        },
        workspaces: [
          workspace({
            poll: { status: "paused", reason: "auth", message: "auth failed", retryAtMillis: null },
          }),
        ],
        failures: [{ source: "broken.workspace.ts", message: "boom" }],
      }),
    );
    assert.include(output, "scheduler: 1/4 in-flight · budget 7/50 (forge=1)");
    assert.include(output, "      paused: auth (needs attention) — auth failed");
    assert.include(output, "  ! broken.workspace.ts: boom");
  });

  it("renders a rate-limited pause as self-healing with the retry-at instant", () => {
    const output = formatStatus(
      status({
        workspaces: [
          workspace({
            poll: {
              status: "paused",
              reason: "rate-limited",
              message: "Linear rate limit active",
              retryAtMillis: 1_785_800_000_000,
            },
          }),
        ],
      }),
    );
    assert.include(output, "      paused: rate-limited (self-healing, retrying after 2026-08-03T");
    assert.notInclude(output, "needs attention");
  });

  it("says so when no workspaces are registered", () => {
    assert.include(formatStatus(status({ workspaces: [] })), "  (no workspaces registered)");
  });
});
